/**
 * Podman container runtime adapter.
 *
 * Implements {@link ContainerRuntime} using the Podman CLI via
 * `child_process.execFile`. No Podman SDK dependency — just shell out
 * to the `podman` binary.
 *
 * Podman-specific behavior:
 * - `:Z` suffix on all bind mounts for SELinux relabeling. Without this,
 *   SELinux-enabled hosts deny container access to mounted paths.
 * - `--userns=keep-id` for rootless UID mapping so files created inside
 *   the container are owned by the invoking user.
 * - Inspect output uses `Healthcheck` field (some versions use `Health`).
 * - Version format uses `{{.Client.Version}}` (no server daemon).
 */

import type {
  ContainerRuntime,
  ContainerRunOptions,
  ContainerHandle,
  ContainerState,
  ImageBuildOptions,
  ExecFn,
  SpawnFn,
} from './runtime.js';
import { defaultExec, defaultSpawn } from './runtime.js';
import { CONTAINER_ZERO_TIME } from './constants.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PodmanRuntimeOptions {
  /** Injectable exec function for testing. Defaults to promisified execFile. */
  exec?: ExecFn;
  /** Path to the podman binary. Defaults to `'podman'`. */
  podmanPath?: string;
  /** Injectable spawn function for stdin piping. Defaults to child_process.spawn. */
  spawn?: SpawnFn;
}

// ---------------------------------------------------------------------------
// Podman state mapping
// ---------------------------------------------------------------------------

function mapPodmanStatus(status: string): ContainerState['status'] {
  switch (status) {
    case 'created':
    case 'configured':
      return 'created';
    case 'running':
    case 'paused':
      return 'running';
    case 'restarting':
      return 'starting';
    case 'removing':
    case 'stopping':
      return 'stopping';
    case 'exited':
      return 'stopped';
    case 'dead':
      return 'dead';
    default:
      return 'dead';
  }
}

function mapHealthStatus(health?: string): ContainerState['health'] {
  if (!health) return 'none';
  switch (health) {
    case 'healthy':
      return 'healthy';
    case 'unhealthy':
      return 'unhealthy';
    case 'starting':
      return 'starting';
    default:
      return 'none';
  }
}

// ---------------------------------------------------------------------------
// PodmanRuntime
// ---------------------------------------------------------------------------

export class PodmanRuntime implements ContainerRuntime {
  readonly name = 'podman' as const;

  private readonly exec: ExecFn;
  private readonly podmanPath: string;
  private readonly spawnFn: SpawnFn;

  constructor(options?: PodmanRuntimeOptions) {
    this.exec = options?.exec ?? defaultExec;
    this.podmanPath = options?.podmanPath ?? 'podman';
    this.spawnFn = options?.spawn ?? defaultSpawn;
  }

  // -----------------------------------------------------------------------
  // Availability
  // -----------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    try {
      await this.podman('info');
      return true;
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    // Podman is daemonless — version comes from the client binary
    const { stdout } = await this.podman('version', '--format', '{{.Client.Version}}');
    return `Podman ${stdout.trim()}`;
  }

  // -----------------------------------------------------------------------
  // Image lifecycle
  // -----------------------------------------------------------------------

  async pull(image: string): Promise<void> {
    await this.podman('pull', image);
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.podman('image', 'inspect', image);
      return true;
    } catch {
      return false;
    }
  }

  async loadImage(source: string): Promise<void> {
    await this.podman('load', '-i', source);
  }

  async build(options: ImageBuildOptions): Promise<string> {
    const args: string[] = ['build', '-t', options.tag];
    if (options.dockerfile) {
      args.push('-f', options.dockerfile);
    }
    if (options.buildArgs) {
      for (const [key, value] of Object.entries(options.buildArgs)) {
        args.push('--build-arg', `${key}=${value}`);
      }
    }
    if (options.labels) {
      for (const [key, value] of Object.entries(options.labels)) {
        args.push('--label', `${key}=${value}`);
      }
    }
    args.push(options.contextDir);
    await this.podman(...args);
    const { stdout: idOut } = await this.podman('images', '-q', options.tag);
    return idOut.trim();
  }

  async inspectLabels(image: string): Promise<Record<string, string>> {
    const { stdout } = await this.podman('inspect', '--format', '{{json .Config.Labels}}', image);
    const parsed = JSON.parse(stdout.trim());
    return parsed ?? {};
  }

  // -----------------------------------------------------------------------
  // Container lifecycle
  // -----------------------------------------------------------------------

  async run(options: ContainerRunOptions): Promise<ContainerHandle> {
    const name = options.name ?? `carapace-${Date.now()}`;

    if (options.stdinData !== undefined) {
      // Two-step create + start for stdin piping (credential injection)
      const createArgs = this.buildCreateArgs(options, name);
      const { stdout } = await this.podman(...createArgs);
      const id = stdout.trim();

      // Start container with stdin attached; pipe credentials
      const streams = this.spawnFn(this.podmanPath, ['start', '-ai', id], options.stdinData);

      return { id, name, runtime: this.name, stdout: streams.stdout, stderr: streams.stderr };
    }

    const args = this.buildRunArgs(options, name);
    const { stdout } = await this.podman(...args);
    const id = stdout.trim();

    return { id, name, runtime: this.name };
  }

  async stop(handle: ContainerHandle, timeout?: number): Promise<void> {
    if (timeout !== undefined) {
      await this.podman('stop', '-t', String(timeout), handle.id);
    } else {
      await this.podman('stop', handle.id);
    }
  }

  async kill(handle: ContainerHandle): Promise<void> {
    await this.podman('kill', handle.id);
  }

  async remove(handle: ContainerHandle): Promise<void> {
    await this.podman('rm', handle.id);
  }

  async inspect(handle: ContainerHandle): Promise<ContainerState> {
    const { stdout } = await this.podman('inspect', '--format', '{{json .State}}', handle.id);

    const raw = JSON.parse(stdout) as {
      Status: string;
      Running: boolean;
      Dead: boolean;
      ExitCode: number;
      StartedAt: string;
      FinishedAt: string;
      // Podman uses "Healthcheck" in some versions, "Health" in others
      Healthcheck?: { Status: string };
      Health?: { Status: string };
    };

    const status = mapPodmanStatus(raw.Status);
    const isTerminal = status === 'stopped' || status === 'dead';
    const healthRaw = raw.Healthcheck?.Status ?? raw.Health?.Status;

    return {
      status,
      exitCode: isTerminal ? raw.ExitCode : undefined,
      startedAt: raw.StartedAt !== CONTAINER_ZERO_TIME ? raw.StartedAt : undefined,
      finishedAt: raw.FinishedAt !== CONTAINER_ZERO_TIME ? raw.FinishedAt : undefined,
      health: mapHealthStatus(healthRaw),
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Build args for `podman create -i` (stdin piping via start -ai).
   * Same flags as buildRunArgs but uses `create -i` instead of `run -d`.
   */
  private buildCreateArgs(options: ContainerRunOptions, name: string): string[] {
    const args: string[] = ['create', '-i', '--name', name];
    this.appendCommonArgs(args, options);
    return args;
  }

  private buildRunArgs(options: ContainerRunOptions, name: string): string[] {
    const args: string[] = ['run', '-d', '--name', name];
    this.appendCommonArgs(args, options);
    return args;
  }

  /** Append Podman-specific flags: userns, network, volumes (:Z), env, user, ports, image. */
  private appendCommonArgs(args: string[], options: ContainerRunOptions): void {
    // Podman-specific: rootless UID mapping
    args.push('--userns=keep-id');

    if (options.readOnly) {
      args.push('--read-only');
    }

    if (options.network) {
      args.push('--network', options.network);
    } else if (options.networkDisabled) {
      args.push('--network', 'none');
    }

    // Podman-specific: :Z suffix for SELinux relabeling on all bind mounts
    for (const vol of options.volumes) {
      const suffix = vol.readonly ? ':ro,Z' : ':Z';
      args.push('-v', `${vol.source}:${vol.target}${suffix}`);
    }

    // Podman-specific: socket mounts also get :Z suffix
    for (const sock of options.socketMounts) {
      args.push('-v', `${sock.hostPath}:${sock.containerPath}:Z`);
    }

    for (const [key, value] of Object.entries(options.env)) {
      args.push('-e', `${key}=${value}`);
    }

    if (options.user) {
      args.push('--user', options.user);
    }

    for (const pm of options.portMappings ?? []) {
      const host = pm.hostAddress ?? '127.0.0.1';
      args.push('-p', `${host}:${pm.hostPort}:${pm.containerPort}`);
    }

    if (options.entrypoint && options.entrypoint.length > 0) {
      args.push('--entrypoint', options.entrypoint[0]!);
      args.push(options.image);
      args.push(...options.entrypoint.slice(1));
    } else {
      args.push(options.image);
    }
  }

  private async podman(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.exec(this.podmanPath, args);
  }
}
