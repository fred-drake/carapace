/**
 * Container runtime interfaces for Carapace.
 *
 * Defines the contract for spawning and managing agent containers.
 * The production implementation uses Docker; the mock implementation
 * (in src/testing/) enables unit testing without Docker.
 */

// ---------------------------------------------------------------------------
// Container info
// ---------------------------------------------------------------------------

/** Snapshot of a running (or recently stopped) container's state. */
export interface ContainerInfo {
  /** Unique identifier for the container (e.g. Docker container ID). */
  id: string;
  /** Human-readable container name. */
  name: string;
  /** ZeroMQ connection identity used to route messages to this container. */
  connectionIdentity: string;
  /** Current lifecycle status. */
  status: 'starting' | 'running' | 'stopping' | 'stopped';
  /** When the container was spawned. */
  startedAt: Date;
}

// ---------------------------------------------------------------------------
// Spawn options
// ---------------------------------------------------------------------------

/** Options passed to `ContainerRuntime.spawn()`. */
export interface SpawnOptions {
  /** Container image to use (e.g. "carapace-agent:latest"). */
  image: string;
  /** Human-readable name for the container. */
  name: string;
  /** Filesystem mounts into the container. */
  mounts: Array<{ source: string; target: string; readonly: boolean }>;
  /** Environment variables injected into the container. */
  environment: Record<string, string>;
  /** Path to the ZeroMQ Unix domain socket. */
  socketPath: string;
}

// ---------------------------------------------------------------------------
// Container runtime interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over the container engine (Docker, Podman, or mock).
 *
 * All methods are async to accommodate real container engines that
 * communicate over HTTP/Unix sockets.
 */
export interface ContainerRuntime {
  /** Spawn a new container and return its info once it reaches 'running'. */
  spawn(options: SpawnOptions): Promise<ContainerInfo>;

  /**
   * Stop a running container.
   * @param containerId - The container ID returned by `spawn()`.
   * @param timeoutMs - Graceful shutdown timeout before forced kill (default: 10000).
   */
  stop(containerId: string, timeoutMs?: number): Promise<void>;

  /** Check whether a container is currently running. */
  isRunning(containerId: string): Promise<boolean>;

  /** Get info for a container, or null if it was never spawned or has been cleaned up. */
  getInfo(containerId: string): Promise<ContainerInfo | null>;

  /** Stop all running containers and clean up resources. */
  cleanup(): Promise<void>;
}
