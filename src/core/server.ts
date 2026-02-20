/**
 * Server orchestrator — the composition root for Carapace.
 *
 * Wires all subsystems together and manages the full server lifecycle:
 *   boot: bind sockets → load plugins → start router → report ready
 *   stop: drain requests → stop router → close sockets → clean up
 *
 * Accepts a SocketFactory via dependency injection so unit tests can
 * use FakeSocketFactory without touching real ZeroMQ.
 *
 * @see docs/ARCHITECTURE.md for the full system design
 */

import type { SocketFactory } from '../types/socket.js';
import type { WireMessage } from '../types/protocol.js';
import { SocketProvisioner } from './socket-provisioner.js';
import type { SocketFs } from './socket-provisioner.js';
import { RequestChannel } from './request-channel.js';
import { EventBus } from './event-bus.js';
import { ToolCatalog } from './tool-catalog.js';
import { PluginLoader } from './plugin-loader.js';
import { SessionManager } from './session-manager.js';
import { ResponseSanitizer } from './response-sanitizer.js';
import { MessageRouter } from './router.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the Server. */
export interface ServerConfig {
  /** Directory for ZMQ Unix domain socket files. */
  socketDir: string;
  /** User plugins directory. */
  pluginsDir: string;
  /** Built-in plugins directory (optional). */
  builtinPluginsDir?: string;
}

/** Injectable dependencies for the Server. */
export interface ServerDeps {
  /** Socket factory — ZmqSocketFactory in production, FakeSocketFactory in tests. */
  socketFactory: SocketFactory;
  /** Filesystem abstraction for SocketProvisioner. */
  fs?: SocketFs;
  /** Output callback for status messages (e.g. "Server ready"). */
  output?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Internal session ID used by the server's own socket provisioning. */
const SERVER_SESSION_ID = 'server';

export class Server {
  private readonly config: ServerConfig;
  private readonly socketFactory: SocketFactory;
  private readonly output: (msg: string) => void;

  // Subsystems — created during start()
  private provisioner: SocketProvisioner | null = null;
  private requestChannel: RequestChannel | null = null;
  private eventBus: EventBus | null = null;
  private pluginLoader: PluginLoader | null = null;
  private router: MessageRouter | null = null;
  private started = false;

  // Exposed for orchestrator chain inspection (e.g. by downstream tasks)
  public sessionManager: SessionManager | null = null;
  public toolCatalog: ToolCatalog | null = null;
  public responseSanitizer: ResponseSanitizer | null = null;

  constructor(config: ServerConfig, deps: ServerDeps) {
    this.config = config;
    this.socketFactory = deps.socketFactory;
    this.output = deps.output ?? (() => {});

    // If a custom FS is provided, store it for provisioner creation
    this.provisionerFs = deps.fs;
  }

  private readonly provisionerFs: SocketFs | undefined;

  /**
   * Boot the server:
   *   1. Ensure socket directory with 0700 permissions
   *   2. Provision socket paths for the server session
   *   3. Bind RequestChannel (ROUTER) and EventBus (PUB)
   *   4. Create ToolCatalog, PluginLoader, SessionManager, ResponseSanitizer
   *   5. Load plugins
   *   6. Wire MessageRouter with request handler
   *   7. Report ready
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Server is already started');
    }

    // 1. Socket provisioner — manages socket file paths
    const provisionerOpts: { socketDir: string; fs?: SocketFs } = {
      socketDir: this.config.socketDir,
    };
    if (this.provisionerFs) {
      provisionerOpts.fs = this.provisionerFs;
    }
    this.provisioner = new SocketProvisioner(provisionerOpts);
    this.provisioner.ensureDirectory();

    // 2. Provision socket paths for the server
    const provision = this.provisioner.provision(SERVER_SESSION_ID);

    // 3. Bind RequestChannel and EventBus
    this.requestChannel = new RequestChannel(this.socketFactory);
    await this.requestChannel.bind(provision.requestAddress);

    this.eventBus = new EventBus(this.socketFactory);
    await this.eventBus.bind(provision.eventAddress);

    // 4. Create subsystems
    this.toolCatalog = new ToolCatalog();
    this.sessionManager = new SessionManager();
    this.responseSanitizer = new ResponseSanitizer();

    this.pluginLoader = new PluginLoader({
      toolCatalog: this.toolCatalog,
      userPluginsDir: this.config.pluginsDir,
      builtinPluginsDir: this.config.builtinPluginsDir,
    });

    this.router = new MessageRouter(this.toolCatalog);

    // 5. Load plugins (graceful — failures don't prevent startup)
    await this.pluginLoader.loadAll();

    // 6. Wire request handler
    this.requestChannel.onRequest((connectionIdentity: string, wire: WireMessage) => {
      void this.handleRequest(connectionIdentity, wire);
    });

    this.started = true;

    // 7. Report ready
    this.output('Server ready');
  }

  /**
   * Shut down the server:
   *   1. Close request channel (drains pending requests)
   *   2. Close event bus
   *   3. Shutdown plugin handlers
   *   4. Release provisioned socket files
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    // 1. Close request channel
    if (this.requestChannel) {
      await this.requestChannel.close();
      this.requestChannel = null;
    }

    // 2. Close event bus
    if (this.eventBus) {
      await this.eventBus.close();
      this.eventBus = null;
    }

    // 3. Shutdown plugins
    if (this.pluginLoader) {
      await this.pluginLoader.shutdownAll();
      this.pluginLoader = null;
    }

    // 4. Release socket files
    if (this.provisioner) {
      this.provisioner.releaseAll();
      this.provisioner = null;
    }

    // 5. Clear subsystem references
    this.sessionManager?.cleanup();
    this.router = null;
    this.toolCatalog = null;
    this.responseSanitizer = null;
    this.sessionManager = null;

    this.started = false;
  }

  // -------------------------------------------------------------------------
  // Private: request handling
  // -------------------------------------------------------------------------

  /**
   * Handle an incoming request from a container DEALER.
   *
   * 1. Look up or create session from connection identity
   * 2. Route through MessageRouter pipeline
   * 3. Sanitize response through ResponseSanitizer
   * 4. Send response back through RequestChannel
   */
  private async handleRequest(connectionIdentity: string, wire: WireMessage): Promise<void> {
    if (!this.requestChannel || !this.router || !this.responseSanitizer) {
      return;
    }

    // Look up session by connection identity
    let session = this.sessionManager?.getByConnectionIdentity(connectionIdentity);
    if (!session) {
      // Auto-create session for new connections
      session =
        this.sessionManager?.create({
          containerId: `container-${connectionIdentity}`,
          group: 'default',
          connectionIdentity,
        }) ?? null;
    }

    if (!session) {
      return;
    }

    const sessionContext = this.sessionManager?.toSessionContext(session.sessionId);
    if (!sessionContext) {
      return;
    }

    // Route through pipeline
    const response = await this.router.processRequest(wire, sessionContext);

    // Sanitize response (defense-in-depth against credential leaks)
    const sanitized = this.responseSanitizer.sanitize(response.payload);
    const sanitizedResponse = {
      ...response,
      payload: sanitized.value as typeof response.payload,
    };

    // Send back to the DEALER
    try {
      await this.requestChannel.sendResponse(connectionIdentity, sanitizedResponse);
    } catch {
      // Connection may have been closed — log and continue
    }
  }
}
