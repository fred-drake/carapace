import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from './session-manager.js';
import { MockContainerRuntime } from './container/mock-runtime.js';
import type { ContainerRunOptions } from './container/runtime.js';
import { configureLogging, resetLogging, type LogEntry, type LogSink } from './logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultRunOptions(overrides?: Partial<ContainerRunOptions>): ContainerRunOptions {
  return {
    image: 'carapace-agent:latest',
    name: 'test-container',
    readOnly: true,
    networkDisabled: true,
    volumes: [{ source: '/host/workspace', target: '/workspace', readonly: false }],
    socketMounts: [{ hostPath: '/tmp/carapace.sock', containerPath: '/sockets/carapace.sock' }],
    env: { NODE_ENV: 'test' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  let manager: SessionManager;
  let runtime: MockContainerRuntime;

  beforeEach(() => {
    runtime = new MockContainerRuntime();
    manager = new SessionManager();
  });

  // -----------------------------------------------------------------------
  // Session CRUD
  // -----------------------------------------------------------------------

  describe('create', () => {
    it('creates a session from container info and group', async () => {
      const container = await runtime.run(defaultRunOptions({ name: 'agent-1' }));

      const session = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: `identity-${container.id}`,
      });

      expect(session.sessionId).toBeDefined();
      expect(session.containerId).toBe(container.id);
      expect(session.group).toBe('email');
      expect(session.connectionIdentity).toBe(`identity-${container.id}`);
      expect(session.startedAt).toBeDefined();
      expect(new Date(session.startedAt).toISOString()).toBe(session.startedAt);
    });

    it('assigns unique session IDs', async () => {
      const c1 = await runtime.run(defaultRunOptions({ name: 'a' }));
      const c2 = await runtime.run(defaultRunOptions({ name: 'b' }));

      const s1 = manager.create({
        containerId: c1.id,
        group: 'group-a',
        connectionIdentity: `identity-${c1.id}`,
      });
      const s2 = manager.create({
        containerId: c2.id,
        group: 'group-b',
        connectionIdentity: `identity-${c2.id}`,
      });

      expect(s1.sessionId).not.toBe(s2.sessionId);
    });
  });

  describe('get', () => {
    it('retrieves a session by session ID', async () => {
      const container = await runtime.run(defaultRunOptions());

      const created = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: `identity-${container.id}`,
      });

      const retrieved = manager.get(created.sessionId);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.sessionId).toBe(created.sessionId);
      expect(retrieved!.containerId).toBe(container.id);
      expect(retrieved!.group).toBe('email');
    });

    it('returns null for a non-existent session ID', () => {
      const result = manager.get('nonexistent-session');
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes a session by session ID', async () => {
      const container = await runtime.run(defaultRunOptions());

      const session = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: `identity-${container.id}`,
      });

      const deleted = manager.delete(session.sessionId);
      expect(deleted).toBe(true);

      expect(manager.get(session.sessionId)).toBeNull();
    });

    it('returns false when deleting a non-existent session', () => {
      const deleted = manager.delete('nonexistent');
      expect(deleted).toBe(false);
    });

    it('removes the connection identity mapping on delete', async () => {
      const container = await runtime.run(defaultRunOptions());

      const session = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: `identity-${container.id}`,
      });

      manager.delete(session.sessionId);

      expect(manager.getByConnectionIdentity(`identity-${container.id}`)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Connection → session mapping
  // -----------------------------------------------------------------------

  describe('getByConnectionIdentity', () => {
    it('looks up a session by ZeroMQ connection identity', async () => {
      const container = await runtime.run(defaultRunOptions());

      const created = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: `identity-${container.id}`,
      });

      const found = manager.getByConnectionIdentity(`identity-${container.id}`);

      expect(found).not.toBeNull();
      expect(found!.sessionId).toBe(created.sessionId);
      expect(found!.group).toBe('email');
    });

    it('returns null for unknown connection identity', () => {
      const result = manager.getByConnectionIdentity('unknown-identity');
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // toSessionContext — bridge to pipeline SessionContext
  // -----------------------------------------------------------------------

  describe('toSessionContext', () => {
    it('converts a session to a pipeline SessionContext', async () => {
      const container = await runtime.run(defaultRunOptions());

      const session = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: `identity-${container.id}`,
      });

      const ctx = manager.toSessionContext(session.sessionId);

      expect(ctx).not.toBeNull();
      expect(ctx!.sessionId).toBe(session.sessionId);
      expect(ctx!.group).toBe('email');
      expect(ctx!.source).toBe(container.id);
      expect(ctx!.startedAt).toBe(session.startedAt);
    });

    it('returns null for a non-existent session', () => {
      const ctx = manager.toSessionContext('nonexistent');
      expect(ctx).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent session isolation
  // -----------------------------------------------------------------------

  describe('concurrent session isolation', () => {
    it('sessions for different groups are fully isolated', async () => {
      const c1 = await runtime.run(defaultRunOptions({ name: 'email-agent' }));
      const c2 = await runtime.run(defaultRunOptions({ name: 'slack-agent' }));

      const emailSession = manager.create({
        containerId: c1.id,
        group: 'email',
        connectionIdentity: `identity-${c1.id}`,
      });
      const slackSession = manager.create({
        containerId: c2.id,
        group: 'slack',
        connectionIdentity: `identity-${c2.id}`,
      });

      // Each session has its own identity
      expect(emailSession.sessionId).not.toBe(slackSession.sessionId);
      expect(emailSession.group).toBe('email');
      expect(slackSession.group).toBe('slack');

      // Connection identity lookups return correct sessions
      const foundEmail = manager.getByConnectionIdentity(`identity-${c1.id}`);
      const foundSlack = manager.getByConnectionIdentity(`identity-${c2.id}`);

      expect(foundEmail!.group).toBe('email');
      expect(foundSlack!.group).toBe('slack');
    });

    it('deleting one session does not affect others', async () => {
      const c1 = await runtime.run(defaultRunOptions({ name: 'a' }));
      const c2 = await runtime.run(defaultRunOptions({ name: 'b' }));

      const s1 = manager.create({
        containerId: c1.id,
        group: 'group-a',
        connectionIdentity: `identity-${c1.id}`,
      });
      const s2 = manager.create({
        containerId: c2.id,
        group: 'group-b',
        connectionIdentity: `identity-${c2.id}`,
      });

      manager.delete(s1.sessionId);

      expect(manager.get(s1.sessionId)).toBeNull();
      expect(manager.get(s2.sessionId)).not.toBeNull();
      expect(manager.getByConnectionIdentity(`identity-${c2.id}`)).not.toBeNull();
    });

    it('getAll returns all active sessions', async () => {
      const c1 = await runtime.run(defaultRunOptions({ name: 'a' }));
      const c2 = await runtime.run(defaultRunOptions({ name: 'b' }));
      const c3 = await runtime.run(defaultRunOptions({ name: 'c' }));

      manager.create({
        containerId: c1.id,
        group: 'g1',
        connectionIdentity: `identity-${c1.id}`,
      });
      manager.create({
        containerId: c2.id,
        group: 'g2',
        connectionIdentity: `identity-${c2.id}`,
      });
      manager.create({
        containerId: c3.id,
        group: 'g3',
        connectionIdentity: `identity-${c3.id}`,
      });

      const all = manager.getAll();
      expect(all).toHaveLength(3);

      const groups = all.map((s) => s.group).sort();
      expect(groups).toEqual(['g1', 'g2', 'g3']);
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup on teardown
  // -----------------------------------------------------------------------

  describe('cleanup', () => {
    it('removes all sessions', async () => {
      const c1 = await runtime.run(defaultRunOptions({ name: 'a' }));
      const c2 = await runtime.run(defaultRunOptions({ name: 'b' }));

      manager.create({
        containerId: c1.id,
        group: 'g1',
        connectionIdentity: `identity-${c1.id}`,
      });
      manager.create({
        containerId: c2.id,
        group: 'g2',
        connectionIdentity: `identity-${c2.id}`,
      });

      expect(manager.getAll()).toHaveLength(2);

      manager.cleanup();

      expect(manager.getAll()).toHaveLength(0);
    });

    it('clears connection identity mappings on cleanup', async () => {
      const container = await runtime.run(defaultRunOptions());

      manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: `identity-${container.id}`,
      });

      manager.cleanup();

      expect(manager.getByConnectionIdentity(`identity-${container.id}`)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('throws on duplicate connection identity', async () => {
      const container = await runtime.run(defaultRunOptions());

      manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: `identity-${container.id}`,
      });

      expect(() =>
        manager.create({
          containerId: 'different-container',
          group: 'slack',
          connectionIdentity: `identity-${container.id}`,
        }),
      ).toThrow(/connection identity.*already in use/i);
    });

    it('throws on duplicate container ID', async () => {
      const container = await runtime.run(defaultRunOptions());

      manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: `identity-${container.id}`,
      });

      expect(() =>
        manager.create({
          containerId: container.id,
          group: 'slack',
          connectionIdentity: 'different-identity',
        }),
      ).toThrow(/container.*already has a session/i);
    });

    it('getByContainerId returns session for a container', async () => {
      const container = await runtime.run(defaultRunOptions());

      const created = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: `identity-${container.id}`,
      });

      const found = manager.getByContainerId(container.id);
      expect(found).not.toBeNull();
      expect(found!.sessionId).toBe(created.sessionId);
    });

    it('getByContainerId returns null for unknown container', () => {
      expect(manager.getByContainerId('unknown')).toBeNull();
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

    it('logs session created with group and container ID', async () => {
      const container = await runtime.run(defaultRunOptions());

      manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: `identity-${container.id}`,
      });

      const createLog = logEntries.find((e) => e.msg === 'session created');
      expect(createLog).toBeDefined();
      expect(createLog!.group).toBe('email');
      expect(createLog!.meta?.containerId).toBe(container.id);
    });

    it('logs session deleted with session ID', async () => {
      const container = await runtime.run(defaultRunOptions());

      const session = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: `identity-${container.id}`,
      });

      manager.delete(session.sessionId);

      const deleteLog = logEntries.find((e) => e.msg === 'session deleted');
      expect(deleteLog).toBeDefined();
      expect(deleteLog!.session).toBe(session.sessionId);
    });

    it('logs all sessions cleared on cleanup', async () => {
      const c1 = await runtime.run(defaultRunOptions({ name: 'a' }));
      const c2 = await runtime.run(defaultRunOptions({ name: 'b' }));

      manager.create({
        containerId: c1.id,
        group: 'g1',
        connectionIdentity: `identity-${c1.id}`,
      });
      manager.create({
        containerId: c2.id,
        group: 'g2',
        connectionIdentity: `identity-${c2.id}`,
      });

      manager.cleanup();

      const cleanupLog = logEntries.find((e) => e.msg === 'all sessions cleared');
      expect(cleanupLog).toBeDefined();
      expect(cleanupLog!.meta?.count).toBe(2);
    });
  });
});
