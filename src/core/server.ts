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

import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { SocketFactory } from '../types/socket.js';
import type { WireMessage, EventEnvelope } from '../types/protocol.js';
import { SocketProvisioner } from './socket-provisioner.js';
import type { SocketFs } from './socket-provisioner.js';
import { RequestChannel } from './request-channel.js';
import { EventBus } from './event-bus.js';
import type { SubscriptionHandle } from './event-bus.js';
import { ToolCatalog } from './tool-catalog.js';
import { PluginLoader } from './plugin-loader.js';
import type { PluginHandler } from './plugin-handler.js';
import { SessionManager } from './session-manager.js';
import { ResponseSanitizer } from './response-sanitizer.js';
import { MessageRouter } from './router.js';
import { ECHO_TOOL_DECLARATION, echoToolHandler } from './intrinsic-echo.js';
import type { ContainerRuntime } from './container/runtime.js';
import { ContainerLifecycleManager } from './container/lifecycle-manager.js';
import { EventDispatcher } from './event-dispatcher.js';
import { ClaudeSessionStore, CLAUDE_SESSION_MIGRATIONS } from './claude-session-store.js';
import { readCredentialStdin, type CredentialFs } from './credential-reader.js';
import { createLogger, type Logger } from './logger.js';

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
  /** Container image reference for spawning agent containers. */
  containerImage?: string;
  /** Host-side workspace directory to mount into containers. */
  workspacePath?: string;
  /** Maximum concurrent sessions allowed per group (default: 3). */
  maxSessionsPerGroup?: number;
  /** Groups that accept message.inbound events. */
  configuredGroups?: string[];
  /** Directory to watch for CLI-submitted prompt files. */
  promptsDir?: string;
  /** Directory containing credential files (anthropic-api-key, claude-oauth-token). */
  credentialsDir?: string;
  /** Directory containing per-plugin credential files (`$CARAPACE_HOME/credentials/plugins/`). */
  credentialsPluginsDir?: string;
  /** Base directory for per-group Claude Code state (e.g. `$CARAPACE_HOME/data/claude-state/`). */
  claudeStateDir?: string;
  /** Path to the SQLite database for ClaudeSessionStore. */
  sessionDbPath?: string;
  /** Container network name (e.g. 'bridge'). When set, containers have network access. */
  networkName?: string;
}

/** Minimal filesystem interface for prompt file watching. */
export interface PromptFs {
  readdirSync(dir: string): string[];
  readFileSync(path: string, encoding: 'utf-8'): string;
  unlinkSync(path: string): void;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

/** Injectable dependencies for the Server. */
export interface ServerDeps {
  /** Socket factory — ZmqSocketFactory in production, FakeSocketFactory in tests. */
  socketFactory: SocketFactory;
  /** Filesystem abstraction for SocketProvisioner. */
  fs?: SocketFs;
  /** Output callback for status messages (e.g. "Server ready"). */
  output?: (msg: string) => void;
  /** Container runtime for spawning agent containers. When provided, enables event dispatch. */
  containerRuntime?: ContainerRuntime;
  /** Filesystem abstraction for prompt file watching. */
  promptFs?: PromptFs;
  /** Filesystem abstraction for credential reading. */
  credentialFs?: CredentialFs;
  /** Logger instance for structured logging. */
  logger?: Logger;
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
  private readonly containerRuntime: ContainerRuntime | undefined;
  private readonly promptFs: PromptFs | undefined;
  private readonly credentialFs: CredentialFs | undefined;
  private readonly logger: Logger;

  // Subsystems — created during start()
  private provisioner: SocketProvisioner | null = null;
  private requestChannel: RequestChannel | null = null;
  private eventBus: EventBus | null = null;
  private pluginLoader: PluginLoader | null = null;
  private router: MessageRouter | null = null;
  private lifecycleManager: ContainerLifecycleManager | null = null;
  private eventDispatcher: EventDispatcher | null = null;
  private eventSubscription: SubscriptionHandle | null = null;
  private claudeSessionStore: ClaudeSessionStore | null = null;
  private promptPollTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  // Exposed for orchestrator chain inspection (e.g. by downstream tasks)
  public sessionManager: SessionManager | null = null;
  public toolCatalog: ToolCatalog | null = null;
  public responseSanitizer: ResponseSanitizer | null = null;

  constructor(config: ServerConfig, deps: ServerDeps) {
    this.config = config;
    this.socketFactory = deps.socketFactory;
    this.output = deps.output ?? (() => {});
    this.containerRuntime = deps.containerRuntime;
    this.promptFs = deps.promptFs;
    this.credentialFs = deps.credentialFs;
    this.logger = deps.logger ?? createLogger('server');

    // If a custom FS is provided, store it for provisioner creation
    this.provisionerFs = deps.fs;
  }

  private readonly provisionerFs: SocketFs | undefined;

  /**
   * Return the loaded plugin handler by directory name, or undefined
   * if the plugin is not loaded (or the server has not started).
   */
  getPluginHandler(name: string): PluginHandler | undefined {
    return this.pluginLoader?.getHandler(name);
  }

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

    this.logger.info('server starting', { socketDir: this.config.socketDir });

    // 1. Socket provisioner — manages socket file paths
    const provisionerOpts: { socketDir: string; fs?: SocketFs } = {
      socketDir: this.config.socketDir,
    };
    if (this.provisionerFs) {
      provisionerOpts.fs = this.provisionerFs;
    }
    this.provisioner = new SocketProvisioner(provisionerOpts);
    this.provisioner.ensureDirectory();

    // 1a. Clean up stale socket files from previous crashed sessions
    this.provisioner.cleanupStale(new Set());

    // 2. Provision socket paths for the server
    const provision = this.provisioner.provision(SERVER_SESSION_ID);

    // 3. Bind RequestChannel and EventBus
    this.requestChannel = new RequestChannel(
      this.socketFactory,
      undefined,
      this.logger.child('request-channel'),
    );
    await this.requestChannel.bind(provision.requestAddress);

    this.eventBus = new EventBus(this.socketFactory, this.logger.child('event-bus'));
    await this.eventBus.bind(provision.eventAddress);

    // 4. Create subsystems
    this.toolCatalog = new ToolCatalog(this.logger.child('tool-catalog'));
    this.sessionManager = new SessionManager(this.logger.child('session'));
    this.responseSanitizer = new ResponseSanitizer();

    // 4a. Register intrinsic tools (always available, not filesystem-discovered)
    this.toolCatalog.register(ECHO_TOOL_DECLARATION, echoToolHandler);

    this.pluginLoader = new PluginLoader({
      toolCatalog: this.toolCatalog,
      userPluginsDir: this.config.pluginsDir,
      builtinPluginsDir: this.config.builtinPluginsDir,
      credentialsPluginsDir: this.config.credentialsPluginsDir,
      logger: this.logger.child('plugin-loader'),
    });

    this.router = new MessageRouter(this.toolCatalog);

    // 5. Load plugins (graceful — failures don't prevent startup)
    await this.pluginLoader.loadAll();

    // 6. Wire request handler
    this.requestChannel.onRequest((connectionIdentity: string, wire: WireMessage) => {
      void this.handleRequest(connectionIdentity, wire);
    });

    // 7. Wire event dispatch pipeline (when container runtime is available)
    if (this.containerRuntime) {
      // Create ClaudeSessionStore if sessionDbPath is configured
      if (this.config.sessionDbPath) {
        const db = new Database(this.config.sessionDbPath);
        db.pragma('journal_mode = WAL');
        this.claudeSessionStore = ClaudeSessionStore.create(db, CLAUDE_SESSION_MIGRATIONS);
      }

      this.lifecycleManager = new ContainerLifecycleManager({
        runtime: this.containerRuntime,
        sessionManager: this.sessionManager,
        logger: this.logger.child('lifecycle'),
        eventBus: this.eventBus ?? undefined,
        claudeSessionStore: this.claudeSessionStore ?? undefined,
        responseSanitizer: this.responseSanitizer ?? undefined,
        networkName: this.config.networkName,
      });

      const lifecycleManager = this.lifecycleManager;
      const config = this.config;
      const sessionManager = this.sessionManager;
      const credFs = this.credentialFs;
      const claudeSessionStore = this.claudeSessionStore;
      const pFs = this.promptFs;

      this.eventDispatcher = new EventDispatcher({
        logger: this.logger.child('event-dispatcher'),
        getActiveSessionCount: (group) =>
          sessionManager.getAll().filter((s) => s.group === group).length,
        spawnAgent: async (group, env) => {
          // Read credentials for injection via stdin
          let stdinData: string | undefined;
          if (config.credentialsDir && credFs) {
            const creds = readCredentialStdin(config.credentialsDir, credFs);
            if (creds) {
              stdinData = creds;
            }
          }

          // Ensure per-group claude-state directory exists before container mount
          const claudeStatePath = config.claudeStateDir
            ? join(config.claudeStateDir, group)
            : undefined;
          if (claudeStatePath && pFs) {
            if (!pFs.existsSync(claudeStatePath)) {
              pFs.mkdirSync(claudeStatePath, { recursive: true });
            }
          }

          const managed = await lifecycleManager.spawn({
            group,
            image: config.containerImage ?? 'carapace-agent:latest',
            socketPath: provision.requestSocketPath,
            workspacePath: config.workspacePath,
            env,
            stdinData,
            claudeStatePath,
          });
          return managed.session.sessionId;
        },
        maxSessionsPerGroup: config.maxSessionsPerGroup ?? 3,
        configuredGroups: new Set(config.configuredGroups ?? []),
        getSessionPolicy: () => 'fresh',
        getLatestSession: claudeSessionStore
          ? (group) => claudeSessionStore.getLatest(group)
          : undefined,
        getPluginHandler: (group) => this.pluginLoader?.getHandler(group),
        createSessionLookup: claudeSessionStore
          ? (group) => ({
              latest: async () => claudeSessionStore.getLatest(group),
              find: async (criteria) =>
                claudeSessionStore
                  .list(group)
                  .map((r) => ({
                    sessionId: r.claudeSessionId,
                    group: r.group,
                    startedAt: r.createdAt,
                    endedAt: null,
                    resumable: true,
                  }))
                  .slice(0, criteria.limit ?? 10),
            })
          : undefined,
      });

      const dispatcher = this.eventDispatcher;

      this.eventSubscription = await this.eventBus.subscribe(provision.eventAddress, [
        'message.inbound',
        'task.triggered',
      ]);

      this.eventSubscription.onMessage((envelope) => {
        void dispatcher.dispatch(envelope as EventEnvelope).then((result) => {
          if (result.action === 'error') {
            this.output(`Event dispatch error (${result.group}): ${result.reason}`);
          } else if (result.action === 'rejected') {
            this.output(`Event rejected (${result.group}): ${result.reason}`);
          } else if (result.action === 'dropped') {
            this.output(`Event dropped (${result.topic}): ${result.reason}`);
          } else if (result.action === 'spawned') {
            this.output(`Agent spawned for group "${result.group}" (session ${result.sessionId})`);
          }
        });
      });
    }

    // 8. Start prompt file polling (if promptsDir is configured and event dispatch is available)
    if (this.config.promptsDir && this.eventDispatcher) {
      this.startPromptPolling(this.config.promptsDir, this.eventDispatcher);
    }

    this.started = true;

    // 9. Report ready
    this.logger.info('server ready');
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

    this.logger.info('server stopping');

    // 0. Stop prompt polling
    if (this.promptPollTimer) {
      clearInterval(this.promptPollTimer);
      this.promptPollTimer = null;
    }

    // 1. Unsubscribe from event bus (before closing sockets)
    if (this.eventSubscription) {
      await this.eventSubscription.unsubscribe();
      this.eventSubscription = null;
    }

    // 2. Close request channel
    if (this.requestChannel) {
      await this.requestChannel.close();
      this.requestChannel = null;
    }

    // 3. Close event bus
    if (this.eventBus) {
      await this.eventBus.close();
      this.eventBus = null;
    }

    // 4. Shutdown lifecycle manager (kills containers, cleans sessions)
    if (this.lifecycleManager) {
      await this.lifecycleManager.shutdownAll();
      this.lifecycleManager = null;
    }
    this.eventDispatcher = null;

    // 4a. Close ClaudeSessionStore database
    if (this.claudeSessionStore) {
      this.claudeSessionStore.close();
      this.claudeSessionStore = null;
    }

    // 5. Shutdown plugins
    if (this.pluginLoader) {
      await this.pluginLoader.shutdownAll();
      this.pluginLoader = null;
    }

    // 6. Release socket files
    if (this.provisioner) {
      this.provisioner.releaseAll();
      this.provisioner = null;
    }

    // 7. Clear subsystem references
    this.sessionManager?.cleanup();
    this.router = null;
    this.toolCatalog = null;
    this.responseSanitizer = null;
    this.sessionManager = null;

    this.started = false;
    this.logger.info('server stopped');
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

    const startTime = Date.now();
    const reqLogger = this.logger.withContext({
      correlation: wire.correlation,
      topic: wire.topic,
    });
    reqLogger.info('request received', { connectionIdentity });

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
      if (session) {
        reqLogger.debug('session auto-created', { session: session.sessionId });
      }
    }

    if (!session) {
      reqLogger.warn('no session available');
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

    const hasError = response.payload.error !== null;
    const duration_ms = Date.now() - startTime;
    reqLogger.info('request completed', {
      duration_ms,
      ok: !hasError,
      error_code: hasError ? (response.payload.error as { code?: string })?.code : undefined,
    });

    // Send back to the DEALER
    try {
      await this.requestChannel.sendResponse(connectionIdentity, sanitizedResponse);
    } catch (err) {
      reqLogger.warn('response send failed', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private: prompt file polling
  // -------------------------------------------------------------------------

  /** Polling interval for prompt file checking (500ms). */
  private static readonly PROMPT_POLL_INTERVAL_MS = 500;

  /**
   * Start polling a directory for CLI-submitted prompt files.
   *
   * Files are JSON-serialized EventEnvelopes written by `carapace prompt`.
   * Each file is read, dispatched, and deleted.
   */
  private startPromptPolling(promptsDir: string, dispatcher: EventDispatcher): void {
    const fs = this.promptFs;
    if (!fs) return;

    // Ensure prompts directory exists
    if (!fs.existsSync(promptsDir)) {
      fs.mkdirSync(promptsDir, { recursive: true });
    }

    this.promptPollTimer = setInterval(() => {
      this.processPromptFiles(promptsDir, dispatcher, fs);
    }, Server.PROMPT_POLL_INTERVAL_MS);

    // Don't let the timer keep the process alive
    if (this.promptPollTimer.unref) {
      this.promptPollTimer.unref();
    }
  }

  /**
   * Check the prompts directory for new files and dispatch them.
   */
  private processPromptFiles(promptsDir: string, dispatcher: EventDispatcher, fs: PromptFs): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(promptsDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;

      const filePath = `${promptsDir}/${entry}`;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const envelope = JSON.parse(content) as EventEnvelope;
        this.output(`Processing prompt file: ${entry}`);
        void dispatcher.dispatch(envelope).then((result) => {
          if (result.action === 'error') {
            this.output(`Prompt dispatch error (${result.group}): ${result.reason}`);
          } else if (result.action === 'rejected') {
            this.output(`Prompt rejected (${result.group}): ${result.reason}`);
          } else if (result.action === 'spawned') {
            this.output(
              `Agent spawned for prompt (group "${result.group}", session ${result.sessionId})`,
            );
          }
        });
        fs.unlinkSync(filePath);
      } catch {
        // Malformed file or read error — remove and continue
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Already gone
        }
      }
    }
  }
}
