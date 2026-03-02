/**
 * Apple Container runtime adapter (**experimental**).
 *
 * Implements {@link ContainerRuntime} using the macOS 26+ `container` CLI.
 * Apple Silicon only. This adapter is experimental — Apple Containers is new
 * and the API surface may evolve with macOS updates.
 *
 * Key differences from Docker/Podman:
 * - **Bind-mount for socket sharing**: Uses `-v` bind mounts for host
 *   sockets (same as Docker/Podman). `--publish-socket` publishes
 *   container sockets TO the host (opposite direction) and is not
 *   suitable for making existing host sockets accessible to containers.
 * - **Read-only filesystem is the default**: No `--read-only` flag needed.
 *   Writable mounts must be explicitly declared.
 * - **VM-per-container isolation**: Each container runs in its own
 *   lightweight VM, matching the architecture doc's security model.
 * - **No SELinux relabeling**: macOS doesn't use SELinux, so no `:Z` suffix.
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

export interface AppleContainerRuntimeOptions {
  /** Injectable exec function for testing. Defaults to promisified execFile. */
  exec?: ExecFn;
  /** Path to the container binary. Defaults to `'container'`. */
  containerPath?: string;
  /** Injectable spawn function for stdin piping. Defaults to child_process.spawn. */
  spawn?: SpawnFn;
}

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
  private readonly spawnFn: SpawnFn;

  constructor(options?: AppleContainerRuntimeOptions) {
    this.exec = options?.exec ?? defaultExec;
    this.containerPath = options?.containerPath ?? 'container';
    this.spawnFn = options?.spawn ?? defaultSpawn;
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
    // Apple Containers builder VM needs explicit DNS servers for network
    // access during multi-stage builds (e.g. npm install, apt-get).
    args.push('--dns', '1.1.1.1', '--dns', '8.8.8.8');
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
    // Use 'container image inspect' to get the image digest
    const { stdout: inspectOut } = await this.container('image', 'inspect', options.tag);
    const inspected = JSON.parse(inspectOut.trim());
    const digest = inspected?.[0]?.index?.digest ?? '';
    return digest;
  }

  async inspectLabels(image: string): Promise<Record<string, string>> {
    const { stdout } = await this.container('image', 'inspect', image);
    const inspected = JSON.parse(stdout.trim());
    // Labels are in variants[0].config.config.Labels
    const labels = inspected?.[0]?.variants?.[0]?.config?.config?.Labels;
    return labels ?? {};
  }

  // -----------------------------------------------------------------------
  // Container lifecycle
  // -----------------------------------------------------------------------

  async run(options: ContainerRunOptions): Promise<ContainerHandle> {
    const name = options.name ?? `carapace-${Date.now()}`;

    if (options.stdinData !== undefined) {
      // Two-step create + start for stdin piping (credential injection)
      const createArgs = this.buildCreateArgs(options, name);
      const { stdout } = await this.container(...createArgs);
      const id = stdout.trim();

      // Start container with stdin attached; pipe credentials
      const streams = this.spawnFn(this.containerPath, ['start', '-ai', id], options.stdinData);

      return { id, name, runtime: this.name, stdout: streams.stdout, stderr: streams.stderr };
    }

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
      startedAt: raw.StartedAt !== CONTAINER_ZERO_TIME ? raw.StartedAt : undefined,
      finishedAt: raw.FinishedAt !== CONTAINER_ZERO_TIME ? raw.FinishedAt : undefined,
      health: 'none',
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Build args for `container create -i` (stdin piping via start -ai).
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

  /** Append network, volumes, socket mounts, env, user, and image args. */
  private appendCommonArgs(args: string[], options: ContainerRunOptions): void {
    // Apple Containers: --read-only flag supported
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

    // Bind-mount host sockets into the container via -v.
    for (const sock of options.socketMounts) {
      args.push('-v', `${sock.hostPath}:${sock.containerPath}`);
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

  private async container(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.exec(this.containerPath, args);
  }
}
