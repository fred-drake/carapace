/**
 * Container runtime interface and supporting types for Carapace.
 *
 * Defines the contract for spawning and managing agent containers across
 * multiple container engines (Docker, Podman, Apple Containers). All
 * adapters and the lifecycle manager (DEVOPS-03) consume this interface.
 *
 * @see docs/INSTALL_STRATEGY.md §3 for the design rationale.
 */

// ---------------------------------------------------------------------------
// Runtime name
// ---------------------------------------------------------------------------

/**
 * Supported container runtime engines.
 *
 * - `'docker'`          — Reference implementation, widest compatibility.
 * - `'podman'`          — Rootless by default, no root daemon.
 * - `'apple-container'` — macOS 26+ Apple Silicon, VM-per-container isolation.
 */
export type RuntimeName = 'docker' | 'podman' | 'apple-container';

// ---------------------------------------------------------------------------
// Volume mount
// ---------------------------------------------------------------------------

/**
 * A bind-mount from host filesystem into the container.
 *
 * Adapter differences for bind mounts:
 * - **Podman**: Appends `:Z` suffix on bind mounts for SELinux relabeling.
 *   Without this, SELinux-enabled hosts deny container access to mounted paths.
 *   Podman also uses `--userns=keep-id` for rootless UID mapping.
 * - **Apple Containers**: Read-only filesystem is the default. Mutable mounts
 *   must be explicitly declared.
 * - **Docker**: Standard bind mount semantics, no special suffixes needed.
 */
export interface VolumeMount {
  /** Absolute path on the host. */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  /** If true, the container cannot write to this mount. */
  readonly: boolean;
}

// ---------------------------------------------------------------------------
// Socket mount
// ---------------------------------------------------------------------------

/**
 * A Unix domain socket mount into the container.
 *
 * First-class type to accommodate Apple Container's vsock transport,
 * which is fundamentally different from a bind-mounted socket file.
 *
 * Adapter differences for socket mounts:
 * - **Apple Containers**: Uses `--publish-socket` to expose host sockets via
 *   vsock (virtio socket). This bypasses the network stack entirely —
 *   superior latency and isolation compared to bind-mounted Unix sockets.
 * - **Docker**: Bind-mounts the socket file as a regular volume
 *   (e.g. `-v /host/sock:/container/sock`).
 * - **Podman**: Same as Docker, but with `:Z` SELinux suffix appended
 *   to the bind mount path.
 */
export interface SocketMount {
  /** Absolute path to the socket on the host. */
  hostPath: string;
  /** Absolute path where the socket appears inside the container. */
  containerPath: string;
}

// ---------------------------------------------------------------------------
// Container run options
// ---------------------------------------------------------------------------

/**
 * Options for launching a new container.
 *
 * Covers all mount types including {@link SocketMount} for vsock.
 */
export interface ContainerRunOptions {
  /** Container image reference (e.g. `"ghcr.io/fred-drake/carapace-agent@sha256:..."` ). */
  image: string;
  /** Optional human-readable container name. */
  name?: string;
  /** Mount the root filesystem as read-only. */
  readOnly: boolean;
  /** Disable all network access inside the container. Ignored when `network` is set. */
  networkDisabled: boolean;
  /** Connect the container to a named Docker/Podman network. Overrides `networkDisabled`. */
  network?: string;
  /** Filesystem bind mounts. */
  volumes: VolumeMount[];
  /** Unix domain socket mounts (first-class for Apple Container vsock). */
  socketMounts: SocketMount[];
  /** Environment variables injected into the container. */
  env: Record<string, string>;
  /** Container user in `"uid:gid"` format. */
  user?: string;
  /** Override the image's default entrypoint. */
  entrypoint?: string[];
}

// ---------------------------------------------------------------------------
// Container handle
// ---------------------------------------------------------------------------

/**
 * Opaque handle to a running container, returned by {@link ContainerRuntime.run}.
 *
 * Consumers should treat this as an opaque token — only the runtime that
 * created it can meaningfully interpret the `id` field. The handle carries
 * enough context (runtime name) for logging and diagnostics.
 */
export interface ContainerHandle {
  /** Container engine identifier (e.g. Docker container ID, hex string). */
  readonly id: string;
  /** Human-readable container name. */
  readonly name: string;
  /** Which runtime created this handle. */
  readonly runtime: RuntimeName;
}

// ---------------------------------------------------------------------------
// Container state
// ---------------------------------------------------------------------------

/**
 * Snapshot of a container's current state, returned by
 * {@link ContainerRuntime.inspect}.
 */
export interface ContainerState {
  /** Current lifecycle status. */
  status: 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'dead';
  /** Process exit code (only meaningful when status is `'stopped'` or `'dead'`). */
  exitCode?: number;
  /** ISO 8601 timestamp when the container started. */
  startedAt?: string;
  /** ISO 8601 timestamp when the container exited. */
  finishedAt?: string;
  /** Health check status, if a health check is configured. */
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
}

// ---------------------------------------------------------------------------
// Container runtime interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over a container engine (Docker, Podman, Apple Containers).
 *
 * All methods are async to accommodate real container engines that
 * communicate over HTTP/Unix sockets. Adapters implement this interface
 * with engine-specific behavior:
 *
 * - **Docker** — Reference implementation. Uses the Docker Engine API.
 *   Standard bind mounts, `--read-only` flag, `--network none`.
 *
 * - **Podman** — Appends `:Z` suffix on all bind mounts for SELinux
 *   relabeling. Uses `--userns=keep-id` for rootless UID mapping so
 *   files created inside the container are owned by the invoking user.
 *
 * - **Apple Containers** — Uses `--publish-socket` for Unix sockets
 *   (vsock transport bypasses network stack — lower latency, stronger
 *   isolation than Docker's bind-mount approach). Read-only filesystem
 *   is the default; writable mounts must be explicitly declared.
 *   VM-per-container isolation matches the architecture doc's security
 *   model ("VM-based isolation, not just namespaces").
 */
export interface ContainerRuntime {
  /** Which engine this runtime represents. */
  readonly name: RuntimeName;

  // -- Availability ---------------------------------------------------------

  /** Check whether the engine binary is installed and responsive. */
  isAvailable(): Promise<boolean>;

  /** Return the engine's version string (e.g. `"Docker 27.5.1"`). */
  version(): Promise<string>;

  // -- Image lifecycle ------------------------------------------------------

  /** Pull an image from a registry. */
  pull(image: string): Promise<void>;

  /** Check whether an image exists locally. */
  imageExists(image: string): Promise<boolean>;

  /**
   * Load an image from a local tarball (e.g. a Nix-built OCI archive).
   * @param source - Absolute path to the tarball file.
   */
  loadImage(source: string): Promise<void>;

  // -- Container lifecycle --------------------------------------------------

  /** Launch a new container and return an opaque handle. */
  run(options: ContainerRunOptions): Promise<ContainerHandle>;

  /**
   * Gracefully stop a container.
   * @param handle - Handle returned by {@link run}.
   * @param timeout - Seconds to wait before force-killing (default: engine-specific).
   */
  stop(handle: ContainerHandle, timeout?: number): Promise<void>;

  /** Immediately kill a container (SIGKILL). */
  kill(handle: ContainerHandle): Promise<void>;

  /** Remove a stopped container and its resources. */
  remove(handle: ContainerHandle): Promise<void>;

  /** Inspect a container's current state. */
  inspect(handle: ContainerHandle): Promise<ContainerState>;
}
