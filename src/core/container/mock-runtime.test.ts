import { describe, it, expect, beforeEach } from 'vitest';
import { MockContainerRuntime } from './mock-runtime.js';
import type { ContainerRuntime, ContainerRunOptions } from './runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultRunOptions(overrides?: Partial<ContainerRunOptions>): ContainerRunOptions {
  return {
    image: 'carapace-agent:latest',
    readOnly: true,
    networkDisabled: true,
    volumes: [{ source: '/host/workspace', target: '/workspace', readonly: false }],
    socketMounts: [{ hostPath: '/run/zmq.sock', containerPath: '/sockets/zmq.sock' }],
    env: { NODE_ENV: 'test' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MockContainerRuntime', () => {
  let runtime: MockContainerRuntime;

  beforeEach(() => {
    runtime = new MockContainerRuntime();
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
    it('defaults to "docker"', () => {
      expect(runtime.name).toBe('docker');
    });

    it('can be set to any RuntimeName via constructor', () => {
      const podman = new MockContainerRuntime('podman');
      expect(podman.name).toBe('podman');

      const apple = new MockContainerRuntime('apple-container');
      expect(apple.name).toBe('apple-container');
    });
  });

  // -----------------------------------------------------------------------
  // isAvailable / version
  // -----------------------------------------------------------------------

  describe('isAvailable', () => {
    it('returns true by default', async () => {
      expect(await runtime.isAvailable()).toBe(true);
    });
  });

  describe('version', () => {
    it('returns a version string', async () => {
      const v = await runtime.version();
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Image lifecycle
  // -----------------------------------------------------------------------

  describe('pull', () => {
    it('resolves without error', async () => {
      await expect(runtime.pull('carapace-agent:latest')).resolves.toBeUndefined();
    });

    it('records the image as existing after pull', async () => {
      await runtime.pull('my-image:v1');
      expect(await runtime.imageExists('my-image:v1')).toBe(true);
    });
  });

  describe('imageExists', () => {
    it('returns false for unknown images', async () => {
      expect(await runtime.imageExists('nonexistent:latest')).toBe(false);
    });
  });

  describe('loadImage', () => {
    it('resolves without error', async () => {
      await expect(runtime.loadImage('/path/to/image.tar')).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // run
  // -----------------------------------------------------------------------

  describe('run', () => {
    it('returns a ContainerHandle', async () => {
      const handle = await runtime.run(defaultRunOptions());
      expect(handle.id).toMatch(/^mock-/);
      expect(handle.runtime).toBe('docker');
    });

    it('uses the provided name', async () => {
      const handle = await runtime.run(defaultRunOptions({ name: 'my-agent' }));
      expect(handle.name).toBe('my-agent');
    });

    it('generates a name when none is provided', async () => {
      const handle = await runtime.run(defaultRunOptions());
      expect(handle.name).toBeDefined();
      expect(handle.name.length).toBeGreaterThan(0);
    });

    it('generates unique IDs for each run', async () => {
      const a = await runtime.run(defaultRunOptions({ name: 'a' }));
      const b = await runtime.run(defaultRunOptions({ name: 'b' }));
      expect(a.id).not.toBe(b.id);
    });
  });

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  describe('stop', () => {
    it('transitions container to stopped state', async () => {
      const handle = await runtime.run(defaultRunOptions());
      await runtime.stop(handle);
      const state = await runtime.inspect(handle);
      expect(state.status).toBe('stopped');
    });

    it('accepts an optional timeout', async () => {
      const handle = await runtime.run(defaultRunOptions());
      await runtime.stop(handle, 5);
      const state = await runtime.inspect(handle);
      expect(state.status).toBe('stopped');
    });
  });

  // -----------------------------------------------------------------------
  // kill
  // -----------------------------------------------------------------------

  describe('kill', () => {
    it('immediately marks the container as dead', async () => {
      const handle = await runtime.run(defaultRunOptions());
      await runtime.kill(handle);
      const state = await runtime.inspect(handle);
      expect(state.status).toBe('dead');
    });
  });

  // -----------------------------------------------------------------------
  // remove
  // -----------------------------------------------------------------------

  describe('remove', () => {
    it('removes a stopped container', async () => {
      const handle = await runtime.run(defaultRunOptions());
      await runtime.stop(handle);
      await runtime.remove(handle);
      // After removal, inspect should throw or return a terminal state.
      await expect(runtime.inspect(handle)).rejects.toThrow();
    });

    it('removes a killed container', async () => {
      const handle = await runtime.run(defaultRunOptions());
      await runtime.kill(handle);
      await runtime.remove(handle);
      await expect(runtime.inspect(handle)).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // inspect
  // -----------------------------------------------------------------------

  describe('inspect', () => {
    it('returns running state for an active container', async () => {
      const handle = await runtime.run(defaultRunOptions());
      const state = await runtime.inspect(handle);
      expect(state.status).toBe('running');
      expect(state.startedAt).toBeDefined();
    });

    it('returns stopped state after stop', async () => {
      const handle = await runtime.run(defaultRunOptions());
      await runtime.stop(handle);
      const state = await runtime.inspect(handle);
      expect(state.status).toBe('stopped');
      expect(state.exitCode).toBe(0);
      expect(state.finishedAt).toBeDefined();
    });

    it('returns dead state after kill', async () => {
      const handle = await runtime.run(defaultRunOptions());
      await runtime.kill(handle);
      const state = await runtime.inspect(handle);
      expect(state.status).toBe('dead');
      expect(state.exitCode).toBe(137);
    });

    it('throws for a removed container', async () => {
      const handle = await runtime.run(defaultRunOptions());
      await runtime.stop(handle);
      await runtime.remove(handle);
      await expect(runtime.inspect(handle)).rejects.toThrow(/not found/i);
    });
  });

  // -----------------------------------------------------------------------
  // Failure simulation
  // -----------------------------------------------------------------------

  describe('simulateRunFailure', () => {
    it('causes the next run() to reject', async () => {
      runtime.simulateRunFailure('Engine not running');
      await expect(runtime.run(defaultRunOptions())).rejects.toThrow('Engine not running');
    });

    it('uses default message when none provided', async () => {
      runtime.simulateRunFailure();
      await expect(runtime.run(defaultRunOptions())).rejects.toThrow('Run failed');
    });

    it('is one-shot — subsequent runs succeed', async () => {
      runtime.simulateRunFailure();
      await expect(runtime.run(defaultRunOptions())).rejects.toThrow();
      const handle = await runtime.run(defaultRunOptions());
      expect(handle.id).toBeDefined();
    });
  });

  describe('simulateStopTimeout', () => {
    it('causes the next stop to never resolve', async () => {
      const handle = await runtime.run(defaultRunOptions());
      runtime.simulateStopTimeout();

      const result = await Promise.race([
        runtime.stop(handle).then(() => 'resolved'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
      ]);

      expect(result).toBe('timed-out');
    });

    it('is one-shot', async () => {
      const a = await runtime.run(defaultRunOptions({ name: 'a' }));
      const b = await runtime.run(defaultRunOptions({ name: 'b' }));

      runtime.simulateStopTimeout();
      void runtime.stop(a);

      // Second stop should resolve normally.
      await runtime.stop(b);
      const state = await runtime.inspect(b);
      expect(state.status).toBe('stopped');
    });
  });

  describe('simulateCrash', () => {
    it('marks a running container as dead', async () => {
      const handle = await runtime.run(defaultRunOptions());
      runtime.simulateCrash(handle);
      const state = await runtime.inspect(handle);
      expect(state.status).toBe('dead');
    });

    it('does not affect other containers', async () => {
      const a = await runtime.run(defaultRunOptions({ name: 'a' }));
      const b = await runtime.run(defaultRunOptions({ name: 'b' }));

      runtime.simulateCrash(a);

      const stateA = await runtime.inspect(a);
      const stateB = await runtime.inspect(b);
      expect(stateA.status).toBe('dead');
      expect(stateB.status).toBe('running');
    });
  });

  // -----------------------------------------------------------------------
  // Inspection helpers
  // -----------------------------------------------------------------------

  describe('getRunningHandles', () => {
    it('returns only running containers', async () => {
      const a = await runtime.run(defaultRunOptions({ name: 'a' }));
      const _b = await runtime.run(defaultRunOptions({ name: 'b' }));
      await runtime.stop(a);

      const running = runtime.getRunningHandles();
      expect(running).toHaveLength(1);
      expect(running[0].name).toBe('b');
    });
  });

  describe('reset', () => {
    it('clears all state', async () => {
      await runtime.run(defaultRunOptions());
      runtime.simulateRunFailure('should be cleared');
      runtime.reset();

      expect(runtime.getRunningHandles()).toHaveLength(0);

      // simulateRunFailure should be cleared.
      const handle = await runtime.run(defaultRunOptions());
      expect(handle.id).toBeDefined();
    });
  });
});
