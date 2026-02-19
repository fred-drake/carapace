/**
 * Docker container runtime adapter.
 *
 * Reference implementation of {@link ContainerRuntime} using the Docker CLI
 * via `child_process.execFile`. No Docker SDK dependency — just shell out
 * to the `docker` binary.
 *
 * Adapter behavior (Docker-specific):
 * - Standard bind mount semantics, no special suffixes needed.
 * - `--read-only` flag for read-only root filesystem.
 * - `--network none` for network isolation.
 * - Socket mounts are regular bind mounts (`-v host:container`).
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

export interface DockerRuntimeOptions {
  /** Injectable exec function for testing. Defaults to promisified execFile. */
  exec?: ExecFn;
  /** Path to the docker binary. Defaults to `'docker'`. */
  dockerPath?: string;
}

// ---------------------------------------------------------------------------
// Docker zero-value timestamp
// ---------------------------------------------------------------------------

const DOCKER_ZERO_TIME = '0001-01-01T00:00:00Z';

// ---------------------------------------------------------------------------
// Docker state mapping
// ---------------------------------------------------------------------------

function mapDockerStatus(status: string): ContainerState['status'] {
  switch (status) {
    case 'created':
      return 'created';
    case 'running':
    case 'paused':
      return 'running';
    case 'restarting':
      return 'starting';
    case 'removing':
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
// DockerRuntime
// ---------------------------------------------------------------------------

export class DockerRuntime implements ContainerRuntime {
  readonly name = 'docker' as const;

  private readonly exec: ExecFn;
  private readonly dockerPath: string;

  constructor(options?: DockerRuntimeOptions) {
    this.exec = options?.exec ?? defaultExec;
    this.dockerPath = options?.dockerPath ?? 'docker';
  }

  // -----------------------------------------------------------------------
  // Availability
  // -----------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    try {
      await this.docker('info');
      return true;
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    const { stdout } = await this.docker('version', '--format', '{{.Server.Version}}');
    return `Docker ${stdout.trim()}`;
  }

  // -----------------------------------------------------------------------
  // Image lifecycle
  // -----------------------------------------------------------------------

  async pull(image: string): Promise<void> {
    await this.docker('pull', image);
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.docker('image', 'inspect', image);
      return true;
    } catch {
      return false;
    }
  }

  async loadImage(source: string): Promise<void> {
    await this.docker('load', '-i', source);
  }

  // -----------------------------------------------------------------------
  // Container lifecycle
  // -----------------------------------------------------------------------

  async run(options: ContainerRunOptions): Promise<ContainerHandle> {
    const name = options.name ?? `carapace-${Date.now()}`;
    const args = this.buildRunArgs(options, name);
    const { stdout } = await this.docker(...args);
    const id = stdout.trim();

    return { id, name, runtime: this.name };
  }

  async stop(handle: ContainerHandle, timeout?: number): Promise<void> {
    if (timeout !== undefined) {
      await this.docker('stop', '-t', String(timeout), handle.id);
    } else {
      await this.docker('stop', handle.id);
    }
  }

  async kill(handle: ContainerHandle): Promise<void> {
    await this.docker('kill', handle.id);
  }

  async remove(handle: ContainerHandle): Promise<void> {
    await this.docker('rm', handle.id);
  }

  async inspect(handle: ContainerHandle): Promise<ContainerState> {
    const { stdout } = await this.docker('inspect', '--format', '{{json .State}}', handle.id);

    const raw = JSON.parse(stdout) as {
      Status: string;
      Running: boolean;
      Dead: boolean;
      ExitCode: number;
      StartedAt: string;
      FinishedAt: string;
      Health?: { Status: string };
    };

    const status = mapDockerStatus(raw.Status);
    const isTerminal = status === 'stopped' || status === 'dead';

    return {
      status,
      exitCode: isTerminal ? raw.ExitCode : undefined,
      startedAt: raw.StartedAt !== DOCKER_ZERO_TIME ? raw.StartedAt : undefined,
      finishedAt: raw.FinishedAt !== DOCKER_ZERO_TIME ? raw.FinishedAt : undefined,
      health: mapHealthStatus(raw.Health?.Status),
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private buildRunArgs(options: ContainerRunOptions, name: string): string[] {
    const args: string[] = ['run', '-d', '--name', name];

    if (options.readOnly) {
      args.push('--read-only');
    }

    if (options.network) {
      args.push('--network', options.network);
    } else if (options.networkDisabled) {
      args.push('--network', 'none');
    }

    for (const vol of options.volumes) {
      const suffix = vol.readonly ? ':ro' : '';
      args.push('-v', `${vol.source}:${vol.target}${suffix}`);
    }

    // Docker: socket mounts are regular bind mounts
    for (const sock of options.socketMounts) {
      args.push('-v', `${sock.hostPath}:${sock.containerPath}`);
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

  private async docker(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.exec(this.dockerPath, args);
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
