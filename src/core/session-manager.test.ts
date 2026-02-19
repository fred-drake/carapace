import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from './session-manager.js';
import { MockContainerRuntime } from '../testing/mock-container-runtime.js';
import type { SpawnOptions } from './container-runtime.js';

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
      const container = await runtime.spawn(defaultSpawnOptions({ name: 'agent-1' }));

      const session = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: container.connectionIdentity,
      });

      expect(session.sessionId).toBeDefined();
      expect(session.containerId).toBe(container.id);
      expect(session.group).toBe('email');
      expect(session.connectionIdentity).toBe(container.connectionIdentity);
      expect(session.startedAt).toBeDefined();
      expect(new Date(session.startedAt).toISOString()).toBe(session.startedAt);
    });

    it('assigns unique session IDs', async () => {
      const c1 = await runtime.spawn(defaultSpawnOptions({ name: 'a' }));
      const c2 = await runtime.spawn(defaultSpawnOptions({ name: 'b' }));

      const s1 = manager.create({
        containerId: c1.id,
        group: 'group-a',
        connectionIdentity: c1.connectionIdentity,
      });
      const s2 = manager.create({
        containerId: c2.id,
        group: 'group-b',
        connectionIdentity: c2.connectionIdentity,
      });

      expect(s1.sessionId).not.toBe(s2.sessionId);
    });
  });

  describe('get', () => {
    it('retrieves a session by session ID', async () => {
      const container = await runtime.spawn(defaultSpawnOptions());

      const created = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: container.connectionIdentity,
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
      const container = await runtime.spawn(defaultSpawnOptions());

      const session = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: container.connectionIdentity,
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
      const container = await runtime.spawn(defaultSpawnOptions());

      const session = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: container.connectionIdentity,
      });

      manager.delete(session.sessionId);

      expect(manager.getByConnectionIdentity(container.connectionIdentity)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Connection → session mapping
  // -----------------------------------------------------------------------

  describe('getByConnectionIdentity', () => {
    it('looks up a session by ZeroMQ connection identity', async () => {
      const container = await runtime.spawn(defaultSpawnOptions());

      const created = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: container.connectionIdentity,
      });

      const found = manager.getByConnectionIdentity(container.connectionIdentity);

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
      const container = await runtime.spawn(defaultSpawnOptions());

      const session = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: container.connectionIdentity,
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
      const c1 = await runtime.spawn(defaultSpawnOptions({ name: 'email-agent' }));
      const c2 = await runtime.spawn(defaultSpawnOptions({ name: 'slack-agent' }));

      const emailSession = manager.create({
        containerId: c1.id,
        group: 'email',
        connectionIdentity: c1.connectionIdentity,
      });
      const slackSession = manager.create({
        containerId: c2.id,
        group: 'slack',
        connectionIdentity: c2.connectionIdentity,
      });

      // Each session has its own identity
      expect(emailSession.sessionId).not.toBe(slackSession.sessionId);
      expect(emailSession.group).toBe('email');
      expect(slackSession.group).toBe('slack');

      // Connection identity lookups return correct sessions
      const foundEmail = manager.getByConnectionIdentity(c1.connectionIdentity);
      const foundSlack = manager.getByConnectionIdentity(c2.connectionIdentity);

      expect(foundEmail!.group).toBe('email');
      expect(foundSlack!.group).toBe('slack');
    });

    it('deleting one session does not affect others', async () => {
      const c1 = await runtime.spawn(defaultSpawnOptions({ name: 'a' }));
      const c2 = await runtime.spawn(defaultSpawnOptions({ name: 'b' }));

      const s1 = manager.create({
        containerId: c1.id,
        group: 'group-a',
        connectionIdentity: c1.connectionIdentity,
      });
      const s2 = manager.create({
        containerId: c2.id,
        group: 'group-b',
        connectionIdentity: c2.connectionIdentity,
      });

      manager.delete(s1.sessionId);

      expect(manager.get(s1.sessionId)).toBeNull();
      expect(manager.get(s2.sessionId)).not.toBeNull();
      expect(manager.getByConnectionIdentity(c2.connectionIdentity)).not.toBeNull();
    });

    it('getAll returns all active sessions', async () => {
      const c1 = await runtime.spawn(defaultSpawnOptions({ name: 'a' }));
      const c2 = await runtime.spawn(defaultSpawnOptions({ name: 'b' }));
      const c3 = await runtime.spawn(defaultSpawnOptions({ name: 'c' }));

      manager.create({
        containerId: c1.id,
        group: 'g1',
        connectionIdentity: c1.connectionIdentity,
      });
      manager.create({
        containerId: c2.id,
        group: 'g2',
        connectionIdentity: c2.connectionIdentity,
      });
      manager.create({
        containerId: c3.id,
        group: 'g3',
        connectionIdentity: c3.connectionIdentity,
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
      const c1 = await runtime.spawn(defaultSpawnOptions({ name: 'a' }));
      const c2 = await runtime.spawn(defaultSpawnOptions({ name: 'b' }));

      manager.create({
        containerId: c1.id,
        group: 'g1',
        connectionIdentity: c1.connectionIdentity,
      });
      manager.create({
        containerId: c2.id,
        group: 'g2',
        connectionIdentity: c2.connectionIdentity,
      });

      expect(manager.getAll()).toHaveLength(2);

      manager.cleanup();

      expect(manager.getAll()).toHaveLength(0);
    });

    it('clears connection identity mappings on cleanup', async () => {
      const container = await runtime.spawn(defaultSpawnOptions());

      manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: container.connectionIdentity,
      });

      manager.cleanup();

      expect(manager.getByConnectionIdentity(container.connectionIdentity)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('throws on duplicate connection identity', async () => {
      const container = await runtime.spawn(defaultSpawnOptions());

      manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: container.connectionIdentity,
      });

      expect(() =>
        manager.create({
          containerId: 'different-container',
          group: 'slack',
          connectionIdentity: container.connectionIdentity,
        }),
      ).toThrow(/connection identity.*already in use/i);
    });

    it('throws on duplicate container ID', async () => {
      const container = await runtime.spawn(defaultSpawnOptions());

      manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: container.connectionIdentity,
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
      const container = await runtime.spawn(defaultSpawnOptions());

      const created = manager.create({
        containerId: container.id,
        group: 'email',
        connectionIdentity: container.connectionIdentity,
      });

      const found = manager.getByContainerId(container.id);
      expect(found).not.toBeNull();
      expect(found!.sessionId).toBe(created.sessionId);
    });

    it('getByContainerId returns null for unknown container', () => {
      expect(manager.getByContainerId('unknown')).toBeNull();
    });
  });
});
