import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ContainerLifecycleManager } from './lifecycle-manager.js';
import { MockContainerRuntime } from './mock-runtime.js';
import { SessionManager } from '../session-manager.js';
import type { ContainerHandle } from './runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultSpawnRequest(overrides?: Record<string, unknown>) {
  return {
    group: 'email',
    image: 'carapace-agent:latest',
    socketPath: '/tmp/sockets/test.sock',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContainerLifecycleManager', () => {
  let runtime: MockContainerRuntime;
  let sessionManager: SessionManager;
  let manager: ContainerLifecycleManager;

  beforeEach(() => {
    runtime = new MockContainerRuntime();
    sessionManager = new SessionManager();
    manager = new ContainerLifecycleManager({
      runtime,
      sessionManager,
      shutdownTimeoutMs: 500,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Spawn
  // -----------------------------------------------------------------------

  describe('spawn', () => {
    it('spawns a container via the runtime', async () => {
      const result = await manager.spawn(defaultSpawnRequest());

      expect(result.handle).toBeDefined();
      expect(result.handle.id).toBeDefined();
      expect(result.handle.runtime).toBe('docker');
    });

    it('creates a session for the spawned container', async () => {
      const result = await manager.spawn(defaultSpawnRequest());

      expect(result.session).toBeDefined();
      expect(result.session.containerId).toBe(result.handle.id);
      expect(result.session.group).toBe('email');
    });

    it('sets readOnly and networkDisabled on the container', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(defaultSpawnRequest());

      expect(runSpy).toHaveBeenCalledOnce();
      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.readOnly).toBe(true);
      expect(callOptions.networkDisabled).toBe(true);
    });

    it('uses a custom network when networkName is configured', async () => {
      const netManager = new ContainerLifecycleManager({
        runtime,
        sessionManager,
        networkName: 'carapace-restricted',
      });
      const runSpy = vi.spyOn(runtime, 'run');

      await netManager.spawn(defaultSpawnRequest());

      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.network).toBe('carapace-restricted');
      expect(callOptions.networkDisabled).toBe(false);
    });

    it('defaults to networkDisabled when no networkName is configured', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(defaultSpawnRequest());

      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.network).toBeUndefined();
      expect(callOptions.networkDisabled).toBe(true);
    });

    it('mounts the ZeroMQ socket into the container', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(defaultSpawnRequest({ socketPath: '/tmp/sockets/agent.sock' }));

      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.socketMounts).toHaveLength(1);
      expect(callOptions.socketMounts[0].hostPath).toBe('/tmp/sockets/agent.sock');
    });

    it('mounts a workspace volume when provided', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(defaultSpawnRequest({ workspacePath: '/home/user/workspace' }));

      const callOptions = runSpy.mock.calls[0][0];
      const wsVolume = callOptions.volumes.find((v) => v.target === '/workspace');
      expect(wsVolume).toBeDefined();
      expect(wsVolume!.source).toBe('/home/user/workspace');
      expect(wsVolume!.readonly).toBe(false);
    });

    it('generates a carapace-prefixed container name', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(defaultSpawnRequest({ group: 'slack' }));

      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.name).toMatch(/^carapace-slack-/);
    });

    it('passes custom environment variables', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(defaultSpawnRequest({ env: { MY_VAR: 'hello' } }));

      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.env['MY_VAR']).toBe('hello');
    });

    it('passes stdinData through to container run options', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(defaultSpawnRequest({ stdinData: 'ANTHROPIC_API_KEY=sk-test\n\n' }));

      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.stdinData).toBe('ANTHROPIC_API_KEY=sk-test\n\n');
    });

    it('omits stdinData when not provided in SpawnRequest', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(defaultSpawnRequest());

      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.stdinData).toBeUndefined();
    });

    it('propagates runtime spawn failures', async () => {
      runtime.simulateRunFailure('Container engine crashed');

      await expect(manager.spawn(defaultSpawnRequest())).rejects.toThrow(
        'Container engine crashed',
      );
    });

    it('does not create a session if spawn fails', async () => {
      runtime.simulateRunFailure('spawn error');

      await expect(manager.spawn(defaultSpawnRequest())).rejects.toThrow();

      expect(sessionManager.getAll()).toHaveLength(0);
    });

    it('assigns a unique connection identity per container', async () => {
      const r1 = await manager.spawn(defaultSpawnRequest());
      const r2 = await manager.spawn(
        defaultSpawnRequest({ group: 'slack', socketPath: '/tmp/sockets/s2.sock' }),
      );

      expect(r1.session.connectionIdentity).not.toBe(r2.session.connectionIdentity);
    });

    it('tracks the spawned container internally', async () => {
      await manager.spawn(defaultSpawnRequest());

      expect(manager.getAll()).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  describe('shutdown', () => {
    it('gracefully stops a running container', async () => {
      const stopSpy = vi.spyOn(runtime, 'stop');
      const { session } = await manager.spawn(defaultSpawnRequest());

      await manager.shutdown(session.sessionId);

      expect(stopSpy).toHaveBeenCalledOnce();
    });

    it('removes the session on shutdown', async () => {
      const { session } = await manager.spawn(defaultSpawnRequest());

      await manager.shutdown(session.sessionId);

      expect(sessionManager.get(session.sessionId)).toBeNull();
    });

    it('removes the container after stopping', async () => {
      const removeSpy = vi.spyOn(runtime, 'remove');
      const { session } = await manager.spawn(defaultSpawnRequest());

      await manager.shutdown(session.sessionId);

      expect(removeSpy).toHaveBeenCalledOnce();
    });

    it('removes the tracked container from internal state', async () => {
      const { session } = await manager.spawn(defaultSpawnRequest());

      await manager.shutdown(session.sessionId);

      expect(manager.getAll()).toHaveLength(0);
    });

    it('returns false for an unknown session', async () => {
      const result = await manager.shutdown('nonexistent-session');

      expect(result).toBe(false);
    });

    it('force kills after graceful stop times out', async () => {
      vi.useFakeTimers();
      const killSpy = vi.spyOn(runtime, 'kill');

      const { session } = await manager.spawn(defaultSpawnRequest());
      runtime.simulateStopTimeout();

      const shutdownPromise = manager.shutdown(session.sessionId);

      // Advance past the shutdown timeout
      await vi.advanceTimersByTimeAsync(600);
      await shutdownPromise;

      expect(killSpy).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it('still cleans up session and container after forced kill', async () => {
      vi.useFakeTimers();
      const removeSpy = vi.spyOn(runtime, 'remove');

      const { session } = await manager.spawn(defaultSpawnRequest());
      runtime.simulateStopTimeout();

      const shutdownPromise = manager.shutdown(session.sessionId);
      await vi.advanceTimersByTimeAsync(600);
      await shutdownPromise;

      expect(sessionManager.get(session.sessionId)).toBeNull();
      expect(removeSpy).toHaveBeenCalledOnce();
      expect(manager.getAll()).toHaveLength(0);

      vi.useRealTimers();
    });
  });

  // -----------------------------------------------------------------------
  // Shutdown all
  // -----------------------------------------------------------------------

  describe('shutdownAll', () => {
    it('shuts down all managed containers', async () => {
      const stopSpy = vi.spyOn(runtime, 'stop');

      await manager.spawn(defaultSpawnRequest());
      await manager.spawn(defaultSpawnRequest({ group: 'slack', socketPath: '/tmp/s2.sock' }));
      await manager.spawn(defaultSpawnRequest({ group: 'cron', socketPath: '/tmp/s3.sock' }));

      expect(manager.getAll()).toHaveLength(3);

      await manager.shutdownAll();

      expect(stopSpy).toHaveBeenCalledTimes(3);
      expect(manager.getAll()).toHaveLength(0);
      expect(sessionManager.getAll()).toHaveLength(0);
    });

    it('handles empty container list gracefully', async () => {
      await expect(manager.shutdownAll()).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Orphan cleanup
  // -----------------------------------------------------------------------

  describe('cleanupOrphans', () => {
    it('kills and removes containers that are still running', async () => {
      // Simulate orphaned containers from a previous run by creating them
      // directly through the runtime (bypassing the lifecycle manager)
      const orphan1 = await runtime.run({
        image: 'carapace-agent:latest',
        name: 'carapace-orphan-1',
        readOnly: true,
        networkDisabled: true,
        volumes: [],
        socketMounts: [],
        env: {},
      });
      const orphan2 = await runtime.run({
        image: 'carapace-agent:latest',
        name: 'carapace-orphan-2',
        readOnly: true,
        networkDisabled: true,
        volumes: [],
        socketMounts: [],
        env: {},
      });

      const killSpy = vi.spyOn(runtime, 'kill');
      const removeSpy = vi.spyOn(runtime, 'remove');

      const cleaned = await manager.cleanupOrphans([orphan1, orphan2]);

      expect(cleaned).toHaveLength(2);
      expect(killSpy).toHaveBeenCalledTimes(2);
      expect(removeSpy).toHaveBeenCalledTimes(2);
    });

    it('removes stopped containers without killing', async () => {
      const orphan = await runtime.run({
        image: 'carapace-agent:latest',
        name: 'carapace-stopped',
        readOnly: true,
        networkDisabled: true,
        volumes: [],
        socketMounts: [],
        env: {},
      });

      // Stop the container before orphan cleanup
      await runtime.stop(orphan);

      const killSpy = vi.spyOn(runtime, 'kill');
      const removeSpy = vi.spyOn(runtime, 'remove');

      const cleaned = await manager.cleanupOrphans([orphan]);

      expect(cleaned).toHaveLength(1);
      expect(killSpy).not.toHaveBeenCalled();
      expect(removeSpy).toHaveBeenCalledOnce();
    });

    it('skips containers that no longer exist', async () => {
      const phantom: ContainerHandle = {
        id: 'does-not-exist',
        name: 'carapace-phantom',
        runtime: 'docker',
      };

      const cleaned = await manager.cleanupOrphans([phantom]);

      expect(cleaned).toHaveLength(0);
    });

    it('handles an empty orphan list', async () => {
      const cleaned = await manager.cleanupOrphans([]);

      expect(cleaned).toHaveLength(0);
    });

    it('does not affect currently managed containers', async () => {
      const managed = await manager.spawn(defaultSpawnRequest());
      const orphan = await runtime.run({
        image: 'carapace-agent:latest',
        name: 'carapace-orphan',
        readOnly: true,
        networkDisabled: true,
        volumes: [],
        socketMounts: [],
        env: {},
      });

      await manager.cleanupOrphans([orphan]);

      // Managed container should still be tracked
      expect(manager.getAll()).toHaveLength(1);
      expect(manager.getAll()[0].handle.id).toBe(managed.handle.id);
    });
  });

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  describe('getStatus', () => {
    it('returns container state for a managed container', async () => {
      const { session } = await manager.spawn(defaultSpawnRequest());

      const status = await manager.getStatus(session.sessionId);

      expect(status).not.toBeNull();
      expect(status!.status).toBe('running');
    });

    it('returns null for an unknown session', async () => {
      const status = await manager.getStatus('nonexistent');

      expect(status).toBeNull();
    });

    it('reflects container state changes', async () => {
      const { handle, session } = await manager.spawn(defaultSpawnRequest());

      runtime.simulateCrash(handle);

      const status = await manager.getStatus(session.sessionId);

      expect(status!.status).toBe('dead');
      expect(status!.exitCode).toBe(137);
    });
  });

  // -----------------------------------------------------------------------
  // getAll
  // -----------------------------------------------------------------------

  describe('getAll', () => {
    it('returns all tracked containers', async () => {
      await manager.spawn(defaultSpawnRequest());
      await manager.spawn(defaultSpawnRequest({ group: 'slack', socketPath: '/tmp/s2.sock' }));

      const all = manager.getAll();

      expect(all).toHaveLength(2);
      expect(all.map((c) => c.session.group).sort()).toEqual(['email', 'slack']);
    });

    it('returns empty array when no containers are managed', () => {
      expect(manager.getAll()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Resource cleanup edge cases
  // -----------------------------------------------------------------------

  describe('resource cleanup', () => {
    it('cleans up session even if container remove fails', async () => {
      vi.spyOn(runtime, 'remove').mockRejectedValueOnce(new Error('remove failed'));

      const { session } = await manager.spawn(defaultSpawnRequest());

      // Should not throw — cleanup is best-effort
      await manager.shutdown(session.sessionId);

      expect(sessionManager.get(session.sessionId)).toBeNull();
      expect(manager.getAll()).toHaveLength(0);
    });

    it('handles concurrent shutdowns of the same session', async () => {
      const { session } = await manager.spawn(defaultSpawnRequest());

      // First shutdown succeeds
      const [r1, r2] = await Promise.all([
        manager.shutdown(session.sessionId),
        manager.shutdown(session.sessionId),
      ]);

      // One should succeed, one should return false (already gone)
      expect([r1, r2]).toContain(true);
      expect([r1, r2]).toContain(false);
      expect(manager.getAll()).toHaveLength(0);
    });
  });
});
