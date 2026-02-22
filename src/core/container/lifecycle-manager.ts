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

import type {
  ContainerRuntime,
  ContainerRunOptions,
  ContainerHandle,
  ContainerState,
} from './runtime.js';
import type { SessionManager, Session } from '../session-manager.js';
import { createLogger, type Logger } from '../logger.js';
import type { EventEnvelope } from '../../types/protocol.js';
import { ContainerOutputReader } from '../container-output-reader.js';

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
   * Mounted as `/.claude` inside the container. Each group gets its own
   * isolated directory (e.g. `$CARAPACE_HOME/data/claude-state/{group}/`)
   * to prevent cross-group session data leakage (security P0).
   */
  claudeStatePath?: string;
  /**
   * Host-side path to the aggregated skills directory.
   *
   * Mounted as read-only at `/skills` inside the container. Contains
   * namespaced skill files from all plugins (built-in + user).
   * Set to `$CARAPACE_HOME/run/skills/` by the server.
   */
  skillsDir?: string;
}

/** A container managed by the lifecycle manager. */
export interface ManagedContainer {
  /** Opaque handle from the container runtime. */
  handle: ContainerHandle;
  /** The registered session for this container. */
  session: Session;
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const CONTAINER_SOCKET_PATH = '/sockets/carapace.sock';

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
  }

  /**
   * Spawn a new agent container and register its session.
   *
   * The container is created with security defaults: read-only filesystem,
   * no network access, and the ZeroMQ socket mounted in.
   */
  async spawn(request: SpawnRequest): Promise<ManagedContainer> {
    const connectionIdentity = `carapace-${request.group}-${crypto.randomUUID()}`;
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

    const runOptions: ContainerRunOptions = {
      image: request.image,
      name: containerName,
      readOnly: useReadOnly,
      networkDisabled: !this.networkName,
      network: this.networkName,
      volumes: this.buildVolumes(request),
      socketMounts: [
        {
          hostPath: request.socketPath,
          containerPath: CONTAINER_SOCKET_PATH,
        },
      ],
      env: { ...request.env },
      stdinData: request.stdinData,
    };

    const handle = await this.runtime.run(runOptions);

    const session = this.sessionManager.create({
      containerId: handle.id,
      group: request.group,
      connectionIdentity,
    });

    const managed: ManagedContainer = { handle, session };
    this.containers.set(session.sessionId, managed);

    // Start ContainerOutputReader if deps and stdout are available (fire-and-forget)
    if (handle.stdout && this.eventBus && this.claudeSessionStore) {
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
        target: '/.claude',
        readonly: false,
      });
    }

    if (request.skillsDir) {
      volumes.push({
        source: request.skillsDir,
        target: '/skills',
        readonly: true,
      });
    }

    return volumes;
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
