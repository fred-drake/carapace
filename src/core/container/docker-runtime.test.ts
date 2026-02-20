import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DockerRuntime } from './docker-runtime.js';
import type { SpawnFn } from './docker-runtime.js';
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

describe('DockerRuntime', () => {
  let mock: ReturnType<typeof createMockExec>;
  let runtime: DockerRuntime;

  beforeEach(() => {
    mock = createMockExec();
    runtime = new DockerRuntime({ exec: mock.exec });
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
    it('is "docker"', () => {
      expect(runtime.name).toBe('docker');
    });
  });

  // -----------------------------------------------------------------------
  // isAvailable
  // -----------------------------------------------------------------------

  describe('isAvailable', () => {
    it('returns true when docker info succeeds', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'info output', stderr: '' });
      expect(await runtime.isAvailable()).toBe(true);
      expect(mock.calls[0].args).toEqual(['info']);
    });

    it('returns false when docker info fails', async () => {
      mock.handler.mockRejectedValueOnce(new Error('Cannot connect to Docker daemon'));
      expect(await runtime.isAvailable()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // version
  // -----------------------------------------------------------------------

  describe('version', () => {
    it('returns the Docker version string', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '27.5.1\n', stderr: '' });
      const v = await runtime.version();
      expect(v).toBe('Docker 27.5.1');
      expect(mock.calls[0].args).toEqual(['version', '--format', '{{.Server.Version}}']);
    });

    it('trims whitespace from version output', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '  25.0.0  \n', stderr: '' });
      expect(await runtime.version()).toBe('Docker 25.0.0');
    });

    it('throws when docker is not available', async () => {
      mock.handler.mockRejectedValueOnce(new Error('not found'));
      await expect(runtime.version()).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // pull
  // -----------------------------------------------------------------------

  describe('pull', () => {
    it('calls docker pull with the image', async () => {
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
    it('returns true when docker image inspect succeeds', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '[{}]', stderr: '' });
      expect(await runtime.imageExists('carapace-agent:latest')).toBe(true);
      expect(mock.calls[0].args).toEqual(['image', 'inspect', 'carapace-agent:latest']);
    });

    it('returns false when docker image inspect fails', async () => {
      mock.handler.mockRejectedValueOnce(new Error('No such image'));
      expect(await runtime.imageExists('nonexistent:latest')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // loadImage
  // -----------------------------------------------------------------------

  describe('loadImage', () => {
    it('calls docker load with the source path', async () => {
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
  // run
  // -----------------------------------------------------------------------

  describe('run', () => {
    it('returns a ContainerHandle with the container ID', async () => {
      const containerId = 'abc123def456';
      mock.handler.mockResolvedValueOnce({ stdout: `${containerId}\n`, stderr: '' });

      const handle = await runtime.run(defaultRunOptions({ name: 'my-agent' }));

      expect(handle.id).toBe(containerId);
      expect(handle.name).toBe('my-agent');
      expect(handle.runtime).toBe('docker');
    });

    it('generates a name when none is provided', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });
      const handle = await runtime.run(defaultRunOptions());
      // Should pass some --name flag
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

    it('maps volume mounts to -v flags', async () => {
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
      expect(args).toContain('/host/workspace:/workspace');
      expect(args).toContain('/host/config:/etc/cfg:ro');
    });

    it('maps socket mounts to -v flags (Docker bind mount)', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'id\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({
          socketMounts: [{ hostPath: '/run/zmq.sock', containerPath: '/sockets/zmq.sock' }],
        }),
      );
      expect(mock.calls[0].args).toContain('/run/zmq.sock:/sockets/zmq.sock');
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
      // Image comes next, then remaining entrypoint args
      const imageIdx = args.indexOf('carapace-agent:latest');
      expect(imageIdx).toBeGreaterThan(epIdx);
      expect(args[imageIdx + 1]).toBe('-c');
      expect(args[imageIdx + 2]).toBe('echo hello');
    });

    it('throws on run failure', async () => {
      mock.handler.mockRejectedValueOnce(new Error('image not found'));
      await expect(runtime.run(defaultRunOptions())).rejects.toThrow();
    });

    it('starts with docker run -d', async () => {
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
    it('calls docker stop with the container ID', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.stop({ id: 'abc123', name: 'test', runtime: 'docker' });
      expect(mock.calls[0].args).toEqual(['stop', 'abc123']);
    });

    it('passes -t flag when timeout is provided', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.stop({ id: 'abc123', name: 'test', runtime: 'docker' }, 5);
      expect(mock.calls[0].args).toEqual(['stop', '-t', '5', 'abc123']);
    });

    it('throws on stop failure', async () => {
      mock.handler.mockRejectedValueOnce(new Error('no such container'));
      await expect(runtime.stop({ id: 'bad', name: 'test', runtime: 'docker' })).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // kill
  // -----------------------------------------------------------------------

  describe('kill', () => {
    it('calls docker kill with the container ID', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.kill({ id: 'abc123', name: 'test', runtime: 'docker' });
      expect(mock.calls[0].args).toEqual(['kill', 'abc123']);
    });

    it('throws on kill failure', async () => {
      mock.handler.mockRejectedValueOnce(new Error('not running'));
      await expect(runtime.kill({ id: 'bad', name: 'test', runtime: 'docker' })).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // remove
  // -----------------------------------------------------------------------

  describe('remove', () => {
    it('calls docker rm with the container ID', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.remove({ id: 'abc123', name: 'test', runtime: 'docker' });
      expect(mock.calls[0].args).toEqual(['rm', 'abc123']);
    });

    it('throws on remove failure', async () => {
      mock.handler.mockRejectedValueOnce(new Error('container running'));
      await expect(
        runtime.remove({ id: 'bad', name: 'test', runtime: 'docker' }),
      ).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // inspect
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
        runtime: 'docker',
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
        runtime: 'docker',
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
        runtime: 'docker',
      });

      expect(state.status).toBe('dead');
      expect(state.exitCode).toBe(137);
    });

    it('parses a created container state', async () => {
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
        runtime: 'docker',
      });

      expect(state.status).toBe('created');
    });

    it('includes health status when present', async () => {
      mock.handler.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Status: 'running',
          Running: true,
          Dead: false,
          ExitCode: 0,
          StartedAt: '2026-01-15T10:30:00.000Z',
          FinishedAt: '0001-01-01T00:00:00Z',
          Health: { Status: 'healthy' },
        }),
        stderr: '',
      });

      const state = await runtime.inspect({
        id: 'abc123',
        name: 'test',
        runtime: 'docker',
      });

      expect(state.health).toBe('healthy');
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
        runtime: 'docker',
      });

      expect(state.health).toBe('none');
    });

    it('calls docker inspect with --format for State JSON', async () => {
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

      await runtime.inspect({ id: 'abc123', name: 'test', runtime: 'docker' });

      expect(mock.calls[0].args).toEqual(['inspect', '--format', '{{json .State}}', 'abc123']);
    });

    it('throws for a non-existent container', async () => {
      mock.handler.mockRejectedValueOnce(new Error('No such container'));
      await expect(
        runtime.inspect({ id: 'bad', name: 'test', runtime: 'docker' }),
      ).rejects.toThrow();
    });

    it('omits startedAt for zero-value Docker timestamps', async () => {
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
        runtime: 'docker',
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
  // Custom docker path
  // -----------------------------------------------------------------------

  describe('custom docker path', () => {
    it('uses the provided dockerPath', async () => {
      const custom = new DockerRuntime({
        exec: mock.exec,
        dockerPath: '/usr/local/bin/docker',
      });
      mock.handler.mockResolvedValueOnce({ stdout: 'info', stderr: '' });
      await custom.isAvailable();
      expect(mock.calls[0].file).toBe('/usr/local/bin/docker');
    });

    it('defaults to "docker"', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'info', stderr: '' });
      await runtime.isAvailable();
      expect(mock.calls[0].file).toBe('docker');
    });
  });

  // -----------------------------------------------------------------------
  // stdinData (credential injection via stdin)
  // -----------------------------------------------------------------------

  describe('stdinData', () => {
    let spawnCalls: { file: string; args: readonly string[]; stdinData: string }[];
    let spawnFn: SpawnFn;
    let runtimeWithSpawn: DockerRuntime;

    beforeEach(() => {
      spawnCalls = [];
      spawnFn = (file, args, stdinData) => {
        spawnCalls.push({ file, args, stdinData });
      };
      runtimeWithSpawn = new DockerRuntime({
        exec: mock.exec,
        spawn: spawnFn,
      });
    });

    it('uses docker create instead of docker run when stdinData is set', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });
      await runtimeWithSpawn.run(
        defaultRunOptions({ name: 'test-cred', stdinData: 'API_KEY=secret\n\n' }),
      );
      // First exec call should be 'create', not 'run'
      expect(mock.calls[0].args[0]).toBe('create');
    });

    it('passes -i flag in create args for stdin support', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });
      await runtimeWithSpawn.run(
        defaultRunOptions({ name: 'test-cred', stdinData: 'API_KEY=secret\n\n' }),
      );
      expect(mock.calls[0].args).toContain('-i');
    });

    it('does not pass -d flag in create args', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });
      await runtimeWithSpawn.run(
        defaultRunOptions({ name: 'test-cred', stdinData: 'API_KEY=secret\n\n' }),
      );
      expect(mock.calls[0].args).not.toContain('-d');
    });

    it('calls spawn with docker start -ai and the container ID', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });
      await runtimeWithSpawn.run(
        defaultRunOptions({ name: 'test-cred', stdinData: 'API_KEY=secret\n\n' }),
      );
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].args).toEqual(['start', '-ai', 'abc123']);
    });

    it('pipes stdinData to the spawn function', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });
      const creds = 'ANTHROPIC_API_KEY=sk-ant-test\nOTHER=value\n\n';
      await runtimeWithSpawn.run(defaultRunOptions({ name: 'test-cred', stdinData: creds }));
      expect(spawnCalls[0].stdinData).toBe(creds);
    });

    it('returns the container ID from docker create', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'def456\n', stderr: '' });
      const handle = await runtimeWithSpawn.run(
        defaultRunOptions({ name: 'test-cred', stdinData: 'KEY=val\n\n' }),
      );
      expect(handle.id).toBe('def456');
      expect(handle.name).toBe('test-cred');
      expect(handle.runtime).toBe('docker');
    });

    it('passes --read-only and --network none in create args', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtimeWithSpawn.run(
        defaultRunOptions({
          name: 'test',
          readOnly: true,
          networkDisabled: true,
          stdinData: 'K=V\n\n',
        }),
      );
      expect(mock.calls[0].args).toContain('--read-only');
      const netIdx = mock.calls[0].args.indexOf('--network');
      expect(netIdx).toBeGreaterThan(-1);
      expect(mock.calls[0].args[netIdx + 1]).toBe('none');
    });

    it('passes volume mounts in create args', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtimeWithSpawn.run(
        defaultRunOptions({
          name: 'test',
          stdinData: 'K=V\n\n',
          volumes: [{ source: '/host/ws', target: '/workspace', readonly: false }],
        }),
      );
      expect(mock.calls[0].args).toContain('/host/ws:/workspace');
    });

    it('uses standard docker run (no spawn) when stdinData is absent', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });
      await runtimeWithSpawn.run(defaultRunOptions({ name: 'test-no-stdin' }));
      expect(mock.calls[0].args[0]).toBe('run');
      expect(mock.calls[0].args[1]).toBe('-d');
      expect(spawnCalls).toHaveLength(0);
    });

    it('uses the configured dockerPath for spawn', async () => {
      const customRuntime = new DockerRuntime({
        exec: mock.exec,
        spawn: spawnFn,
        dockerPath: '/custom/docker',
      });
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await customRuntime.run(defaultRunOptions({ name: 'test', stdinData: 'K=V\n\n' }));
      expect(spawnCalls[0].file).toBe('/custom/docker');
    });
  });
});
