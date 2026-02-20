import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PodmanRuntime } from './podman-runtime.js';
import type { ContainerRuntime, ContainerRunOptions } from './runtime.js';

// ---------------------------------------------------------------------------
// Mock exec helper
// ---------------------------------------------------------------------------

type ExecCall = { file: string; args: readonly string[] };

function createMockExec() {
  const calls: ExecCall[] = [];
  const handler =
    vi.fn<(file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>();

  const exec = async (file: string, args: readonly string[]) => {
    calls.push({ file, args });
    return handler(file, args);
  };

  return { exec, handler, calls };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultRunOptions(overrides?: Partial<ContainerRunOptions>): ContainerRunOptions {
  return {
    image: 'carapace-agent:latest',
    readOnly: true,
    networkDisabled: true,
    volumes: [],
    socketMounts: [],
    env: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PodmanRuntime', () => {
  let mock: ReturnType<typeof createMockExec>;
  let runtime: PodmanRuntime;

  beforeEach(() => {
    mock = createMockExec();
    runtime = new PodmanRuntime({ exec: mock.exec });
  });

  // -----------------------------------------------------------------------
  // Type compatibility
  // -----------------------------------------------------------------------

  it('implements the ContainerRuntime interface', () => {
    const _rt: ContainerRuntime = runtime;
    expect(_rt).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // name
  // -----------------------------------------------------------------------

  describe('name', () => {
    it('is "podman"', () => {
      expect(runtime.name).toBe('podman');
    });
  });

  // -----------------------------------------------------------------------
  // isAvailable
  // -----------------------------------------------------------------------

  describe('isAvailable', () => {
    it('returns true when podman info succeeds', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'info output', stderr: '' });
      expect(await runtime.isAvailable()).toBe(true);
      expect(mock.calls[0].args).toEqual(['info']);
    });

    it('returns false when podman info fails', async () => {
      mock.handler.mockRejectedValueOnce(new Error('Cannot connect to Podman'));
      expect(await runtime.isAvailable()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // version
  // -----------------------------------------------------------------------

  describe('version', () => {
    it('returns the Podman version string', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '5.3.1\n', stderr: '' });
      const v = await runtime.version();
      expect(v).toBe('Podman 5.3.1');
      expect(mock.calls[0].args).toEqual(['version', '--format', '{{.Client.Version}}']);
    });

    it('trims whitespace from version output', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '  4.9.0  \n', stderr: '' });
      expect(await runtime.version()).toBe('Podman 4.9.0');
    });

    it('throws when podman is not available', async () => {
      mock.handler.mockRejectedValueOnce(new Error('not found'));
      await expect(runtime.version()).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // pull
  // -----------------------------------------------------------------------

  describe('pull', () => {
    it('calls podman pull with the image', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.pull('carapace-agent:v1');
      expect(mock.calls[0].args).toEqual(['pull', 'carapace-agent:v1']);
    });

    it('throws on pull failure', async () => {
      mock.handler.mockRejectedValueOnce(new Error('pull access denied'));
      await expect(runtime.pull('private:latest')).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // imageExists
  // -----------------------------------------------------------------------

  describe('imageExists', () => {
    it('returns true when podman image inspect succeeds', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '[{}]', stderr: '' });
      expect(await runtime.imageExists('carapace-agent:latest')).toBe(true);
      expect(mock.calls[0].args).toEqual(['image', 'inspect', 'carapace-agent:latest']);
    });

    it('returns false when podman image inspect fails', async () => {
      mock.handler.mockRejectedValueOnce(new Error('No such image'));
      expect(await runtime.imageExists('nonexistent:latest')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // loadImage
  // -----------------------------------------------------------------------

  describe('loadImage', () => {
    it('calls podman load with the source path', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'Loaded image', stderr: '' });
      await runtime.loadImage('/nix/store/abc-image.tar.gz');
      expect(mock.calls[0].args).toEqual(['load', '-i', '/nix/store/abc-image.tar.gz']);
    });

    it('throws on load failure', async () => {
      mock.handler.mockRejectedValueOnce(new Error('invalid tar'));
      await expect(runtime.loadImage('/bad.tar')).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // run — Podman-specific behavior
  // -----------------------------------------------------------------------

  describe('run', () => {
    it('returns a ContainerHandle with the container ID', async () => {
      const containerId = 'abc123def456';
      mock.handler.mockResolvedValueOnce({ stdout: `${containerId}\n`, stderr: '' });

      const handle = await runtime.run(defaultRunOptions({ name: 'my-agent' }));

      expect(handle.id).toBe(containerId);
      expect(handle.name).toBe('my-agent');
      expect(handle.runtime).toBe('podman');
    });

    it('generates a name when none is provided', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });
      const handle = await runtime.run(defaultRunOptions());
      expect(handle.name).toBeDefined();
      expect(handle.name.length).toBeGreaterThan(0);
    });

    it('passes --read-only when readOnly is true', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(defaultRunOptions({ readOnly: true }));
      expect(mock.calls[0].args).toContain('--read-only');
    });

    it('omits --read-only when readOnly is false', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(defaultRunOptions({ readOnly: false }));
      expect(mock.calls[0].args).not.toContain('--read-only');
    });

    it('passes --network none when networkDisabled is true', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(defaultRunOptions({ networkDisabled: true }));
      const args = mock.calls[0].args;
      const netIdx = args.indexOf('--network');
      expect(netIdx).toBeGreaterThan(-1);
      expect(args[netIdx + 1]).toBe('none');
    });

    it('omits --network none when networkDisabled is false', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(defaultRunOptions({ networkDisabled: false }));
      expect(mock.calls[0].args).not.toContain('--network');
    });

    it('passes --network with named network when specified', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({ networkDisabled: false, network: 'carapace-restricted' }),
      );
      const args = mock.calls[0].args;
      const netIdx = args.indexOf('--network');
      expect(netIdx).toBeGreaterThan(-1);
      expect(args[netIdx + 1]).toBe('carapace-restricted');
    });

    it('named network takes precedence over networkDisabled', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({ networkDisabled: true, network: 'carapace-restricted' }),
      );
      const args = mock.calls[0].args;
      const netIdx = args.indexOf('--network');
      expect(netIdx).toBeGreaterThan(-1);
      expect(args[netIdx + 1]).toBe('carapace-restricted');
    });

    // Podman-specific: :Z suffix for SELinux
    it('appends :Z suffix to volume mounts for SELinux relabeling', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({
          volumes: [
            { source: '/host/workspace', target: '/workspace', readonly: false },
            { source: '/host/config', target: '/etc/cfg', readonly: true },
          ],
        }),
      );
      const args = mock.calls[0].args;
      expect(args).toContain('/host/workspace:/workspace:Z');
      expect(args).toContain('/host/config:/etc/cfg:ro,Z');
    });

    // Podman-specific: :Z suffix on socket mounts
    it('appends :Z suffix to socket mounts for SELinux relabeling', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({
          socketMounts: [{ hostPath: '/run/zmq.sock', containerPath: '/sockets/zmq.sock' }],
        }),
      );
      expect(mock.calls[0].args).toContain('/run/zmq.sock:/sockets/zmq.sock:Z');
    });

    // Podman-specific: --userns=keep-id for rootless
    it('passes --userns=keep-id for rootless UID mapping', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(defaultRunOptions());
      expect(mock.calls[0].args).toContain('--userns=keep-id');
    });

    it('passes environment variables with -e flags', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({
          env: { NODE_ENV: 'production', LOG_LEVEL: 'debug' },
        }),
      );
      const args = mock.calls[0].args;
      expect(args).toContain('NODE_ENV=production');
      expect(args).toContain('LOG_LEVEL=debug');
    });

    it('passes --user when user is provided', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(defaultRunOptions({ user: '1000:1000' }));
      const args = mock.calls[0].args;
      const userIdx = args.indexOf('--user');
      expect(userIdx).toBeGreaterThan(-1);
      expect(args[userIdx + 1]).toBe('1000:1000');
    });

    it('passes --entrypoint and trailing args', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({
          entrypoint: ['/bin/sh', '-c', 'echo hello'],
        }),
      );
      const args = mock.calls[0].args;
      const epIdx = args.indexOf('--entrypoint');
      expect(epIdx).toBeGreaterThan(-1);
      expect(args[epIdx + 1]).toBe('/bin/sh');
      const imageIdx = args.indexOf('carapace-agent:latest');
      expect(imageIdx).toBeGreaterThan(epIdx);
      expect(args[imageIdx + 1]).toBe('-c');
      expect(args[imageIdx + 2]).toBe('echo hello');
    });

    it('throws on run failure', async () => {
      mock.handler.mockRejectedValueOnce(new Error('image not found'));
      await expect(runtime.run(defaultRunOptions())).rejects.toThrow();
    });

    it('starts with podman run -d', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(defaultRunOptions());
      expect(mock.calls[0].args[0]).toBe('run');
      expect(mock.calls[0].args[1]).toBe('-d');
    });
  });

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  describe('stop', () => {
    it('calls podman stop with the container ID', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.stop({ id: 'abc123', name: 'test', runtime: 'podman' });
      expect(mock.calls[0].args).toEqual(['stop', 'abc123']);
    });

    it('passes -t flag when timeout is provided', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.stop({ id: 'abc123', name: 'test', runtime: 'podman' }, 5);
      expect(mock.calls[0].args).toEqual(['stop', '-t', '5', 'abc123']);
    });

    it('throws on stop failure', async () => {
      mock.handler.mockRejectedValueOnce(new Error('no such container'));
      await expect(runtime.stop({ id: 'bad', name: 'test', runtime: 'podman' })).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // kill
  // -----------------------------------------------------------------------

  describe('kill', () => {
    it('calls podman kill with the container ID', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.kill({ id: 'abc123', name: 'test', runtime: 'podman' });
      expect(mock.calls[0].args).toEqual(['kill', 'abc123']);
    });

    it('throws on kill failure', async () => {
      mock.handler.mockRejectedValueOnce(new Error('not running'));
      await expect(runtime.kill({ id: 'bad', name: 'test', runtime: 'podman' })).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // remove
  // -----------------------------------------------------------------------

  describe('remove', () => {
    it('calls podman rm with the container ID', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.remove({ id: 'abc123', name: 'test', runtime: 'podman' });
      expect(mock.calls[0].args).toEqual(['rm', 'abc123']);
    });

    it('throws on remove failure', async () => {
      mock.handler.mockRejectedValueOnce(new Error('container running'));
      await expect(
        runtime.remove({ id: 'bad', name: 'test', runtime: 'podman' }),
      ).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // inspect — Podman-specific format differences
  // -----------------------------------------------------------------------

  describe('inspect', () => {
    it('parses a running container state', async () => {
      mock.handler.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Status: 'running',
          Running: true,
          Dead: false,
          ExitCode: 0,
          StartedAt: '2026-01-15T10:30:00.000000000Z',
          FinishedAt: '0001-01-01T00:00:00Z',
        }),
        stderr: '',
      });

      const state = await runtime.inspect({
        id: 'abc123',
        name: 'test',
        runtime: 'podman',
      });

      expect(state.status).toBe('running');
      expect(state.startedAt).toBe('2026-01-15T10:30:00.000000000Z');
      expect(state.exitCode).toBeUndefined();
    });

    it('parses a stopped (exited) container state', async () => {
      mock.handler.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Status: 'exited',
          Running: false,
          Dead: false,
          ExitCode: 0,
          StartedAt: '2026-01-15T10:30:00.000Z',
          FinishedAt: '2026-01-15T11:00:00.000Z',
        }),
        stderr: '',
      });

      const state = await runtime.inspect({
        id: 'abc123',
        name: 'test',
        runtime: 'podman',
      });

      expect(state.status).toBe('stopped');
      expect(state.exitCode).toBe(0);
      expect(state.finishedAt).toBe('2026-01-15T11:00:00.000Z');
    });

    it('parses a dead container state', async () => {
      mock.handler.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Status: 'dead',
          Running: false,
          Dead: true,
          ExitCode: 137,
          StartedAt: '2026-01-15T10:30:00.000Z',
          FinishedAt: '2026-01-15T10:31:00.000Z',
        }),
        stderr: '',
      });

      const state = await runtime.inspect({
        id: 'abc123',
        name: 'test',
        runtime: 'podman',
      });

      expect(state.status).toBe('dead');
      expect(state.exitCode).toBe(137);
    });

    // Podman-specific: uses Healthcheck instead of Health
    it('reads health from Podman Healthcheck field', async () => {
      mock.handler.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Status: 'running',
          Running: true,
          Dead: false,
          ExitCode: 0,
          StartedAt: '2026-01-15T10:30:00.000Z',
          FinishedAt: '0001-01-01T00:00:00Z',
          Healthcheck: { Status: 'healthy' },
        }),
        stderr: '',
      });

      const state = await runtime.inspect({
        id: 'abc123',
        name: 'test',
        runtime: 'podman',
      });

      expect(state.health).toBe('healthy');
    });

    // Podman-specific: also supports Health field for newer versions
    it('falls back to Health field when Healthcheck is absent', async () => {
      mock.handler.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Status: 'running',
          Running: true,
          Dead: false,
          ExitCode: 0,
          StartedAt: '2026-01-15T10:30:00.000Z',
          FinishedAt: '0001-01-01T00:00:00Z',
          Health: { Status: 'unhealthy' },
        }),
        stderr: '',
      });

      const state = await runtime.inspect({
        id: 'abc123',
        name: 'test',
        runtime: 'podman',
      });

      expect(state.health).toBe('unhealthy');
    });

    it('sets health to "none" when no health check exists', async () => {
      mock.handler.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Status: 'running',
          Running: true,
          Dead: false,
          ExitCode: 0,
          StartedAt: '2026-01-15T10:30:00.000Z',
          FinishedAt: '0001-01-01T00:00:00Z',
        }),
        stderr: '',
      });

      const state = await runtime.inspect({
        id: 'abc123',
        name: 'test',
        runtime: 'podman',
      });

      expect(state.health).toBe('none');
    });

    it('uses podman inspect --format for State JSON', async () => {
      mock.handler.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Status: 'running',
          Running: true,
          Dead: false,
          ExitCode: 0,
          StartedAt: '2026-01-15T10:30:00.000Z',
          FinishedAt: '0001-01-01T00:00:00Z',
        }),
        stderr: '',
      });

      await runtime.inspect({ id: 'abc123', name: 'test', runtime: 'podman' });

      expect(mock.calls[0].args).toEqual(['inspect', '--format', '{{json .State}}', 'abc123']);
    });

    it('throws for a non-existent container', async () => {
      mock.handler.mockRejectedValueOnce(new Error('No such container'));
      await expect(
        runtime.inspect({ id: 'bad', name: 'test', runtime: 'podman' }),
      ).rejects.toThrow();
    });

    it('omits startedAt for zero-value timestamps', async () => {
      mock.handler.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Status: 'created',
          Running: false,
          Dead: false,
          ExitCode: 0,
          StartedAt: '0001-01-01T00:00:00Z',
          FinishedAt: '0001-01-01T00:00:00Z',
        }),
        stderr: '',
      });

      const state = await runtime.inspect({
        id: 'abc123',
        name: 'test',
        runtime: 'podman',
      });

      expect(state.startedAt).toBeUndefined();
      expect(state.finishedAt).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // build
  // -----------------------------------------------------------------------

  describe('build', () => {
    it('builds with just tag and contextDir', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'build output\n', stderr: '' });
      mock.handler.mockResolvedValueOnce({ stdout: 'sha256:abc123\n', stderr: '' });

      const id = await runtime.build({ tag: 'carapace:latest', contextDir: '/src' });

      expect(id).toBe('sha256:abc123');
      expect(mock.calls[0].args).toEqual(['build', '-t', 'carapace:latest', '/src']);
      expect(mock.calls[1].args).toEqual(['images', '-q', 'carapace:latest']);
    });

    it('builds with dockerfile, buildArgs, and labels', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      mock.handler.mockResolvedValueOnce({ stdout: 'sha256:def456\n', stderr: '' });

      const id = await runtime.build({
        tag: 'carapace:v2',
        contextDir: '/project',
        dockerfile: 'Dockerfile.prod',
        buildArgs: { NODE_ENV: 'production', VERSION: '2.0' },
        labels: { 'org.opencontainers.image.version': '2.0', 'com.carapace.commit': 'abc' },
      });

      expect(id).toBe('sha256:def456');
      const args = mock.calls[0].args;
      expect(args).toContain('-f');
      expect(args[args.indexOf('-f') + 1]).toBe('Dockerfile.prod');
      expect(args).toContain('--build-arg');
      expect(args).toContain('NODE_ENV=production');
      expect(args).toContain('VERSION=2.0');
      expect(args).toContain('--label');
      expect(args).toContain('org.opencontainers.image.version=2.0');
      expect(args).toContain('com.carapace.commit=abc');
      expect(args[args.length - 1]).toBe('/project');
    });

    it('throws on build failure', async () => {
      mock.handler.mockRejectedValueOnce(new Error('build failed'));
      await expect(runtime.build({ tag: 'bad:latest', contextDir: '/src' })).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // inspectLabels
  // -----------------------------------------------------------------------

  describe('inspectLabels', () => {
    it('returns parsed labels', async () => {
      mock.handler.mockResolvedValueOnce({
        stdout: JSON.stringify({ 'com.carapace.version': '1.0', 'com.carapace.commit': 'abc123' }),
        stderr: '',
      });

      const labels = await runtime.inspectLabels('carapace:latest');

      expect(labels).toEqual({ 'com.carapace.version': '1.0', 'com.carapace.commit': 'abc123' });
      expect(mock.calls[0].args).toEqual([
        'inspect',
        '--format',
        '{{json .Config.Labels}}',
        'carapace:latest',
      ]);
    });

    it('returns empty object when no labels', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'null', stderr: '' });

      const labels = await runtime.inspectLabels('carapace:latest');

      expect(labels).toEqual({});
    });

    it('throws for a non-existent image', async () => {
      mock.handler.mockRejectedValueOnce(new Error('No such image'));
      await expect(runtime.inspectLabels('nonexistent:latest')).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Custom podman path
  // -----------------------------------------------------------------------

  describe('custom podman path', () => {
    it('uses the provided podmanPath', async () => {
      const custom = new PodmanRuntime({
        exec: mock.exec,
        podmanPath: '/usr/local/bin/podman',
      });
      mock.handler.mockResolvedValueOnce({ stdout: 'info', stderr: '' });
      await custom.isAvailable();
      expect(mock.calls[0].file).toBe('/usr/local/bin/podman');
    });

    it('defaults to "podman"', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'info', stderr: '' });
      await runtime.isAvailable();
      expect(mock.calls[0].file).toBe('podman');
    });
  });
});
