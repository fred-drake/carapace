import { describe, it, expect, beforeEach } from 'vitest';
import { MockContainerRuntime } from './mock-container-runtime.js';
import type { SpawnOptions, ContainerRuntime } from '../core/container-runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultSpawnOptions(overrides?: Partial<SpawnOptions>): SpawnOptions {
  return {
    image: 'carapace-agent:latest',
    name: 'test-container',
    mounts: [{ source: '/host/workspace', target: '/workspace', readonly: false }],
    environment: { NODE_ENV: 'test' },
    socketPath: '/tmp/carapace.sock',
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
    // Compile-time check: MockContainerRuntime is assignable to ContainerRuntime.
    const _rt: ContainerRuntime = runtime;
    expect(_rt).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // spawn
  // -----------------------------------------------------------------------

  describe('spawn', () => {
    it('creates a container with correct info', async () => {
      const options = defaultSpawnOptions({ name: 'my-agent' });
      const info = await runtime.spawn(options);

      expect(info.id).toMatch(/^mock-container-\d+$/);
      expect(info.name).toBe('my-agent');
      expect(info.connectionIdentity).toMatch(/^mock-identity-\d+$/);
      expect(info.status).toBe('running');
      expect(info.startedAt).toBeInstanceOf(Date);
    });

    it('generates unique IDs for each spawn', async () => {
      const a = await runtime.spawn(defaultSpawnOptions({ name: 'a' }));
      const b = await runtime.spawn(defaultSpawnOptions({ name: 'b' }));

      expect(a.id).not.toBe(b.id);
      expect(a.connectionIdentity).not.toBe(b.connectionIdentity);
    });
  });

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  describe('stop', () => {
    it('changes status to stopped and removes from active', async () => {
      const info = await runtime.spawn(defaultSpawnOptions());

      expect(await runtime.isRunning(info.id)).toBe(true);

      await runtime.stop(info.id);

      expect(await runtime.isRunning(info.id)).toBe(false);

      const updated = await runtime.getInfo(info.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('stopped');
    });

    it('records the stop call with timestamp', async () => {
      const info = await runtime.spawn(defaultSpawnOptions());
      const before = new Date();

      await runtime.stop(info.id, 5000);

      const calls = runtime.getStopCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].containerId).toBe(info.id);
      expect(calls[0].timeoutMs).toBe(5000);
      expect(calls[0].timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('records stop call with undefined timeoutMs when not provided', async () => {
      const info = await runtime.spawn(defaultSpawnOptions());
      await runtime.stop(info.id);

      const calls = runtime.getStopCalls();
      expect(calls[0].timeoutMs).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // isRunning
  // -----------------------------------------------------------------------

  describe('isRunning', () => {
    it('returns true for a running container', async () => {
      const info = await runtime.spawn(defaultSpawnOptions());
      expect(await runtime.isRunning(info.id)).toBe(true);
    });

    it('returns false after stop', async () => {
      const info = await runtime.spawn(defaultSpawnOptions());
      await runtime.stop(info.id);
      expect(await runtime.isRunning(info.id)).toBe(false);
    });

    it('returns false for an unknown container id', async () => {
      expect(await runtime.isRunning('nonexistent-id')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getInfo
  // -----------------------------------------------------------------------

  describe('getInfo', () => {
    it('returns info for a known container', async () => {
      const info = await runtime.spawn(defaultSpawnOptions({ name: 'lookup-test' }));
      const retrieved = await runtime.getInfo(info.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(info.id);
      expect(retrieved!.name).toBe('lookup-test');
    });

    it('returns null for an unknown container id', async () => {
      const result = await runtime.getInfo('does-not-exist');
      expect(result).toBeNull();
    });

    it('returns info for a stopped container', async () => {
      const info = await runtime.spawn(defaultSpawnOptions());
      await runtime.stop(info.id);

      const retrieved = await runtime.getInfo(info.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.status).toBe('stopped');
    });
  });

  // -----------------------------------------------------------------------
  // cleanup
  // -----------------------------------------------------------------------

  describe('cleanup', () => {
    it('stops all active containers', async () => {
      const a = await runtime.spawn(defaultSpawnOptions({ name: 'a' }));
      const b = await runtime.spawn(defaultSpawnOptions({ name: 'b' }));
      const c = await runtime.spawn(defaultSpawnOptions({ name: 'c' }));

      expect(runtime.getActiveContainers()).toHaveLength(3);

      await runtime.cleanup();

      expect(runtime.getActiveContainers()).toHaveLength(0);

      // All containers should be marked as stopped.
      for (const id of [a.id, b.id, c.id]) {
        const info = await runtime.getInfo(id);
        expect(info!.status).toBe('stopped');
      }
    });

    it('is a no-op when no containers are active', async () => {
      await runtime.cleanup();
      expect(runtime.getActiveContainers()).toHaveLength(0);
    });

    it('preserves container history after cleanup', async () => {
      await runtime.spawn(defaultSpawnOptions({ name: 'history-test' }));
      await runtime.cleanup();

      expect(runtime.getSpawnedContainers()).toHaveLength(1);
      expect(runtime.getSpawnedContainers()[0].name).toBe('history-test');
    });
  });

  // -----------------------------------------------------------------------
  // Failure simulation: spawn failure
  // -----------------------------------------------------------------------

  describe('simulateSpawnFailure', () => {
    it('causes the next spawn to reject', async () => {
      runtime.simulateSpawnFailure('Docker daemon not running');

      await expect(runtime.spawn(defaultSpawnOptions())).rejects.toThrow(
        'Docker daemon not running',
      );
    });

    it('uses a default error message when none is provided', async () => {
      runtime.simulateSpawnFailure();

      await expect(runtime.spawn(defaultSpawnOptions())).rejects.toThrow('Spawn failed');
    });

    it('only affects the next spawn (one-shot)', async () => {
      runtime.simulateSpawnFailure('Temporary failure');

      await expect(runtime.spawn(defaultSpawnOptions())).rejects.toThrow();

      // Subsequent spawn should succeed.
      const info = await runtime.spawn(defaultSpawnOptions());
      expect(info.status).toBe('running');
    });

    it('does not add a container to the store on failure', async () => {
      runtime.simulateSpawnFailure();

      await expect(runtime.spawn(defaultSpawnOptions())).rejects.toThrow();

      expect(runtime.getSpawnedContainers()).toHaveLength(0);
      expect(runtime.getActiveContainers()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Failure simulation: stop timeout
  // -----------------------------------------------------------------------

  describe('simulateStopTimeout', () => {
    it('causes the next stop to never resolve', async () => {
      const info = await runtime.spawn(defaultSpawnOptions());
      runtime.simulateStopTimeout();

      // Race the stop() against a short timer to prove it hangs.
      const result = await Promise.race([
        runtime.stop(info.id).then(() => 'resolved'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
      ]);

      expect(result).toBe('timed-out');
    });

    it('still records the stop call even when simulating timeout', async () => {
      const info = await runtime.spawn(defaultSpawnOptions());
      runtime.simulateStopTimeout();

      // Fire and forget the hanging stop.
      void runtime.stop(info.id, 3000);

      // Give the event loop a tick so the synchronous part runs.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      const calls = runtime.getStopCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].containerId).toBe(info.id);
      expect(calls[0].timeoutMs).toBe(3000);
    });

    it('only affects the next stop (one-shot)', async () => {
      const a = await runtime.spawn(defaultSpawnOptions({ name: 'a' }));
      const b = await runtime.spawn(defaultSpawnOptions({ name: 'b' }));

      runtime.simulateStopTimeout();

      // First stop hangs.
      void runtime.stop(a.id);

      // Second stop should resolve normally.
      await runtime.stop(b.id);
      expect(await runtime.isRunning(b.id)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Failure simulation: crash
  // -----------------------------------------------------------------------

  describe('simulateCrash', () => {
    it('marks container as stopped', async () => {
      const info = await runtime.spawn(defaultSpawnOptions());

      runtime.simulateCrash(info.id);

      const updated = await runtime.getInfo(info.id);
      expect(updated!.status).toBe('stopped');
    });

    it('removes container from active set', async () => {
      const info = await runtime.spawn(defaultSpawnOptions());

      runtime.simulateCrash(info.id);

      expect(await runtime.isRunning(info.id)).toBe(false);
      expect(runtime.getActiveContainers()).toHaveLength(0);
    });

    it('does not affect other running containers', async () => {
      const a = await runtime.spawn(defaultSpawnOptions({ name: 'a' }));
      const b = await runtime.spawn(defaultSpawnOptions({ name: 'b' }));

      runtime.simulateCrash(a.id);

      expect(await runtime.isRunning(a.id)).toBe(false);
      expect(await runtime.isRunning(b.id)).toBe(true);
      expect(runtime.getActiveContainers()).toHaveLength(1);
    });

    it('is a no-op for unknown container ids', () => {
      // Should not throw.
      runtime.simulateCrash('nonexistent');
      expect(runtime.getActiveContainers()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple concurrent containers
  // -----------------------------------------------------------------------

  describe('concurrent containers', () => {
    it('can have multiple containers active at the same time', async () => {
      const containers = await Promise.all([
        runtime.spawn(defaultSpawnOptions({ name: 'container-1' })),
        runtime.spawn(defaultSpawnOptions({ name: 'container-2' })),
        runtime.spawn(defaultSpawnOptions({ name: 'container-3' })),
      ]);

      expect(runtime.getActiveContainers()).toHaveLength(3);
      expect(runtime.getSpawnedContainers()).toHaveLength(3);

      for (const container of containers) {
        expect(await runtime.isRunning(container.id)).toBe(true);
      }
    });

    it('stopping one does not affect others', async () => {
      const a = await runtime.spawn(defaultSpawnOptions({ name: 'a' }));
      const b = await runtime.spawn(defaultSpawnOptions({ name: 'b' }));

      await runtime.stop(a.id);

      expect(await runtime.isRunning(a.id)).toBe(false);
      expect(await runtime.isRunning(b.id)).toBe(true);
      expect(runtime.getActiveContainers()).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Inspection methods
  // -----------------------------------------------------------------------

  describe('inspection methods', () => {
    it('getSpawnedContainers returns all containers ever spawned', async () => {
      const a = await runtime.spawn(defaultSpawnOptions({ name: 'a' }));
      await runtime.stop(a.id);
      await runtime.spawn(defaultSpawnOptions({ name: 'b' }));

      const all = runtime.getSpawnedContainers();
      expect(all).toHaveLength(2);
      expect(all.map((c) => c.name)).toEqual(['a', 'b']);
    });

    it('getActiveContainers returns only running containers', async () => {
      const a = await runtime.spawn(defaultSpawnOptions({ name: 'a' }));
      await runtime.spawn(defaultSpawnOptions({ name: 'b' }));
      await runtime.stop(a.id);

      const active = runtime.getActiveContainers();
      expect(active).toHaveLength(1);
      expect(active[0].name).toBe('b');
    });

    it('getStopCalls returns all stop calls in order', async () => {
      const a = await runtime.spawn(defaultSpawnOptions({ name: 'a' }));
      const b = await runtime.spawn(defaultSpawnOptions({ name: 'b' }));

      await runtime.stop(a.id, 5000);
      await runtime.stop(b.id, 10000);

      const calls = runtime.getStopCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0].containerId).toBe(a.id);
      expect(calls[0].timeoutMs).toBe(5000);
      expect(calls[1].containerId).toBe(b.id);
      expect(calls[1].timeoutMs).toBe(10000);
      expect(calls[1].timestamp.getTime()).toBeGreaterThanOrEqual(calls[0].timestamp.getTime());
    });
  });

  // -----------------------------------------------------------------------
  // reset
  // -----------------------------------------------------------------------

  describe('reset', () => {
    it('clears all state', async () => {
      // Build up some state.
      const info = await runtime.spawn(defaultSpawnOptions({ name: 'before-reset' }));
      await runtime.stop(info.id);
      runtime.simulateSpawnFailure('should be cleared');

      // Reset.
      runtime.reset();

      // Everything should be empty.
      expect(runtime.getSpawnedContainers()).toHaveLength(0);
      expect(runtime.getActiveContainers()).toHaveLength(0);
      expect(runtime.getStopCalls()).toHaveLength(0);

      // spawn failure simulation should be cleared — spawn should work.
      const newInfo = await runtime.spawn(defaultSpawnOptions({ name: 'after-reset' }));
      expect(newInfo.status).toBe('running');
      // ID counter is reset, so first container gets id 1 again.
      expect(newInfo.id).toBe('mock-container-1');
    });

    it('clears stop timeout simulation', async () => {
      runtime.simulateStopTimeout();
      runtime.reset();

      const info = await runtime.spawn(defaultSpawnOptions());
      // stop should resolve normally.
      await runtime.stop(info.id);
      expect(await runtime.isRunning(info.id)).toBe(false);
    });
  });
});
