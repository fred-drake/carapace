import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { ContainerLifecycleManager } from './lifecycle-manager.js';
import { MockContainerRuntime } from './mock-runtime.js';
import { SessionManager } from '../session-manager.js';
import type { ContainerHandle } from './runtime.js';
import { configureLogging, resetLogging, type LogEntry, type LogSink } from '../logger.js';
import { ContainerOutputReader } from '../container-output-reader.js';

const mockStart = vi.fn();
vi.mock('../container-output-reader.js', () => ({
  ContainerOutputReader: vi.fn(() => ({
    start: mockStart,
  })),
}));

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

  // -----------------------------------------------------------------------
  // Logging
  // -----------------------------------------------------------------------

  describe('logging', () => {
    let logEntries: LogEntry[];

    beforeEach(() => {
      logEntries = [];
      const logSink: LogSink = (entry) => logEntries.push(entry);
      configureLogging({ level: 'debug', sink: logSink });
    });

    afterEach(() => {
      resetLogging();
    });

    it('logs container spawn with group and image', async () => {
      await manager.spawn(defaultSpawnRequest());

      const spawnLog = logEntries.find((e) => e.msg === 'spawning container');
      expect(spawnLog).toBeDefined();
      expect(spawnLog!.group).toBe('email');
      expect(spawnLog!.meta?.image).toBe('carapace-agent:latest');
    });

    it('logs container spawned with session and container IDs', async () => {
      const result = await manager.spawn(defaultSpawnRequest());

      const spawnedLog = logEntries.find((e) => e.msg === 'container spawned');
      expect(spawnedLog).toBeDefined();
      expect(spawnedLog!.session).toBe(result.session.sessionId);
      expect(spawnedLog!.meta?.containerId).toBe(result.handle.id);
    });

    it('logs hasStdinData flag without logging actual stdinData', async () => {
      await manager.spawn(defaultSpawnRequest({ stdinData: 'ANTHROPIC_API_KEY=sk-secret\n\n' }));

      const spawnLog = logEntries.find((e) => e.msg === 'spawning container');
      expect(spawnLog).toBeDefined();
      expect(spawnLog!.meta?.hasStdinData).toBe(true);

      // Verify no credential values in any log entry
      const allJson = JSON.stringify(logEntries);
      expect(allJson).not.toContain('sk-secret');
      expect(allJson).not.toContain('ANTHROPIC_API_KEY');
    });

    it('logs container shutdown', async () => {
      const { session } = await manager.spawn(defaultSpawnRequest());
      await manager.shutdown(session.sessionId);

      const shutdownLog = logEntries.find((e) => e.msg === 'container shut down');
      expect(shutdownLog).toBeDefined();
      expect(shutdownLog!.session).toBe(session.sessionId);
    });

    it('logs orphan cleanup count', async () => {
      await manager.cleanupOrphans([]);

      const cleanupLog = logEntries.find((e) => e.msg === 'orphan cleanup complete');
      expect(cleanupLog).toBeDefined();
      expect(cleanupLog!.meta?.cleaned).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Env var mapping: CARAPACE_RESUME_SESSION_ID → CARAPACE_RESUME_SESSION
  // -----------------------------------------------------------------------

  describe('resume session env mapping', () => {
    it('maps CARAPACE_RESUME_SESSION_ID to CARAPACE_RESUME_SESSION in container env', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(
        defaultSpawnRequest({ env: { CARAPACE_RESUME_SESSION_ID: 'sess-abc-123' } }),
      );

      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.env['CARAPACE_RESUME_SESSION']).toBe('sess-abc-123');
    });

    it('removes CARAPACE_RESUME_SESSION_ID from container env after mapping', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(
        defaultSpawnRequest({ env: { CARAPACE_RESUME_SESSION_ID: 'sess-abc-123' } }),
      );

      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.env['CARAPACE_RESUME_SESSION_ID']).toBeUndefined();
    });

    it('passes through other env vars unchanged when mapping resume session', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(
        defaultSpawnRequest({
          env: {
            MY_VAR: 'hello',
            CARAPACE_RESUME_SESSION_ID: 'sess-xyz',
            CARAPACE_TASK_PROMPT: 'do stuff',
          },
        }),
      );

      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.env['MY_VAR']).toBe('hello');
      expect(callOptions.env['CARAPACE_TASK_PROMPT']).toBe('do stuff');
      expect(callOptions.env['CARAPACE_RESUME_SESSION']).toBe('sess-xyz');
    });

    it('does not set CARAPACE_RESUME_SESSION when CARAPACE_RESUME_SESSION_ID is absent', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(defaultSpawnRequest({ env: { MY_VAR: 'test' } }));

      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.env['CARAPACE_RESUME_SESSION']).toBeUndefined();
      expect(callOptions.env['MY_VAR']).toBe('test');
    });
  });

  // -----------------------------------------------------------------------
  // Claude state path volume mount
  // -----------------------------------------------------------------------

  describe('claude state path', () => {
    it('mounts claudeStatePath as writable volume at /home/user/.claude', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(defaultSpawnRequest({ claudeStatePath: '/data/claude-state/email' }));

      const callOptions = runSpy.mock.calls[0][0];
      const stateVolume = callOptions.volumes.find(
        (v: { target: string }) => v.target === '/home/user/.claude',
      );
      expect(stateVolume).toBeDefined();
      expect(stateVolume!.source).toBe('/data/claude-state/email');
      expect(stateVolume!.readonly).toBe(false);
    });

    it('does not add claude state volume when claudeStatePath is not provided', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(defaultSpawnRequest());

      const callOptions = runSpy.mock.calls[0][0];
      const stateVolume = callOptions.volumes.find(
        (v: { target: string }) => v.target === '/home/user/.claude',
      );
      expect(stateVolume).toBeUndefined();
    });

    it('mounts both workspace and claude state volumes when both provided', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(
        defaultSpawnRequest({
          workspacePath: '/home/user/workspace',
          claudeStatePath: '/data/claude-state/email',
        }),
      );

      const callOptions = runSpy.mock.calls[0][0];
      expect(callOptions.volumes).toHaveLength(2);

      const wsVolume = callOptions.volumes.find(
        (v: { target: string }) => v.target === '/workspace',
      );
      const stateVolume = callOptions.volumes.find(
        (v: { target: string }) => v.target === '/home/user/.claude',
      );
      expect(wsVolume).toBeDefined();
      expect(stateVolume).toBeDefined();
    });

    it('each group gets its own isolated claude state path', async () => {
      const runSpy = vi.spyOn(runtime, 'run');

      await manager.spawn(
        defaultSpawnRequest({
          group: 'email',
          claudeStatePath: '/data/claude-state/email',
        }),
      );
      await manager.spawn(
        defaultSpawnRequest({
          group: 'slack',
          claudeStatePath: '/data/claude-state/slack',
          socketPath: '/tmp/sockets/s2.sock',
        }),
      );

      const emailOpts = runSpy.mock.calls[0][0];
      const slackOpts = runSpy.mock.calls[1][0];

      const emailState = emailOpts.volumes.find(
        (v: { target: string }) => v.target === '/home/user/.claude',
      );
      const slackState = slackOpts.volumes.find(
        (v: { target: string }) => v.target === '/home/user/.claude',
      );

      expect(emailState!.source).toBe('/data/claude-state/email');
      expect(slackState!.source).toBe('/data/claude-state/slack');
      expect(emailState!.source).not.toBe(slackState!.source);
    });
  });

  // -----------------------------------------------------------------------
  // ContainerOutputReader integration
  // -----------------------------------------------------------------------

  describe('container output reader', () => {
    const MockedOutputReader = vi.mocked(ContainerOutputReader);

    function createStreamingManager(overrides?: {
      eventBus?: { publish: ReturnType<typeof vi.fn> };
      claudeSessionStore?: {
        save: ReturnType<typeof vi.fn>;
        getLatest: ReturnType<typeof vi.fn>;
      };
    }) {
      return new ContainerLifecycleManager({
        runtime,
        sessionManager,
        eventBus: overrides?.eventBus ?? { publish: vi.fn() },
        claudeSessionStore: overrides?.claudeSessionStore ?? {
          save: vi.fn(),
          getLatest: vi.fn().mockReturnValue(null),
        },
      });
    }

    beforeEach(() => {
      MockedOutputReader.mockClear();
      mockStart.mockClear();
    });

    it('creates and starts output reader when stdout, eventBus, and claudeSessionStore are available', async () => {
      const stdout = new PassThrough();
      runtime.simulateStdout(stdout);

      const streamManager = createStreamingManager();
      const result = await streamManager.spawn(defaultSpawnRequest());

      expect(MockedOutputReader).toHaveBeenCalledOnce();
      expect(mockStart).toHaveBeenCalledOnce();
      expect(mockStart).toHaveBeenCalledWith(stdout, {
        sessionId: result.session.sessionId,
        group: 'email',
        containerId: result.handle.id,
      });

      stdout.end();
    });

    it('does not create reader when eventBus is missing', async () => {
      const stdout = new PassThrough();
      runtime.simulateStdout(stdout);

      const noEventBusManager = new ContainerLifecycleManager({
        runtime,
        sessionManager,
        claudeSessionStore: { save: vi.fn(), getLatest: vi.fn().mockReturnValue(null) },
      });

      await noEventBusManager.spawn(defaultSpawnRequest());

      expect(MockedOutputReader).not.toHaveBeenCalled();

      stdout.end();
    });

    it('does not create reader when claudeSessionStore is missing', async () => {
      const stdout = new PassThrough();
      runtime.simulateStdout(stdout);

      const noStoreManager = new ContainerLifecycleManager({
        runtime,
        sessionManager,
        eventBus: { publish: vi.fn() },
      });

      await noStoreManager.spawn(defaultSpawnRequest());

      expect(MockedOutputReader).not.toHaveBeenCalled();

      stdout.end();
    });

    it('does not create reader when handle has no stdout', async () => {
      // Default mock runtime does not provide stdout
      const streamManager = createStreamingManager();
      await streamManager.spawn(defaultSpawnRequest());

      expect(MockedOutputReader).not.toHaveBeenCalled();
    });

    it('passes eventBus and claudeSessionStore to output reader', async () => {
      const stdout = new PassThrough();
      runtime.simulateStdout(stdout);

      const eventBus = { publish: vi.fn() };
      const claudeSessionStore = { save: vi.fn(), getLatest: vi.fn().mockReturnValue(null) };

      const streamManager = createStreamingManager({ eventBus, claudeSessionStore });
      await streamManager.spawn(defaultSpawnRequest());

      expect(MockedOutputReader).toHaveBeenCalledWith(
        expect.objectContaining({
          eventBus,
          claudeSessionStore,
        }),
      );

      stdout.end();
    });
  });

  // -----------------------------------------------------------------------
  // Backward compatibility
  // -----------------------------------------------------------------------

  describe('backward compatibility', () => {
    it('spawn works without streaming deps (eventBus, claudeSessionStore)', async () => {
      // Default manager has no streaming deps
      const result = await manager.spawn(defaultSpawnRequest());

      expect(result.handle).toBeDefined();
      expect(result.session).toBeDefined();
    });

    it('spawn works with stdout handle but no streaming deps', async () => {
      const stdout = new PassThrough();
      runtime.simulateStdout(stdout);

      const result = await manager.spawn(defaultSpawnRequest());

      expect(result.handle).toBeDefined();
      expect(result.handle.stdout).toBe(stdout);

      stdout.end();
    });
  });
});
