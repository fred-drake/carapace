/**
 * Container lifecycle integration tests (QA-06).
 *
 * Exercises the full container lifecycle: spawn, session management,
 * tool invocations through the pipeline, graceful shutdown, forced
 * shutdown, and orphan cleanup. Uses MockContainerRuntime and
 * IntegrationHarness for in-memory testing.
 *
 * Run with: pnpm test:e2e
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContainerLifecycleManager } from './lifecycle-manager.js';
import { MockContainerRuntime } from './mock-runtime.js';
import { SessionManager } from '../session-manager.js';
import { IntegrationHarness } from '../../testing/integration-harness.js';
import type { ContainerHandle } from './runtime.js';
import type { SpawnRequest } from './lifecycle-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spawnRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
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

describe('container lifecycle (e2e)', () => {
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

  // -------------------------------------------------------------------------
  // Spawn
  // -------------------------------------------------------------------------

  describe('spawn', () => {
    it('creates container in running state and registers session', async () => {
      const managed = await manager.spawn(spawnRequest());

      // Container is running in the mock runtime
      const state = await runtime.inspect(managed.handle);
      expect(state.status).toBe('running');
      expect(state.startedAt).toBeDefined();

      // Session is registered in the session manager
      const session = sessionManager.get(managed.session.sessionId);
      expect(session).not.toBeNull();
      expect(session!.group).toBe('email');
      expect(session!.containerId).toBe(managed.handle.id);
    });

    it('configures container with security defaults', async () => {
      const runSpy = vi.spyOn(runtime, 'run');
      await manager.spawn(spawnRequest());

      const options = runSpy.mock.calls[0]![0]!;
      expect(options.readOnly).toBe(true);
      expect(options.networkDisabled).toBe(true);
    });

    it('mounts ZeroMQ socket at /sockets/carapace.sock', async () => {
      const runSpy = vi.spyOn(runtime, 'run');
      await manager.spawn(spawnRequest({ socketPath: '/host/path/zmq.sock' }));

      const options = runSpy.mock.calls[0]![0]!;
      expect(options.socketMounts).toEqual([
        { hostPath: '/host/path/zmq.sock', containerPath: '/sockets/carapace.sock' },
      ]);
    });

    it('mounts workspace volume when provided', async () => {
      const runSpy = vi.spyOn(runtime, 'run');
      await manager.spawn(spawnRequest({ workspacePath: '/home/user/project' }));

      const options = runSpy.mock.calls[0]![0]!;
      expect(options.volumes).toEqual([
        { source: '/home/user/project', target: '/workspace', readonly: false },
      ]);
    });

    it('spawns multiple independent containers and sessions', async () => {
      const m1 = await manager.spawn(spawnRequest({ group: 'email' }));
      const m2 = await manager.spawn(spawnRequest({ group: 'slack' }));
      const m3 = await manager.spawn(spawnRequest({ group: 'cron' }));

      // All have unique container IDs
      const ids = new Set([m1.handle.id, m2.handle.id, m3.handle.id]);
      expect(ids.size).toBe(3);

      // All have unique session IDs
      const sessionIds = new Set([
        m1.session.sessionId,
        m2.session.sessionId,
        m3.session.sessionId,
      ]);
      expect(sessionIds.size).toBe(3);

      // All tracked by the manager
      expect(manager.getAll()).toHaveLength(3);
    });

    it('propagates runtime failure and leaves no orphaned session', async () => {
      runtime.simulateRunFailure('Docker daemon not responding');

      await expect(manager.spawn(spawnRequest())).rejects.toThrow('Docker daemon not responding');

      // No sessions should have been created
      expect(sessionManager.getAll()).toHaveLength(0);
      // No containers tracked
      expect(manager.getAll()).toHaveLength(0);
    });

    it('passes additional environment variables to the container', async () => {
      const runSpy = vi.spyOn(runtime, 'run');
      await manager.spawn(spawnRequest({ env: { API_KEY: 'test-key', NODE_ENV: 'production' } }));

      const options = runSpy.mock.calls[0]![0]!;
      expect(options.env).toEqual({ API_KEY: 'test-key', NODE_ENV: 'production' });
    });
  });

  // -------------------------------------------------------------------------
  // Session integration
  // -------------------------------------------------------------------------

  describe('session integration', () => {
    it('session is retrievable by sessionId', async () => {
      const managed = await manager.spawn(spawnRequest());
      const session = sessionManager.get(managed.session.sessionId);
      expect(session).toEqual(managed.session);
    });

    it('session is retrievable by containerId', async () => {
      const managed = await manager.spawn(spawnRequest());
      const session = sessionManager.getByContainerId(managed.handle.id);
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe(managed.session.sessionId);
    });

    it('session is retrievable by connectionIdentity', async () => {
      const managed = await manager.spawn(spawnRequest());
      const session = sessionManager.getByConnectionIdentity(managed.session.connectionIdentity);
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe(managed.session.sessionId);
    });

    it('session converts to valid pipeline SessionContext', async () => {
      const managed = await manager.spawn(spawnRequest({ group: 'slack' }));
      const ctx = sessionManager.toSessionContext(managed.session.sessionId);

      expect(ctx).not.toBeNull();
      expect(ctx!.sessionId).toBe(managed.session.sessionId);
      expect(ctx!.group).toBe('slack');
      expect(ctx!.source).toBe(managed.handle.id);
      expect(ctx!.startedAt).toBeDefined();
    });

    it('connection identity follows expected naming pattern', async () => {
      const managed = await manager.spawn(spawnRequest({ group: 'email' }));
      expect(managed.session.connectionIdentity).toMatch(/^carapace-email-/);
    });

    it('multiple sessions maintain separate reverse indexes', async () => {
      const m1 = await manager.spawn(spawnRequest({ group: 'email' }));
      const m2 = await manager.spawn(spawnRequest({ group: 'slack' }));

      const s1 = sessionManager.getByContainerId(m1.handle.id);
      const s2 = sessionManager.getByContainerId(m2.handle.id);

      expect(s1!.sessionId).toBe(m1.session.sessionId);
      expect(s2!.sessionId).toBe(m2.session.sessionId);
      expect(s1!.sessionId).not.toBe(s2!.sessionId);
    });
  });

  // -------------------------------------------------------------------------
  // Communication bridge (lifecycle manager + pipeline)
  // -------------------------------------------------------------------------

  describe('communication bridge', () => {
    let harness: IntegrationHarness;

    afterEach(async () => {
      if (harness) await harness.close();
    });

    it('spawned session can drive tool invocations through the pipeline', async () => {
      // Spawn a container via lifecycle manager
      const managed = await manager.spawn(spawnRequest({ group: 'email' }));

      // Create an IntegrationHarness and register a tool
      harness = await IntegrationHarness.create({
        rateLimiterConfig: { requestsPerMinute: 6000, burstSize: 100 },
      });
      harness.registerTool(
        {
          name: 'read_email',
          description: 'Read email',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'string' } },
          },
        },
        async () => ({ ok: true as const, result: { subject: 'Hello', body: 'World' } }),
      );

      // Create a harness session matching the lifecycle-spawned session's group
      const harnessSession = harness.createSession({ group: managed.session.group });

      // Send a request through the full pipeline
      const response = await harness.sendRequest(harnessSession, 'read_email', {
        id: 'msg-001',
      });

      expect(response.payload.error).toBeNull();
      expect(response.payload.result).toEqual({
        ok: true,
        result: { subject: 'Hello', body: 'World' },
      });
      expect(response.type).toBe('response');
    });

    it('pipeline uses session group for authorization', async () => {
      // Spawn containers in different groups
      const emailContainer = await manager.spawn(spawnRequest({ group: 'email' }));
      const slackContainer = await manager.spawn(spawnRequest({ group: 'slack' }));

      harness = await IntegrationHarness.create({
        rateLimiterConfig: { requestsPerMinute: 6000, burstSize: 100 },
      });
      harness.registerTool(
        {
          name: 'send_email',
          description: 'Send email',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: { to: { type: 'string' } },
          },
        },
        async () => ({ ok: true as const, result: { sent: true } }),
      );

      // Restrict tool to email group only
      harness.setToolGroupRestriction('send_email', ['email']);

      // Email group session can invoke
      const emailSession = harness.createSession({ group: emailContainer.session.group });
      const emailResp = await harness.sendRequest(emailSession, 'send_email', {
        to: 'user@test.com',
      });
      expect(emailResp.payload.error).toBeNull();

      // Slack group session is rejected
      const slackSession = harness.createSession({ group: slackContainer.session.group });
      const slackResp = await harness.sendRequest(slackSession, 'send_email', {
        to: 'user@test.com',
      });
      expect(slackResp.payload.error).not.toBeNull();
      expect(slackResp.payload.error!.code).toBe('UNAUTHORIZED');
    });
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  describe('graceful shutdown', () => {
    it('stops container and removes session', async () => {
      const managed = await manager.spawn(spawnRequest());
      const sessionId = managed.session.sessionId;

      const result = await manager.shutdown(sessionId);
      expect(result).toBe(true);

      // Session is gone
      expect(sessionManager.get(sessionId)).toBeNull();

      // Container is removed from runtime (inspect throws)
      await expect(runtime.inspect(managed.handle)).rejects.toThrow('not found');
    });

    it('container state transitions to stopped before removal', async () => {
      const managed = await manager.spawn(spawnRequest());
      const stopSpy = vi.spyOn(runtime, 'stop');
      const removeSpy = vi.spyOn(runtime, 'remove');

      await manager.shutdown(managed.session.sessionId);

      // stop() was called before remove()
      expect(stopSpy).toHaveBeenCalledOnce();
      expect(removeSpy).toHaveBeenCalledOnce();

      // stop was called first (via call order)
      const stopOrder = stopSpy.mock.invocationCallOrder[0]!;
      const removeOrder = removeSpy.mock.invocationCallOrder[0]!;
      expect(stopOrder).toBeLessThan(removeOrder);
    });

    it('getStatus returns null after shutdown', async () => {
      const managed = await manager.spawn(spawnRequest());
      await manager.shutdown(managed.session.sessionId);

      const status = await manager.getStatus(managed.session.sessionId);
      expect(status).toBeNull();
    });

    it('getAll no longer includes shut down container', async () => {
      const m1 = await manager.spawn(spawnRequest({ group: 'a' }));
      const m2 = await manager.spawn(spawnRequest({ group: 'b' }));

      expect(manager.getAll()).toHaveLength(2);

      await manager.shutdown(m1.session.sessionId);

      const remaining = manager.getAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.session.sessionId).toBe(m2.session.sessionId);
    });

    it('double shutdown returns false on second call', async () => {
      const managed = await manager.spawn(spawnRequest());
      const sessionId = managed.session.sessionId;

      expect(await manager.shutdown(sessionId)).toBe(true);
      expect(await manager.shutdown(sessionId)).toBe(false);
    });

    it('concurrent shutdowns: exactly one succeeds', async () => {
      const managed = await manager.spawn(spawnRequest());
      const sessionId = managed.session.sessionId;

      const [r1, r2] = await Promise.all([
        manager.shutdown(sessionId),
        manager.shutdown(sessionId),
      ]);

      // Exactly one should succeed
      expect([r1, r2].filter(Boolean)).toHaveLength(1);
      expect([r1, r2].filter((r) => !r)).toHaveLength(1);
    });

    it('shutdownAll shuts down all managed containers', async () => {
      await manager.spawn(spawnRequest({ group: 'a' }));
      await manager.spawn(spawnRequest({ group: 'b' }));
      await manager.spawn(spawnRequest({ group: 'c' }));

      expect(manager.getAll()).toHaveLength(3);
      expect(sessionManager.getAll()).toHaveLength(3);

      await manager.shutdownAll();

      expect(manager.getAll()).toHaveLength(0);
      expect(sessionManager.getAll()).toHaveLength(0);
      expect(runtime.getRunningHandles()).toHaveLength(0);
    });

    it('shutdown of unknown session returns false', async () => {
      expect(await manager.shutdown('nonexistent-session-id')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Forced shutdown (stop timeout)
  // -------------------------------------------------------------------------

  describe('forced shutdown (stop timeout)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('kills container when graceful stop times out', async () => {
      const managed = await manager.spawn(spawnRequest());
      const killSpy = vi.spyOn(runtime, 'kill');

      // Make stop() hang forever
      runtime.simulateStopTimeout();

      const shutdownPromise = manager.shutdown(managed.session.sessionId);
      await vi.advanceTimersByTimeAsync(600); // past 500ms timeout
      await shutdownPromise;

      expect(killSpy).toHaveBeenCalledOnce();
      expect(killSpy).toHaveBeenCalledWith(managed.handle);
    });

    it('session is cleaned up even after forced kill', async () => {
      const managed = await manager.spawn(spawnRequest());
      const sessionId = managed.session.sessionId;

      runtime.simulateStopTimeout();

      const shutdownPromise = manager.shutdown(sessionId);
      await vi.advanceTimersByTimeAsync(600);
      await shutdownPromise;

      expect(sessionManager.get(sessionId)).toBeNull();
    });

    it('container is removed after forced kill', async () => {
      const managed = await manager.spawn(spawnRequest());
      const removeSpy = vi.spyOn(runtime, 'remove');

      runtime.simulateStopTimeout();

      const shutdownPromise = manager.shutdown(managed.session.sessionId);
      await vi.advanceTimersByTimeAsync(600);
      await shutdownPromise;

      expect(removeSpy).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Orphan cleanup
  // -------------------------------------------------------------------------

  describe('orphan cleanup', () => {
    it('kills and removes running orphan containers', async () => {
      // Create orphan containers directly through the runtime (not lifecycle manager)
      const h1 = await runtime.run({
        image: 'old-agent:1.0',
        name: 'orphan-1',
        readOnly: true,
        networkDisabled: true,
        volumes: [],
        socketMounts: [],
        env: {},
      });
      const h2 = await runtime.run({
        image: 'old-agent:1.0',
        name: 'orphan-2',
        readOnly: true,
        networkDisabled: true,
        volumes: [],
        socketMounts: [],
        env: {},
      });

      // Both should be running
      expect((await runtime.inspect(h1)).status).toBe('running');
      expect((await runtime.inspect(h2)).status).toBe('running');

      const cleaned = await manager.cleanupOrphans([h1, h2]);

      expect(cleaned).toHaveLength(2);
      // Both should be removed (inspect throws)
      await expect(runtime.inspect(h1)).rejects.toThrow('not found');
      await expect(runtime.inspect(h2)).rejects.toThrow('not found');
    });

    it('removes stopped orphan containers without killing', async () => {
      const h = await runtime.run({
        image: 'old-agent:1.0',
        name: 'stopped-orphan',
        readOnly: true,
        networkDisabled: true,
        volumes: [],
        socketMounts: [],
        env: {},
      });

      // Stop the container (it's no longer running)
      await runtime.stop(h);
      expect((await runtime.inspect(h)).status).toBe('stopped');

      const killSpy = vi.spyOn(runtime, 'kill');
      const cleaned = await manager.cleanupOrphans([h]);

      expect(cleaned).toHaveLength(1);
      expect(killSpy).not.toHaveBeenCalled(); // no kill needed
    });

    it('skips containers that no longer exist', async () => {
      const fakeHandle: ContainerHandle = {
        id: 'nonexistent-container',
        name: 'ghost',
        runtime: 'docker',
      };

      const cleaned = await manager.cleanupOrphans([fakeHandle]);
      expect(cleaned).toHaveLength(0);
    });

    it('returns handles of successfully cleaned containers', async () => {
      const h1 = await runtime.run({
        image: 'old:1.0',
        name: 'orphan-a',
        readOnly: true,
        networkDisabled: true,
        volumes: [],
        socketMounts: [],
        env: {},
      });

      const fakeHandle: ContainerHandle = {
        id: 'ghost-container',
        name: 'ghost',
        runtime: 'docker',
      };

      const cleaned = await manager.cleanupOrphans([h1, fakeHandle]);

      // Only the real container was cleaned
      expect(cleaned).toHaveLength(1);
      expect(cleaned[0]!.id).toBe(h1.id);
    });

    it('does not affect currently managed containers', async () => {
      // Spawn a managed container
      const managed = await manager.spawn(spawnRequest());

      // Create an orphan
      const orphan = await runtime.run({
        image: 'old:1.0',
        name: 'orphan',
        readOnly: true,
        networkDisabled: true,
        volumes: [],
        socketMounts: [],
        env: {},
      });

      await manager.cleanupOrphans([orphan]);

      // Managed container is still tracked and running
      expect(manager.getAll()).toHaveLength(1);
      const state = await runtime.inspect(managed.handle);
      expect(state.status).toBe('running');
    });

    it('handles mix of running, stopped, and dead orphans', async () => {
      const running = await runtime.run({
        image: 'old:1.0',
        name: 'running-orphan',
        readOnly: true,
        networkDisabled: true,
        volumes: [],
        socketMounts: [],
        env: {},
      });

      const stopped = await runtime.run({
        image: 'old:1.0',
        name: 'stopped-orphan',
        readOnly: true,
        networkDisabled: true,
        volumes: [],
        socketMounts: [],
        env: {},
      });
      await runtime.stop(stopped);

      const dead = await runtime.run({
        image: 'old:1.0',
        name: 'dead-orphan',
        readOnly: true,
        networkDisabled: true,
        volumes: [],
        socketMounts: [],
        env: {},
      });
      await runtime.kill(dead);

      const cleaned = await manager.cleanupOrphans([running, stopped, dead]);
      expect(cleaned).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle
  // -------------------------------------------------------------------------

  describe('full lifecycle', () => {
    it('spawn → verify running → shutdown → verify clean', async () => {
      // 1. Spawn
      const managed = await manager.spawn(spawnRequest({ group: 'email' }));

      // 2. Verify running
      const status = await manager.getStatus(managed.session.sessionId);
      expect(status!.status).toBe('running');
      expect(sessionManager.get(managed.session.sessionId)).not.toBeNull();

      // 3. Shutdown
      const result = await manager.shutdown(managed.session.sessionId);
      expect(result).toBe(true);

      // 4. Verify clean
      expect(manager.getAll()).toHaveLength(0);
      expect(sessionManager.getAll()).toHaveLength(0);
      expect(runtime.getRunningHandles()).toHaveLength(0);
    });

    it('spawn multiple → shutdown some → shutdownAll → all clean', async () => {
      const m1 = await manager.spawn(spawnRequest({ group: 'email' }));
      const m2 = await manager.spawn(spawnRequest({ group: 'slack' }));
      const m3 = await manager.spawn(spawnRequest({ group: 'cron' }));

      // Shutdown one
      await manager.shutdown(m1.session.sessionId);
      expect(manager.getAll()).toHaveLength(2);

      // Shutdown remaining
      await manager.shutdownAll();
      expect(manager.getAll()).toHaveLength(0);
      expect(sessionManager.getAll()).toHaveLength(0);

      // Verify all containers are removed from runtime
      await expect(runtime.inspect(m1.handle)).rejects.toThrow();
      await expect(runtime.inspect(m2.handle)).rejects.toThrow();
      await expect(runtime.inspect(m3.handle)).rejects.toThrow();
    });

    it('spawn → crash detection → shutdown cleans up', async () => {
      const managed = await manager.spawn(spawnRequest());

      // Simulate an unexpected crash
      runtime.simulateCrash(managed.handle);

      // Status shows dead
      const status = await manager.getStatus(managed.session.sessionId);
      expect(status!.status).toBe('dead');
      expect(status!.exitCode).toBe(137);

      // Shutdown still works (cleans up the dead container)
      const result = await manager.shutdown(managed.session.sessionId);
      expect(result).toBe(true);
      expect(sessionManager.get(managed.session.sessionId)).toBeNull();
    });

    it('full lifecycle with workspace volume', async () => {
      const managed = await manager.spawn(
        spawnRequest({
          group: 'dev',
          workspacePath: '/home/user/project',
        }),
      );

      expect(managed.session.group).toBe('dev');
      const status = await manager.getStatus(managed.session.sessionId);
      expect(status!.status).toBe('running');

      await manager.shutdown(managed.session.sessionId);
      expect(manager.getAll()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error recovery
  // -------------------------------------------------------------------------

  describe('error recovery', () => {
    it('shutdown handles runtime.remove failure gracefully', async () => {
      const managed = await manager.spawn(spawnRequest());
      vi.spyOn(runtime, 'remove').mockRejectedValueOnce(new Error('Device busy'));

      // Shutdown should still succeed
      const result = await manager.shutdown(managed.session.sessionId);
      expect(result).toBe(true);

      // Session is still cleaned up
      expect(sessionManager.get(managed.session.sessionId)).toBeNull();
    });

    it('shutdown handles runtime.stop failure gracefully', async () => {
      const managed = await manager.spawn(spawnRequest());
      vi.spyOn(runtime, 'stop').mockRejectedValueOnce(new Error('Container stuck'));

      const killSpy = vi.spyOn(runtime, 'kill');

      // Shutdown should fall through to kill
      const result = await manager.shutdown(managed.session.sessionId);
      expect(result).toBe(true);
      expect(killSpy).toHaveBeenCalledOnce();
    });

    it('shutdown handles both stop and kill failure gracefully', async () => {
      const managed = await manager.spawn(spawnRequest());
      vi.spyOn(runtime, 'stop').mockRejectedValueOnce(new Error('Stop failed'));
      vi.spyOn(runtime, 'kill').mockRejectedValueOnce(new Error('Kill failed'));

      // Should still succeed — session is cleaned up regardless
      const result = await manager.shutdown(managed.session.sessionId);
      expect(result).toBe(true);
      expect(sessionManager.get(managed.session.sessionId)).toBeNull();
    });

    it('shutdownAll completes even if individual shutdowns fail', async () => {
      await manager.spawn(spawnRequest({ group: 'a' }));
      await manager.spawn(spawnRequest({ group: 'b' }));
      await manager.spawn(spawnRequest({ group: 'c' }));

      // Make stop fail for all containers
      vi.spyOn(runtime, 'stop').mockRejectedValue(new Error('Stop broken'));

      // shutdownAll should still complete (falls through to kill)
      await manager.shutdownAll();
      expect(manager.getAll()).toHaveLength(0);
      expect(sessionManager.getAll()).toHaveLength(0);
    });

    it('cleanup after test failure: shutdownAll guarantees no leaks', async () => {
      // Simulate a test that spawns containers but fails partway
      const m1 = await manager.spawn(spawnRequest({ group: 'a' }));
      const m2 = await manager.spawn(spawnRequest({ group: 'b' }));

      // Simulate partial work (crash one)
      runtime.simulateCrash(m1.handle);

      // In a test afterEach, shutdownAll would clean everything
      await manager.shutdownAll();

      // Everything is clean
      expect(manager.getAll()).toHaveLength(0);
      expect(sessionManager.getAll()).toHaveLength(0);
      await expect(runtime.inspect(m1.handle)).rejects.toThrow();
      await expect(runtime.inspect(m2.handle)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Network configuration
  // -------------------------------------------------------------------------

  describe('network configuration', () => {
    it('uses network isolation by default', async () => {
      const runSpy = vi.spyOn(runtime, 'run');
      await manager.spawn(spawnRequest());

      const options = runSpy.mock.calls[0]![0]!;
      expect(options.networkDisabled).toBe(true);
      expect(options.network).toBeUndefined();
    });

    it('uses named network when configured', async () => {
      const networkManager = new ContainerLifecycleManager({
        runtime,
        sessionManager,
        networkName: 'carapace-allowlist',
      });

      const runSpy = vi.spyOn(runtime, 'run');
      await networkManager.spawn(spawnRequest());

      const options = runSpy.mock.calls[0]![0]!;
      expect(options.networkDisabled).toBe(false);
      expect(options.network).toBe('carapace-allowlist');

      await networkManager.shutdownAll();
    });
  });

  // -------------------------------------------------------------------------
  // Container status tracking
  // -------------------------------------------------------------------------

  describe('container status tracking', () => {
    it('getStatus returns running state for active container', async () => {
      const managed = await manager.spawn(spawnRequest());
      const status = await manager.getStatus(managed.session.sessionId);

      expect(status).not.toBeNull();
      expect(status!.status).toBe('running');
    });

    it('getStatus returns null for unknown session', async () => {
      const status = await manager.getStatus('unknown-session');
      expect(status).toBeNull();
    });

    it('getStatus reflects crash state', async () => {
      const managed = await manager.spawn(spawnRequest());
      runtime.simulateCrash(managed.handle);

      const status = await manager.getStatus(managed.session.sessionId);
      expect(status!.status).toBe('dead');
      expect(status!.exitCode).toBe(137);
    });

    it('getAll returns all tracked containers', async () => {
      const m1 = await manager.spawn(spawnRequest({ group: 'a' }));
      const m2 = await manager.spawn(spawnRequest({ group: 'b' }));

      const all = manager.getAll();
      expect(all).toHaveLength(2);

      const sessionIds = all.map((m) => m.session.sessionId);
      expect(sessionIds).toContain(m1.session.sessionId);
      expect(sessionIds).toContain(m2.session.sessionId);
    });
  });
});
