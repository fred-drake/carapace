import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppleContainerRuntime } from './apple-container-runtime.js';
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

describe('AppleContainerRuntime', () => {
  let mock: ReturnType<typeof createMockExec>;
  let runtime: AppleContainerRuntime;

  beforeEach(() => {
    mock = createMockExec();
    runtime = new AppleContainerRuntime({ exec: mock.exec });
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
    it('is "apple-container"', () => {
      expect(runtime.name).toBe('apple-container');
    });
  });

  // -----------------------------------------------------------------------
  // experimental flag
  // -----------------------------------------------------------------------

  describe('experimental', () => {
    it('is marked as experimental', () => {
      expect(runtime.experimental).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // isAvailable
  // -----------------------------------------------------------------------

  describe('isAvailable', () => {
    it('returns true when container CLI responds', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      expect(await runtime.isAvailable()).toBe(true);
      expect(mock.calls[0].args).toEqual(['list']);
    });

    it('returns false when container CLI is not found', async () => {
      mock.handler.mockRejectedValueOnce(new Error('command not found: container'));
      expect(await runtime.isAvailable()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // version
  // -----------------------------------------------------------------------

  describe('version', () => {
    it('returns the Apple Containers version string', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '1.0.0\n', stderr: '' });
      const ver = await runtime.version();
      expect(ver).toBe('Apple Containers 1.0.0');
    });
  });

  // -----------------------------------------------------------------------
  // pull
  // -----------------------------------------------------------------------

  describe('pull', () => {
    it('pulls an image', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.pull('carapace-agent:latest');
      expect(mock.calls[0].args).toEqual(['pull', 'carapace-agent:latest']);
    });
  });

  // -----------------------------------------------------------------------
  // imageExists
  // -----------------------------------------------------------------------

  describe('imageExists', () => {
    it('returns true when image inspect succeeds', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '{}', stderr: '' });
      expect(await runtime.imageExists('carapace-agent:latest')).toBe(true);
    });

    it('returns false when image inspect fails', async () => {
      mock.handler.mockRejectedValueOnce(new Error('not found'));
      expect(await runtime.imageExists('carapace-agent:latest')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // loadImage
  // -----------------------------------------------------------------------

  describe('loadImage', () => {
    it('loads from tarball', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.loadImage('/tmp/image.tar');
      expect(mock.calls[0].args).toEqual(['load', '-i', '/tmp/image.tar']);
    });
  });

  // -----------------------------------------------------------------------
  // run — basic
  // -----------------------------------------------------------------------

  describe('run', () => {
    it('returns a container handle with apple-container runtime', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });
      const handle = await runtime.run(defaultRunOptions());
      expect(handle.id).toBe('abc123');
      expect(handle.runtime).toBe('apple-container');
    });

    it('uses -d flag for detached mode', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(defaultRunOptions());
      expect(mock.calls[0].args).toContain('-d');
    });

    it('sets container name from options', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(defaultRunOptions({ name: 'my-container' }));
      const args = mock.calls[0].args;
      const nameIdx = args.indexOf('--name');
      expect(nameIdx).toBeGreaterThan(-1);
      expect(args[nameIdx + 1]).toBe('my-container');
    });

    it('generates name when not provided', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      const handle = await runtime.run(defaultRunOptions());
      expect(handle.name).toMatch(/^carapace-/);
    });
  });

  // -----------------------------------------------------------------------
  // run — read-only (Apple Containers default)
  // -----------------------------------------------------------------------

  describe('run read-only handling', () => {
    it('adds --read-only when readOnly is true', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(defaultRunOptions({ readOnly: true }));
      expect(mock.calls[0].args).toContain('--read-only');
    });

    it('does NOT add --read-only when readOnly is false', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(defaultRunOptions({ readOnly: false }));
      expect(mock.calls[0].args).not.toContain('--read-only');
    });
  });

  // -----------------------------------------------------------------------
  // run — network
  // -----------------------------------------------------------------------

  describe('run network handling', () => {
    it('passes --network none when network is disabled', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(defaultRunOptions({ networkDisabled: true }));
      expect(mock.calls[0].args).toContain('--network');
      const args = mock.calls[0].args;
      const netIdx = args.indexOf('--network');
      expect(args[netIdx + 1]).toBe('none');
    });

    it('uses named network when provided', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(defaultRunOptions({ network: 'carapace-net', networkDisabled: true }));
      const args = mock.calls[0].args;
      const netIdx = args.indexOf('--network');
      expect(args[netIdx + 1]).toBe('carapace-net');
    });
  });

  // -----------------------------------------------------------------------
  // run — volumes
  // -----------------------------------------------------------------------

  describe('run volume mounts', () => {
    it('mounts volumes with readonly suffix', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({
          volumes: [{ source: '/host/data', target: '/data', readonly: true }],
        }),
      );
      const args = mock.calls[0].args;
      expect(args).toContain('-v');
      const vIdx = args.indexOf('-v');
      expect(args[vIdx + 1]).toBe('/host/data:/data:ro');
    });

    it('mounts writable volumes without suffix', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({
          volumes: [{ source: '/host/workspace', target: '/workspace', readonly: false }],
        }),
      );
      const args = mock.calls[0].args;
      const vIdx = args.indexOf('-v');
      expect(args[vIdx + 1]).toBe('/host/workspace:/workspace');
    });
  });

  // -----------------------------------------------------------------------
  // run — socket mounts (bind-mount via -v)
  // -----------------------------------------------------------------------

  describe('run socket mounts', () => {
    it('uses -v bind mount for socket mounts', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({
          socketMounts: [{ hostPath: '/run/carapace.sock', containerPath: '/run/agent.sock' }],
        }),
      );
      const args = mock.calls[0].args;
      expect(args).toContain('-v');
      const vIdx = args.lastIndexOf('-v');
      expect(args[vIdx + 1]).toBe('/run/carapace.sock:/run/agent.sock');
    });

    it('mounts multiple sockets', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({
          socketMounts: [
            { hostPath: '/run/a.sock', containerPath: '/run/a.sock' },
            { hostPath: '/run/b.sock', containerPath: '/run/b.sock' },
          ],
        }),
      );
      const args = mock.calls[0].args;
      // Count -v flags that correspond to socket mounts
      const vIndexes = args.reduce<number[]>((acc, arg, i) => {
        if (arg === '-v' && args[i + 1]?.includes('.sock')) acc.push(i);
        return acc;
      }, []);
      expect(vIndexes).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // run — env, user, entrypoint
  // -----------------------------------------------------------------------

  describe('run env/user/entrypoint', () => {
    it('passes environment variables', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(defaultRunOptions({ env: { FOO: 'bar', BAZ: '1' } }));
      const args = mock.calls[0].args;
      const eIndexes = args.reduce<number[]>((acc, arg, i) => {
        if (arg === '-e') acc.push(i);
        return acc;
      }, []);
      expect(eIndexes).toHaveLength(2);
      expect(args[eIndexes[0] + 1]).toBe('FOO=bar');
      expect(args[eIndexes[1] + 1]).toBe('BAZ=1');
    });

    it('sets user', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(defaultRunOptions({ user: '1000:1000' }));
      const args = mock.calls[0].args;
      expect(args).toContain('--user');
      const uIdx = args.indexOf('--user');
      expect(args[uIdx + 1]).toBe('1000:1000');
    });

    it('sets custom entrypoint', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(defaultRunOptions({ entrypoint: ['/bin/sh', '-c', 'echo hello'] }));
      const args = mock.calls[0].args;
      expect(args).toContain('--entrypoint');
      const epIdx = args.indexOf('--entrypoint');
      expect(args[epIdx + 1]).toBe('/bin/sh');
    });

    it('formats port mappings with 127.0.0.1 host address by default', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({
          portMappings: [{ hostPort: 8080, containerPort: 3456 }],
        }),
      );
      expect(mock.calls[0].args).toContain('127.0.0.1:8080:3456');
    });

    it('uses custom host address in port mappings when specified', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });
      await runtime.run(
        defaultRunOptions({
          portMappings: [{ hostPort: 8080, containerPort: 3456, hostAddress: '0.0.0.0' }],
        }),
      );
      expect(mock.calls[0].args).toContain('0.0.0.0:8080:3456');
    });
  });

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  describe('stop', () => {
    it('stops a container by ID', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.stop({ id: 'abc', name: 'test', runtime: 'apple-container' });
      expect(mock.calls[0].args).toEqual(['stop', 'abc']);
    });

    it('passes timeout when specified', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.stop({ id: 'abc', name: 'test', runtime: 'apple-container' }, 30);
      expect(mock.calls[0].args).toEqual(['stop', '-t', '30', 'abc']);
    });
  });

  // -----------------------------------------------------------------------
  // kill
  // -----------------------------------------------------------------------

  describe('kill', () => {
    it('kills a container by ID', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.kill({ id: 'abc', name: 'test', runtime: 'apple-container' });
      expect(mock.calls[0].args).toEqual(['kill', 'abc']);
    });
  });

  // -----------------------------------------------------------------------
  // remove
  // -----------------------------------------------------------------------

  describe('remove', () => {
    it('removes a container by ID', async () => {
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await runtime.remove({ id: 'abc', name: 'test', runtime: 'apple-container' });
      expect(mock.calls[0].args).toEqual(['rm', 'abc']);
    });
  });

  // -----------------------------------------------------------------------
  // inspect
  // -----------------------------------------------------------------------

  describe('inspect', () => {
    it('returns running state', async () => {
      mock.handler.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Status: 'running',
          Running: true,
          Dead: false,
          ExitCode: 0,
          StartedAt: '2026-02-19T10:00:00Z',
          FinishedAt: '0001-01-01T00:00:00Z',
        }),
        stderr: '',
      });
      const state = await runtime.inspect({
        id: 'abc',
        name: 'test',
        runtime: 'apple-container',
      });
      expect(state.status).toBe('running');
      expect(state.startedAt).toBe('2026-02-19T10:00:00Z');
      expect(state.exitCode).toBeUndefined();
    });

    it('returns stopped state with exit code', async () => {
      mock.handler.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Status: 'exited',
          Running: false,
          Dead: false,
          ExitCode: 0,
          StartedAt: '2026-02-19T10:00:00Z',
          FinishedAt: '2026-02-19T10:05:00Z',
        }),
        stderr: '',
      });
      const state = await runtime.inspect({
        id: 'abc',
        name: 'test',
        runtime: 'apple-container',
      });
      expect(state.status).toBe('stopped');
      expect(state.exitCode).toBe(0);
      expect(state.finishedAt).toBe('2026-02-19T10:05:00Z');
    });

    it('omits timestamps when zero-valued', async () => {
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
        id: 'abc',
        name: 'test',
        runtime: 'apple-container',
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
      const inspectResponse = JSON.stringify([{ index: { digest: 'sha256:abc123' } }]);
      mock.handler.mockResolvedValueOnce({ stdout: 'build output\n', stderr: '' });
      mock.handler.mockResolvedValueOnce({ stdout: inspectResponse, stderr: '' });

      const id = await runtime.build({ tag: 'carapace:latest', contextDir: '/src' });

      expect(id).toBe('sha256:abc123');
      expect(mock.calls[0].args).toEqual([
        'build',
        '-t',
        'carapace:latest',
        '--dns',
        '1.1.1.1',
        '--dns',
        '8.8.8.8',
        '/src',
      ]);
      expect(mock.calls[1].args).toEqual(['image', 'inspect', 'carapace:latest']);
    });

    it('builds with dockerfile, buildArgs, and labels', async () => {
      const inspectResponse = JSON.stringify([{ index: { digest: 'sha256:def456' } }]);
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      mock.handler.mockResolvedValueOnce({ stdout: inspectResponse, stderr: '' });

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
    it('returns parsed labels from Apple Containers inspect format', async () => {
      const inspectResponse = JSON.stringify([
        {
          variants: [
            {
              config: {
                config: {
                  Labels: { 'com.carapace.version': '1.0', 'com.carapace.commit': 'abc123' },
                },
              },
            },
          ],
        },
      ]);
      mock.handler.mockResolvedValueOnce({ stdout: inspectResponse, stderr: '' });

      const labels = await runtime.inspectLabels('carapace:latest');

      expect(labels).toEqual({ 'com.carapace.version': '1.0', 'com.carapace.commit': 'abc123' });
      expect(mock.calls[0].args).toEqual(['image', 'inspect', 'carapace:latest']);
    });

    it('returns empty object when no labels', async () => {
      const inspectResponse = JSON.stringify([{ variants: [{ config: { config: {} } }] }]);
      mock.handler.mockResolvedValueOnce({ stdout: inspectResponse, stderr: '' });

      const labels = await runtime.inspectLabels('carapace:latest');

      expect(labels).toEqual({});
    });

    it('throws for a non-existent image', async () => {
      mock.handler.mockRejectedValueOnce(new Error('No such image'));
      await expect(runtime.inspectLabels('nonexistent:latest')).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // custom binary path
  // -----------------------------------------------------------------------

  describe('custom binary path', () => {
    it('uses the configured container CLI path', async () => {
      const custom = new AppleContainerRuntime({
        exec: mock.exec,
        containerPath: '/opt/bin/container',
      });
      mock.handler.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await custom.isAvailable();
      expect(mock.calls[0].file).toBe('/opt/bin/container');
    });
  });
});
