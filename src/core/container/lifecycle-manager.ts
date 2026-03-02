/**
 * Container lifecycle manager for Carapace.
 *
 * Spawns agent containers on demand, manages their lifecycle
 * (start → running → shutdown), handles graceful and forced termination,
 * and cleans up resources on teardown. Detects and terminates orphaned
 * containers from previous runs.
 *
 * Uses the {@link ContainerRuntime} abstraction so the same lifecycle
 * logic works across Docker, Podman, and Apple Containers.
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import * as os from 'node:os';
import type {
  ContainerRuntime,
  ContainerRunOptions,
  ContainerHandle,
  ContainerState,
  PortMapping,
  VolumeMount,
} from './runtime.js';
import type { SessionManager, Session } from '../session-manager.js';
import { createLogger, type Logger } from '../logger.js';
import type { EventEnvelope } from '../../types/protocol.js';
import { ContainerOutputReader } from '../container-output-reader.js';
import { ContainerApiClient, type ApiClientOptions } from './api-client.js';
import { APPLE_CONTAINER_GATEWAY_IP, CONTAINER_API_DIR, CONTAINER_API_PORT } from './constants.js';
import { API_MODE_ENV } from './api-env.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for constructing a lifecycle manager. */
export interface LifecycleManagerOptions {
  /** Container runtime to use for spawning/managing containers. */
  runtime: ContainerRuntime;
  /** Session manager for tracking active sessions. */
  sessionManager: SessionManager;
  /** Milliseconds to wait for graceful stop before force-killing (default 10000). */
  shutdownTimeoutMs?: number;
  /** Named Docker/Podman network for allowlisted connectivity. When set, containers use this network instead of `--network none`. */
  networkName?: string;
  /** Optional logger for structured logging. */
  logger?: Logger;
  /** Optional event bus for publishing container output events. Required for ContainerOutputReader. */
  eventBus?: { publish(envelope: EventEnvelope): Promise<void> };
  /** Optional Claude session store for persisting --resume session IDs. Required for ContainerOutputReader. */
  claudeSessionStore?: { save(group: string, claudeSessionId: string): void };
  /** Optional response sanitizer for credential redaction on container output events. */
  responseSanitizer?: { sanitize(value: unknown): { value: unknown; redactedPaths: string[] } };
  /** Enable API mode: containers run claude-cli-api server instead of direct claude exec. */
  useApiMode?: boolean;
  /** Milliseconds to wait for the API health check to pass before giving up (default 30000). */
  healthCheckTimeoutMs?: number;
}

/** High-level request to spawn an agent container. */
export interface SpawnRequest {
  /** Group this agent session belongs to (e.g. "email", "slack"). */
  group: string;
  /** Container image reference. */
  image: string;
  /** Host-side ZeroMQ socket path to mount into the container. */
  socketPath: string;
  /** Optional host-side workspace directory to mount (read-write). */
  workspacePath?: string;
  /** Additional environment variables for the container. */
  env?: Record<string, string>;
  /**
   * Data to pipe to the container's stdin after creation.
   *
   * Used for credential injection: formatted as `NAME=VALUE\n` lines
   * followed by an empty line terminator. Piped via `docker create` +
   * `docker start -ai` so credentials never appear in `docker inspect`.
   */
  stdinData?: string;
  /**
   * Host-side path for per-group Claude Code state directory.
   *
   * Mounted as `/home/node/.claude` inside the container. Each group gets
   * its own isolated directory (e.g. `$CARAPACE_HOME/data/claude-state/{group}/`)
   * to prevent cross-group session data leakage (security P0).
   */
  claudeStatePath?: string;
  /**
   * Host-side path to the aggregated skills directory.
   *
   * Mounted as read-only at `/home/node/.claude/skills` inside the
   * container. Contains namespaced skill files from all plugins
   * (built-in + user). Set to `$CARAPACE_HOME/run/skills/` by the server.
   */
  skillsDir?: string;
  /**
   * TCP address for the request channel on the host.
   *
   * When set, the container uses TCP instead of IPC to communicate with
   * the host's ROUTER socket. Required for Apple Containers where Unix
   * domain sockets don't cross the VM boundary. The address should be
   * the host-reachable form (e.g. `tcp://192.168.64.1:5560`).
   */
  tcpRequestAddress?: string;
}

/**
 * A container managed by the lifecycle manager.
 *
 * In API mode, the container stays alive after spawn. The host is responsible
 * for calling shutdown() when the response stream completes or on error.
 * In legacy mode, the container exits naturally when claude finishes.
 */
export interface ManagedContainer {
  /** Opaque handle from the container runtime. */
  readonly handle: ContainerHandle;
  /** The registered session for this container. */
  readonly session: Session;
  /** API client for HTTP communication (API mode only). */
  readonly apiClient?: ContainerApiClient;
  /** Host-side API socket directory path (for cleanup). */
  readonly apiSocketDir?: string;
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const CONTAINER_SOCKET_PATH = '/run/carapace.sock';

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

/**
 * Allocate a free ephemeral port by binding to port 0 on localhost.
 *
 * The OS assigns a guaranteed-free port. We read it, close the listener,
 * and return the port number. There is a small TOCTOU window between
 * closing the listener and the container runtime binding the port, but
 * this is vastly safer than picking a random number from the ephemeral range.
 */
async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr !== 'string') {
        srv.close((err) => {
          if (err) reject(err);
          else resolve(addr.port);
        });
      } else {
        srv.close(() => reject(new Error('Failed to allocate port')));
      }
    });
    srv.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// ContainerLifecycleManager
// ---------------------------------------------------------------------------

export class ContainerLifecycleManager {
  private readonly runtime: ContainerRuntime;
  private readonly sessionManager: SessionManager;
  private readonly shutdownTimeoutMs: number;
  private readonly networkName?: string;
  private readonly logger: Logger;
  private readonly eventBus?: { publish(envelope: EventEnvelope): Promise<void> };
  private readonly claudeSessionStore?: { save(group: string, claudeSessionId: string): void };
  private readonly responseSanitizer?: {
    sanitize(value: unknown): { value: unknown; redactedPaths: string[] };
  };
  private readonly useApiMode: boolean;
  private readonly healthCheckTimeoutMs: number;

  /** Tracked containers indexed by session ID. */
  private readonly containers = new Map<string, ManagedContainer>();

  constructor(options: LifecycleManagerOptions) {
    this.runtime = options.runtime;
    this.sessionManager = options.sessionManager;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.networkName = options.networkName;
    this.logger = options.logger ?? createLogger('lifecycle');
    this.eventBus = options.eventBus;
    this.claudeSessionStore = options.claudeSessionStore;
    this.responseSanitizer = options.responseSanitizer;
    this.useApiMode = options.useApiMode ?? false;
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? 30_000;

    // API mode requires a named network because port publishing (-p) is
    // silently ignored with --network none (no network interfaces exist).
    if (this.useApiMode && !this.networkName) {
      throw new Error(
        'API mode requires networkName to be set (port publishing needs a network interface)',
      );
    }
  }

  /**
   * Spawn a new agent container and register its session.
   *
   * The container is created with security defaults: read-only filesystem,
   * no network access, and the ZeroMQ socket mounted in.
   */
  async spawn(request: SpawnRequest): Promise<ManagedContainer> {
    const rawIdentity = `carapace-${request.group}-${crypto.randomUUID()}`;
    const connectionIdentity = Buffer.from(rawIdentity).toString('hex');
    const containerName = `carapace-${request.group}-${crypto.randomUUID().slice(0, 8)}`;

    this.logger.info('spawning container', {
      group: request.group,
      image: request.image,
      containerName,
      hasStdinData: !!request.stdinData,
    });

    // Apple Containers --read-only is more restrictive than Docker's (blocks all
    // writes including tmpfs). Disable it for now until explicit writable mounts
    // cover all paths Claude Code needs.
    const useReadOnly = this.runtime.name !== 'apple-container';

    // Apple Containers run full VMs with separate Linux kernels — Unix domain
    // sockets (IPC) don't cross the VM boundary. Use TCP transport instead.
    // For Docker/Podman, keep the existing IPC socket mount.
    const volumes = this.buildVolumes(request);
    let socketMounts: ContainerRunOptions['socketMounts'] = [];
    const env: Record<string, string> = {
      ...request.env,
      CARAPACE_CONNECTION_IDENTITY: rawIdentity,
    };

    if (this.runtime.name === 'apple-container' && request.tcpRequestAddress) {
      // TCP transport: container connects to host via the VM's gateway address.
      // Rewrite the bind address (0.0.0.0) to the host-reachable gateway IP.
      env['CARAPACE_SOCKET'] = request.tcpRequestAddress.replace(
        '0.0.0.0',
        APPLE_CONTAINER_GATEWAY_IP,
      );
    } else {
      socketMounts = [
        {
          hostPath: request.socketPath,
          containerPath: CONTAINER_SOCKET_PATH,
        },
      ];
    }

    // API mode: set up claude-cli-api env vars, volumes, and port publishing
    let apiSocketDir: string | undefined;
    let apiKey: string | undefined;
    let portMappings: PortMapping[] = [];
    let apiHostPort: number | undefined;
    if (this.useApiMode) {
      const apiSetup = await this.setupApiMode(request, volumes, env, containerName);
      apiSocketDir = apiSetup.apiSocketDir;
      apiKey = apiSetup.apiKey;
      apiHostPort = apiSetup.apiHostPort;
      portMappings = apiSetup.portMappings;
    }

    const runOptions: ContainerRunOptions = {
      image: request.image,
      name: containerName,
      readOnly: useReadOnly,
      networkDisabled: !this.networkName,
      network: this.networkName,
      volumes,
      socketMounts,
      env,
      stdinData: request.stdinData,
      portMappings: portMappings.length > 0 ? portMappings : undefined,
    };

    const handle = await this.runtime.run(runOptions);

    const session = this.sessionManager.create({
      containerId: handle.id,
      group: request.group,
      connectionIdentity,
    });

    // Create API client and wait for readiness (API mode only)
    let apiClient: ContainerApiClient | undefined;
    if (this.useApiMode && apiKey && apiSocketDir && apiHostPort !== undefined) {
      const clientOptions: ApiClientOptions = {
        tcpAddress: `127.0.0.1:${apiHostPort}`,
        apiKey,
        logger: this.logger,
      };

      apiClient = new ContainerApiClient(clientOptions);

      try {
        await apiClient.waitForReady(this.healthCheckTimeoutMs, 100, async () => {
          try {
            const state = await this.runtime.inspect(handle);
            // Accept 'created' as alive — the container may still be transitioning
            // from created→running after detached `start -ai`. Only treat
            // 'stopped' and 'dead' as terminal (container has exited).
            return state.status !== 'stopped' && state.status !== 'dead';
          } catch {
            return false;
          }
        });
        this.logger.info('API client ready', {
          session: session.sessionId,
          containerId: handle.id,
        });
      } catch (err) {
        this.logger.warn('API client readiness check failed', {
          session: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Full cleanup on health check failure: stop container, remove it,
        // delete the session, and remove the API socket directory so nothing
        // is leaked when the caller catches the error.
        try {
          await this.runtime.stop(handle);
        } catch {
          /* best effort */
        }
        try {
          await this.runtime.remove(handle);
        } catch {
          /* best effort */
        }
        this.sessionManager.delete(session.sessionId);
        if (apiSocketDir) {
          try {
            rmSync(apiSocketDir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
        throw err;
      }
    }

    const managed: ManagedContainer = {
      handle,
      session,
      apiClient,
      apiSocketDir,
    };
    this.containers.set(session.sessionId, managed);

    // Start ContainerOutputReader if deps and stdout are available (legacy mode, fire-and-forget)
    if (!this.useApiMode && handle.stdout && this.eventBus && this.claudeSessionStore) {
      const reader = new ContainerOutputReader({
        eventBus: this.eventBus,
        claudeSessionStore: this.claudeSessionStore,
        sanitizer: this.responseSanitizer,
        logger: this.logger,
      });
      reader.start(handle.stdout, {
        sessionId: session.sessionId,
        group: request.group,
        containerId: handle.id,
      });
      this.logger.info('container output reader started', {
        session: session.sessionId,
        group: request.group,
        containerId: handle.id,
      });
    }

    this.logger.info('container spawned', {
      group: request.group,
      session: session.sessionId,
      containerId: handle.id,
      containerName,
      apiMode: this.useApiMode,
    });

    return managed;
  }

  /**
   * Gracefully shut down a container by session ID.
   *
   * Sends a graceful stop signal first. If the container does not stop
   * within the configured timeout, it is force-killed. The session and
   * container are always cleaned up regardless of stop outcome.
   *
   * @returns true if the session was found and shut down, false if not found.
   */
  async shutdown(sessionId: string): Promise<boolean> {
    const managed = this.containers.get(sessionId);
    if (!managed) {
      return false;
    }

    this.logger.info('shutting down container', {
      session: sessionId,
      group: managed.session.group,
      containerId: managed.handle.id,
    });

    // Remove from tracking immediately to prevent concurrent shutdown races
    this.containers.delete(sessionId);

    try {
      await this.stopWithTimeout(managed.handle);
    } catch {
      // Force kill if graceful stop failed or timed out
      this.logger.warn('graceful stop failed, force killing', {
        session: sessionId,
        containerId: managed.handle.id,
      });
      try {
        await this.runtime.kill(managed.handle);
      } catch {
        // Container may already be dead — continue cleanup
      }
    }

    // Clean up container resources (best-effort)
    try {
      await this.runtime.remove(managed.handle);
    } catch {
      // Container may already be removed — continue cleanup
    }

    // Close API client (zeros API key in memory)
    if (managed.apiClient) {
      managed.apiClient.close();
    }

    // Clean up API socket directory (API mode)
    if (managed.apiSocketDir) {
      try {
        rmSync(managed.apiSocketDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }

    // Always remove the session
    this.sessionManager.delete(sessionId);

    this.logger.info('container shut down', {
      session: sessionId,
      group: managed.session.group,
    });

    return true;
  }

  /** Shut down all managed containers. */
  async shutdownAll(): Promise<void> {
    const sessionIds = [...this.containers.keys()];
    this.logger.info('shutting down all containers', { count: sessionIds.length });
    await Promise.all(sessionIds.map((id) => this.shutdown(id)));
  }

  /**
   * Detect and clean up orphaned containers from a previous run.
   *
   * Accepts a list of container handles that were known from a previous
   * session (e.g., loaded from persistence). Inspects each one and:
   * - Running containers are killed then removed.
   * - Stopped/dead containers are removed.
   * - Containers that no longer exist are skipped.
   *
   * @returns The handles of containers that were successfully cleaned up.
   */
  async cleanupOrphans(orphanHandles: ContainerHandle[]): Promise<ContainerHandle[]> {
    this.logger.info('cleaning up orphans', { count: orphanHandles.length });
    const cleaned: ContainerHandle[] = [];

    for (const handle of orphanHandles) {
      try {
        const state = await this.runtime.inspect(handle);

        if (state.status === 'running' || state.status === 'starting') {
          this.logger.debug('killing orphan', { containerId: handle.id, status: state.status });
          await this.runtime.kill(handle);
        }

        await this.runtime.remove(handle);
        cleaned.push(handle);
      } catch {
        this.logger.debug('orphan not found', { containerId: handle.id });
      }
    }

    this.logger.info('orphan cleanup complete', { cleaned: cleaned.length });
    return cleaned;
  }

  /**
   * Get the current state of a managed container.
   *
   * @returns The container state, or null if the session is not found.
   */
  async getStatus(sessionId: string): Promise<ContainerState | null> {
    const managed = this.containers.get(sessionId);
    if (!managed) {
      return null;
    }

    return this.runtime.inspect(managed.handle);
  }

  /** Return all currently managed containers. */
  getAll(): ManagedContainer[] {
    return [...this.containers.values()];
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Build the volumes array from a spawn request. */
  private buildVolumes(request: SpawnRequest) {
    const volumes = [];

    if (request.workspacePath) {
      volumes.push({
        source: request.workspacePath,
        target: '/workspace',
        readonly: false,
      });
    }

    if (request.claudeStatePath) {
      volumes.push({
        source: request.claudeStatePath,
        target: '/home/node/.claude',
        readonly: false,
      });
    }

    if (request.skillsDir) {
      volumes.push({
        source: request.skillsDir,
        target: '/home/node/.claude/skills',
        readonly: true,
      });
    }

    return volumes;
  }

  /**
   * Set up API mode infrastructure: temp directory, API key file, writable
   * volumes, environment variables, and port allocation.
   *
   * Mutates `volumes` and `env` in-place so the caller's references are
   * updated. Returns the API-specific state needed for client creation
   * and cleanup.
   */
  private async setupApiMode(
    request: SpawnRequest,
    volumes: VolumeMount[],
    env: Record<string, string>,
    containerName: string,
  ): Promise<{
    apiSocketDir: string;
    apiKey: string;
    apiHostPort: number;
    portMappings: PortMapping[];
  }> {
    const apiSocketDir = join(os.tmpdir(), `carapace-api-${crypto.randomUUID()}`);
    mkdirSync(apiSocketDir, { mode: 0o700 });

    // API key lifecycle:
    //   1. Generated here as a random UUID, written to a host-side temp file.
    //   2. Bind-mounted into the container at CONTAINER_API_DIR/.api-key.
    //   3. The entrypoint script reads the file, exports API_KEY, then deletes it.
    //   4. The host-side temp directory (apiSocketDir) is cleaned up on
    //      shutdown() or on health check failure.
    //
    // Residual risk: if the host process crashes between step 1 and cleanup,
    // the temp directory persists in $TMPDIR. OS-level tmpdir reaping or a
    // future startup-time orphan sweep should handle this.
    const apiKey = crypto.randomUUID();
    const apiKeyFile = join(apiSocketDir, '.api-key');
    writeFileSync(apiKeyFile, apiKey, { mode: 0o600 });

    // Mount the API key directory into the container
    volumes.push({
      source: apiSocketDir,
      target: CONTAINER_API_DIR,
      readonly: false,
    });

    // Claude CLI needs writable $HOME and /tmp even with --read-only.
    // It writes ~/.claude.json, ~/.claude/, and temp files during execution.
    // Mount the entire /home/node so .claude.json can be created alongside .claude/.
    if (!request.claudeStatePath) {
      const homeDir = join(apiSocketDir, 'home-node');
      mkdirSync(homeDir, { mode: 0o700 });
      volumes.push({
        source: homeDir,
        target: '/home/node',
        readonly: false,
      });
    }

    const containerTmpDir = join(apiSocketDir, 'container-tmp');
    mkdirSync(containerTmpDir, { mode: 0o700 });
    volumes.push({
      source: containerTmpDir,
      target: '/tmp',
      readonly: false,
    });

    // Set API mode env vars — always TCP since claude-cli-api only supports TCP
    env[API_MODE_ENV.CARAPACE_API_MODE] = '1';
    env[API_MODE_ENV.CARAPACE_API_KEY_FILE] = `${CONTAINER_API_DIR}/.api-key`;
    env[API_MODE_ENV.MAX_CONCURRENT_PROCESSES] = '1';
    env[API_MODE_ENV.PORT] = String(CONTAINER_API_PORT);
    // Bind to 0.0.0.0 inside the container so port forwarding works
    // (-p binds on the host side; the container must accept on all
    // interfaces for the forwarded traffic to reach the server).
    // API mode requires a named network (port publishing is ignored
    // with --network none), so containers have outbound access.
    env[API_MODE_ENV.HOST] = '0.0.0.0';

    this.logger.info('API mode enabled', {
      group: request.group,
      containerName,
      apiSocketDir,
    });

    // Allocate an OS-assigned ephemeral port for port publishing.
    // Uses net.createServer on port 0 to get a guaranteed-free port, then
    // closes the listener before passing the port to the container runtime.
    const apiHostPort = await allocatePort();
    const portMappings: PortMapping[] = [
      { hostPort: apiHostPort, containerPort: CONTAINER_API_PORT },
    ];

    // apiKey stays on the host side (written to a temp file, never sent to container).
    return { apiSocketDir, apiKey, apiHostPort, portMappings }; // nosemgrep: carapace.no-credentials-in-response-fields
  }

  /** Attempt a graceful stop with a timeout. Rejects if timeout expires. */
  private stopWithTimeout(handle: ContainerHandle): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Graceful stop timed out'));
      }, this.shutdownTimeoutMs);

      this.runtime
        .stop(handle)
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}
