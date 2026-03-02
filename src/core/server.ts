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
import {
  readCredentialStdin,
  prepareOAuthCredentials,
  OAUTH_CREDENTIALS_FILENAME,
  type CredentialPrepareFs,
} from './credential-reader.js';
import { createLogger, type Logger } from './logger.js';
import { SkillLoader } from './skill-loader.js';
import { ApiOutputReader } from './api-output-reader.js';

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
  /** Aggregated skills output directory ($CARAPACE_HOME/run/skills/). */
  skillsDir?: string;
  /** Directory to watch for CLI-submitted reload trigger files. */
  reloadDir?: string;
  /**
   * TCP port for the request channel.
   *
   * When set, the ROUTER socket binds to `tcp://0.0.0.0:{port}` in
   * addition to its IPC address. Required for Apple Containers where
   * Unix domain sockets don't cross the VM boundary.
   */
  tcpRequestPort?: number;
  /**
   * Enable API mode: containers run claude-cli-api server instead of
   * direct claude exec. Prompts are sent via HTTP, responses streamed
   * back as SSE. Default: false (legacy direct-exec mode).
   */
  useApiMode?: boolean;
}

/** Minimal filesystem interface for prompt file watching. */
export interface PromptFs {
  readdirSync(dir: string): string[];
  readFileSync(path: string, encoding: 'utf-8'): string;
  unlinkSync(path: string): void;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

/**
 * A pre-constructed built-in handler to register before filesystem discovery.
 * Used for handlers like the installer that need constructor-injected deps.
 */
export interface BuiltinHandlerEntry {
  name: string;
  handler: PluginHandler;
  manifest: import('../types/index.js').PluginManifest;
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
  /** Filesystem abstraction for credential reading and preparation. */
  credentialFs?: CredentialPrepareFs;
  /** Logger instance for structured logging. */
  logger?: Logger;
  /** Pre-constructed built-in handlers to register before filesystem plugin discovery. */
  builtinHandlers?: BuiltinHandlerEntry[];
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
  private readonly credentialFs: CredentialPrepareFs | undefined;
  private readonly logger: Logger;
  private readonly builtinHandlers: BuiltinHandlerEntry[];

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
  private skillLoader: SkillLoader | null = null;
  private promptPollTimer: ReturnType<typeof setInterval> | null = null;
  private reloadPollTimer: ReturnType<typeof setInterval> | null = null;
  private reloading = false;
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
    this.builtinHandlers = deps.builtinHandlers ?? [];

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

    // Bind additional TCP endpoint for Apple Containers (VM isolation prevents IPC)
    let tcpRequestAddress: string | undefined;
    if (this.config.tcpRequestPort) {
      tcpRequestAddress = `tcp://0.0.0.0:${this.config.tcpRequestPort}`;
      await this.requestChannel.bindAdditional(tcpRequestAddress);
    }

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

    // 5a. Register pre-constructed built-in handlers (before filesystem discovery)
    for (const entry of this.builtinHandlers) {
      await this.pluginLoader.registerBuiltinHandler(entry.name, entry.handler, entry.manifest);
    }

    // 5b. Load plugins from filesystem (graceful — failures don't prevent startup)
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
        useApiMode: this.config.useApiMode,
      });

      const lifecycleManager = this.lifecycleManager;
      const config = this.config;
      const sessionManager = this.sessionManager;
      const credFs = this.credentialFs;
      const claudeSessionStore = this.claudeSessionStore;
      const pFs = this.promptFs;
      const eventBus = this.eventBus;
      const responseSanitizer = this.responseSanitizer;
      const serverLogger = this.logger;

      // Create SkillLoader for aggregating skills before spawn
      if (config.skillsDir) {
        this.skillLoader = new SkillLoader({
          pluginsDir: config.pluginsDir,
          builtinPluginsDir: config.builtinPluginsDir,
          skillsOutputDir: config.skillsDir,
        });
      }
      const skillLoader = this.skillLoader;

      this.eventDispatcher = new EventDispatcher({
        logger: this.logger.child('event-dispatcher'),
        getActiveSessionCount: (group) =>
          sessionManager.getAll().filter((s) => s.group === group).length,
        spawnAgent: async (group, env) => {
          // Ensure per-group claude-state directory exists before container mount
          const claudeStatePath = config.claudeStateDir
            ? join(config.claudeStateDir, group)
            : undefined;
          if (claudeStatePath && pFs) {
            if (!pFs.existsSync(claudeStatePath)) {
              pFs.mkdirSync(claudeStatePath, { recursive: true });
            }
          }

          // Credential injection strategy:
          //   1. API key → stdin injection (existing path)
          //   2. OAuth credentials JSON → copy into claude-state dir (file-based)
          //   3. Neither → warn, no credentials
          let stdinData: string | undefined;
          if (config.credentialsDir && credFs) {
            const apiKeyStdin = readCredentialStdin(config.credentialsDir, credFs);
            if (apiKeyStdin) {
              stdinData = apiKeyStdin;
            } else if (claudeStatePath) {
              // Try OAuth credentials file — copy into claude-state for bind mount
              const oauthSourcePath = `${config.credentialsDir}/${OAUTH_CREDENTIALS_FILENAME}`;
              if (credFs.existsSync(oauthSourcePath)) {
                prepareOAuthCredentials(config.credentialsDir, claudeStatePath, credFs);
              }
            }
          }

          // Aggregate skills before each container spawn
          if (skillLoader) {
            await skillLoader.aggregateSkills();
          }

          // In API mode, extract prompt from env (it's sent via HTTP, not as env var).
          // env may be undefined when the event trigger provides no extra env vars —
          // optional chaining handles this safely.
          const taskPrompt = env?.['CARAPACE_TASK_PROMPT'];
          const resumeSessionId = env?.['CARAPACE_RESUME_SESSION_ID'];
          const spawnEnv = env ? { ...env } : env;
          if (config.useApiMode && spawnEnv) {
            delete spawnEnv['CARAPACE_TASK_PROMPT'];
            delete spawnEnv['CARAPACE_RESUME_SESSION_ID'];
          }

          // Defense-in-depth: warn if stdinData accidentally contains the task
          // prompt. stdinData is piped to the entrypoint as env vars — the prompt
          // should only travel via HTTP in API mode or CARAPACE_TASK_PROMPT env var.
          if (stdinData && stdinData.includes('CARAPACE_TASK_PROMPT')) {
            serverLogger.warn(
              'stdinData contains CARAPACE_TASK_PROMPT — possible credential leak',
              {
                group,
              },
            );
          }

          const managed = await lifecycleManager.spawn({
            group,
            image: config.containerImage ?? 'carapace-agent:latest',
            socketPath: provision.requestSocketPath,
            workspacePath: config.workspacePath,
            env: spawnEnv,
            stdinData,
            claudeStatePath,
            skillsDir: config.skillsDir,
            tcpRequestAddress,
          });

          // In API mode: send prompt via HTTP and stream response to EventBus.
          // Capture apiClient before the IIFE so TypeScript knows it's defined
          // (the `if` guard above already checked `managed.apiClient`).
          const apiClient = managed.apiClient;
          if (config.useApiMode && apiClient && (!taskPrompt || !eventBus || !claudeSessionStore)) {
            // API mode container spawned but missing required streaming deps —
            // shut down immediately to prevent orphaned containers.
            serverLogger.warn(
              'API mode container spawned without task prompt or deps, shutting down',
              {
                group,
                hasPrompt: !!taskPrompt,
                hasEventBus: !!eventBus,
                hasSessionStore: !!claudeSessionStore,
              },
            );
            await lifecycleManager.shutdown(managed.session.sessionId);
            return managed.session.sessionId;
          }
          if (apiClient && taskPrompt && eventBus && claudeSessionStore) {
            const apiReader = new ApiOutputReader({
              eventBus,
              claudeSessionStore,
              sanitizer: responseSanitizer ?? undefined,
              logger: serverLogger.child('api-output-reader'),
            });

            // Fire-and-forget: stream in background, shut down container when done.
            // Race note: if an external shutdown kills the apiClient while the
            // stream is in-flight, the stream errors (caught below), and the
            // finally-block shutdown() is a benign no-op (session already removed).
            void (async () => {
              try {
                const events = apiClient.completeStream({
                  prompt: taskPrompt,
                  sessionId: resumeSessionId,
                });
                await apiReader.processStream(
                  events,
                  {
                    sessionId: managed.session.sessionId,
                    group,
                    containerId: managed.handle.id,
                  },
                  managed.handle.stderr,
                );
              } catch (streamErr) {
                serverLogger.warn('API stream processing failed', {
                  group,
                  session: managed.session.sessionId,
                  error: streamErr instanceof Error ? streamErr.message : String(streamErr),
                });
              } finally {
                await lifecycleManager.shutdown(managed.session.sessionId);
              }
            })();
          }

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

    // 8a. Start reload file polling (if reloadDir is configured)
    if (this.config.reloadDir) {
      this.startReloadPolling(this.config.reloadDir);
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

    // 0. Stop prompt polling and reload polling
    if (this.promptPollTimer) {
      clearInterval(this.promptPollTimer);
      this.promptPollTimer = null;
    }
    if (this.reloadPollTimer) {
      clearInterval(this.reloadPollTimer);
      this.reloadPollTimer = null;
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
    this.skillLoader = null;

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

  // -------------------------------------------------------------------------
  // Private: reload file polling
  // -------------------------------------------------------------------------

  /**
   * Reload all plugins and re-aggregate skills.
   *
   * Guarded against concurrent invocations by a boolean flag.
   */
  async reloadPlugins(): Promise<void> {
    if (this.reloading) {
      this.logger.warn('reload already in progress, skipping');
      return;
    }
    this.reloading = true;

    try {
      this.logger.info('plugin reload starting');

      if (this.pluginLoader) {
        const results = await this.pluginLoader.reloadAll();
        const succeeded = results.filter((r) => r.ok).length;
        const failed = results.filter((r) => !r.ok).length;
        this.logger.info('plugin reload complete', { succeeded, failed });
        this.output(`Plugins reloaded: ${succeeded} succeeded, ${failed} failed`);
      }

      if (this.skillLoader) {
        await this.skillLoader.aggregateSkills();
        this.logger.info('skills re-aggregated');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('plugin reload failed', { error: message });
      this.output(`Plugin reload error: ${message}`);
    } finally {
      this.reloading = false;
    }
  }

  /**
   * Reload a single plugin by name and re-aggregate skills.
   *
   * Guarded against concurrent invocations (shared with reloadPlugins).
   */
  private async reloadSinglePlugin(pluginName: string): Promise<void> {
    if (this.reloading) {
      this.logger.warn('reload already in progress, skipping single-plugin reload', { pluginName });
      return;
    }
    this.reloading = true;

    try {
      if (this.pluginLoader) {
        const result = await this.pluginLoader.reloadPlugin(pluginName);
        if (result.ok) {
          this.output(`Plugin "${pluginName}" reloaded successfully`);
        } else {
          this.output(`Plugin "${pluginName}" reload failed: ${result.error}`);
        }
      }

      if (this.skillLoader) {
        await this.skillLoader.aggregateSkills();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('single-plugin reload failed', { pluginName, error: message });
      this.output(`Plugin "${pluginName}" reload error: ${message}`);
    } finally {
      this.reloading = false;
    }
  }

  /**
   * Start polling a directory for CLI-submitted reload trigger files.
   *
   * Files are JSON-serialized reload triggers written by `carapace reload`.
   * Each file is read, consumed, and triggers a reload.
   */
  private startReloadPolling(reloadDir: string): void {
    const fs = this.promptFs;
    if (!fs) return;

    // Ensure reload directory exists
    if (!fs.existsSync(reloadDir)) {
      fs.mkdirSync(reloadDir, { recursive: true });
    }

    this.reloadPollTimer = setInterval(() => {
      this.processReloadFiles(reloadDir, fs);
    }, Server.PROMPT_POLL_INTERVAL_MS);

    // Don't let the timer keep the process alive
    if (this.reloadPollTimer.unref) {
      this.reloadPollTimer.unref();
    }
  }

  /**
   * Check the reload directory for new trigger files and process them.
   */
  private processReloadFiles(reloadDir: string, fs: PromptFs): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(reloadDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;

      const filePath = join(reloadDir, entry);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const trigger = JSON.parse(content) as { id?: string; plugin?: string | null };
        this.output(`Processing reload trigger: ${entry}`);

        if (trigger.plugin) {
          // Validate plugin name — reject path traversal
          const pluginName = trigger.plugin;
          if (pluginName.includes('/') || pluginName.includes('..') || pluginName.includes('\0')) {
            this.logger.warn('reload trigger rejected — invalid plugin name', { pluginName });
            this.output(`Reload rejected: invalid plugin name "${pluginName}"`);
          } else {
            // Single plugin reload — use concurrency guard
            void this.reloadSinglePlugin(pluginName);
          }
        } else {
          // Full reload
          void this.reloadPlugins();
        }

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

      const filePath = join(promptsDir, entry);
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
