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

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ContainerRuntime,
  ContainerRunOptions,
  ContainerHandle,
  ContainerState,
} from './runtime.js';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Exec function type (injectable for testing)
// ---------------------------------------------------------------------------

export type ExecFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PodmanRuntimeOptions {
  /** Injectable exec function for testing. Defaults to promisified execFile. */
  exec?: ExecFn;
  /** Path to the podman binary. Defaults to `'podman'`. */
  podmanPath?: string;
}

// ---------------------------------------------------------------------------
// Zero-value timestamp (shared with Docker)
// ---------------------------------------------------------------------------

const ZERO_TIME = '0001-01-01T00:00:00Z';

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

  constructor(options?: PodmanRuntimeOptions) {
    this.exec = options?.exec ?? defaultExec;
    this.podmanPath = options?.podmanPath ?? 'podman';
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

  // -----------------------------------------------------------------------
  // Container lifecycle
  // -----------------------------------------------------------------------

  async run(options: ContainerRunOptions): Promise<ContainerHandle> {
    const name = options.name ?? `carapace-${Date.now()}`;
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
      startedAt: raw.StartedAt !== ZERO_TIME ? raw.StartedAt : undefined,
      finishedAt: raw.FinishedAt !== ZERO_TIME ? raw.FinishedAt : undefined,
      health: mapHealthStatus(healthRaw),
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private buildRunArgs(options: ContainerRunOptions, name: string): string[] {
    const args: string[] = ['run', '-d', '--name', name];

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

    if (options.entrypoint && options.entrypoint.length > 0) {
      args.push('--entrypoint', options.entrypoint[0]);
      args.push(options.image);
      args.push(...options.entrypoint.slice(1));
    } else {
      args.push(options.image);
    }

    return args;
  }

  private async podman(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.exec(this.podmanPath, args);
  }
}

// ---------------------------------------------------------------------------
// Default exec (wraps child_process.execFile)
// ---------------------------------------------------------------------------

const defaultExec: ExecFn = async (file, args) => {
  const result = await execFileAsync(file, [...args]);
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : result.stdout.toString(),
    stderr: typeof result.stderr === 'string' ? result.stderr : result.stderr.toString(),
  };
};
