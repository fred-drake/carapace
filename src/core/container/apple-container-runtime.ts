/**
 * Apple Container runtime adapter (**experimental**).
 *
 * Implements {@link ContainerRuntime} using the macOS 26+ `container` CLI.
 * Apple Silicon only. This adapter is experimental — Apple Containers is new
 * and the API surface may evolve with macOS updates.
 *
 * Key differences from Docker/Podman:
 * - **vsock for socket sharing**: Uses `--publish-socket` to expose host
 *   sockets via virtio socket (vsock). This bypasses the network stack
 *   entirely — superior latency and isolation compared to bind-mounted
 *   Unix sockets used by Docker and Podman.
 * - **Read-only filesystem is the default**: No `--read-only` flag needed.
 *   Writable mounts must be explicitly declared.
 * - **VM-per-container isolation**: Each container runs in its own
 *   lightweight VM, matching the architecture doc's security model.
 * - **No SELinux relabeling**: macOS doesn't use SELinux, so no `:Z` suffix.
 */

import { execFile as execFileCb } from 'node:child_process';
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

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AppleContainerRuntimeOptions {
  /** Injectable exec function for testing. Defaults to promisified execFile. */
  exec?: ExecFn;
  /** Path to the container binary. Defaults to `'container'`. */
  containerPath?: string;
}

// ---------------------------------------------------------------------------
// Zero-value timestamp
// ---------------------------------------------------------------------------

const ZERO_TIME = '0001-01-01T00:00:00Z';

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapStatus(status: string): ContainerState['status'] {
  switch (status) {
    case 'created':
      return 'created';
    case 'running':
      return 'running';
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

// ---------------------------------------------------------------------------
// AppleContainerRuntime
// ---------------------------------------------------------------------------

export class AppleContainerRuntime implements ContainerRuntime {
  readonly name = 'apple-container' as const;

  /**
   * Apple Containers is new (macOS 26+) and the API surface may evolve.
   * This flag signals to callers that the adapter is not yet stable.
   */
  readonly experimental = true;

  private readonly exec: ExecFn;
  private readonly containerPath: string;

  constructor(options?: AppleContainerRuntimeOptions) {
    this.exec = options?.exec ?? defaultExec;
    this.containerPath = options?.containerPath ?? 'container';
  }

  // -----------------------------------------------------------------------
  // Availability
  // -----------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    try {
      await this.container('list');
      return true;
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    const { stdout } = await this.container('--version');
    return `Apple Containers ${stdout.trim()}`;
  }

  // -----------------------------------------------------------------------
  // Image lifecycle
  // -----------------------------------------------------------------------

  async pull(image: string): Promise<void> {
    await this.container('pull', image);
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.container('image', 'inspect', image);
      return true;
    } catch {
      return false;
    }
  }

  async loadImage(source: string): Promise<void> {
    await this.container('load', '-i', source);
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
    await this.container(...args);
    const { stdout: idOut } = await this.container('images', '-q', options.tag);
    return idOut.trim();
  }

  async inspectLabels(image: string): Promise<Record<string, string>> {
    const { stdout } = await this.container(
      'inspect',
      '--format',
      '{{json .Config.Labels}}',
      image,
    );
    const parsed = JSON.parse(stdout.trim());
    return parsed ?? {};
  }

  // -----------------------------------------------------------------------
  // Container lifecycle
  // -----------------------------------------------------------------------

  async run(options: ContainerRunOptions): Promise<ContainerHandle> {
    const name = options.name ?? `carapace-${Date.now()}`;
    const args = this.buildRunArgs(options, name);
    const { stdout } = await this.container(...args);
    const id = stdout.trim();

    return { id, name, runtime: this.name };
  }

  async stop(handle: ContainerHandle, timeout?: number): Promise<void> {
    if (timeout !== undefined) {
      await this.container('stop', '-t', String(timeout), handle.id);
    } else {
      await this.container('stop', handle.id);
    }
  }

  async kill(handle: ContainerHandle): Promise<void> {
    await this.container('kill', handle.id);
  }

  async remove(handle: ContainerHandle): Promise<void> {
    await this.container('rm', handle.id);
  }

  async inspect(handle: ContainerHandle): Promise<ContainerState> {
    const { stdout } = await this.container('inspect', '--format', '{{json .State}}', handle.id);

    const raw = JSON.parse(stdout) as {
      Status: string;
      Running: boolean;
      Dead: boolean;
      ExitCode: number;
      StartedAt: string;
      FinishedAt: string;
    };

    const status = mapStatus(raw.Status);
    const isTerminal = status === 'stopped' || status === 'dead';

    return {
      status,
      exitCode: isTerminal ? raw.ExitCode : undefined,
      startedAt: raw.StartedAt !== ZERO_TIME ? raw.StartedAt : undefined,
      finishedAt: raw.FinishedAt !== ZERO_TIME ? raw.FinishedAt : undefined,
      health: 'none',
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private buildRunArgs(options: ContainerRunOptions, name: string): string[] {
    const args: string[] = ['run', '-d', '--name', name];

    // Apple Containers: read-only filesystem is the default.
    // No --read-only flag needed — the runtime enforces it natively.
    // Writable mounts are declared explicitly via -v without :ro.

    if (options.network) {
      args.push('--network', options.network);
    } else if (options.networkDisabled) {
      args.push('--network', 'none');
    }

    for (const vol of options.volumes) {
      const suffix = vol.readonly ? ':ro' : '';
      args.push('-v', `${vol.source}:${vol.target}${suffix}`);
    }

    // Apple Containers: --publish-socket for vsock transport.
    // This bypasses the network stack entirely — the host socket is
    // forwarded into the VM via virtio socket, giving lower latency
    // and stronger isolation than Docker's bind-mount approach.
    for (const sock of options.socketMounts) {
      args.push('--publish-socket', `${sock.hostPath}:${sock.containerPath}`);
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

  private async container(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.exec(this.containerPath, args);
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
