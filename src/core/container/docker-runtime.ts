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

import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ContainerRuntime,
  ContainerRunOptions,
  ContainerHandle,
  ContainerState,
  ImageBuildOptions,
} from './runtime.js';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Exec function type (injectable for testing)
// ---------------------------------------------------------------------------

export type ExecFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Spawn function type for running a process with stdin data piped.
 *
 * Used by `docker start -ai` to pipe credentials to the container's stdin.
 * The spawn function should write stdinData to the child process's stdin
 * and detach without waiting for the process to exit.
 */
export type SpawnFn = (file: string, args: readonly string[], stdinData: string) => void;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DockerRuntimeOptions {
  /** Injectable exec function for testing. Defaults to promisified execFile. */
  exec?: ExecFn;
  /** Path to the docker binary. Defaults to `'docker'`. */
  dockerPath?: string;
  /** Injectable spawn function for stdin piping. Defaults to child_process.spawn. */
  spawn?: SpawnFn;
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
  private readonly spawnFn: SpawnFn;

  constructor(options?: DockerRuntimeOptions) {
    this.exec = options?.exec ?? defaultExec;
    this.dockerPath = options?.dockerPath ?? 'docker';
    this.spawnFn = options?.spawn ?? defaultSpawn;
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
    await this.docker(...args);
    const { stdout: idOut } = await this.docker('images', '-q', options.tag);
    return idOut.trim();
  }

  async inspectLabels(image: string): Promise<Record<string, string>> {
    const { stdout } = await this.docker('inspect', '--format', '{{json .Config.Labels}}', image);
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
      const { stdout } = await this.docker(...createArgs);
      const id = stdout.trim();

      // Start container with stdin attached; pipe credentials
      this.spawnFn(this.dockerPath, ['start', '-ai', id], options.stdinData);

      return { id, name, runtime: this.name };
    }

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

  /**
   * Build `docker create -i` args for stdin piping mode.
   * Same flags as buildRunArgs but uses `create -i` instead of `run -d`.
   */
  private buildCreateArgs(options: ContainerRunOptions, name: string): string[] {
    const args: string[] = ['create', '-i', '--name', name];

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
  const result = (await execFileAsync(file, [...args])) as {
    stdout: string | Buffer;
    stderr: string | Buffer;
  };
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : result.stdout.toString(),
    stderr: typeof result.stderr === 'string' ? result.stderr : result.stderr.toString(),
  };
};

/**
 * Default spawn function — uses child_process.spawn to run a process
 * with stdin data piped, then detaches without waiting for exit.
 */
const defaultSpawn: SpawnFn = (file, args, stdinData) => {
  const child = spawn(file, [...args], {
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: true,
  });
  child.stdin!.write(stdinData);
  child.stdin!.end();
  child.unref();
};
