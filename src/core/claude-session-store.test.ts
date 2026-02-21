import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ClaudeSessionStore,
  CLAUDE_SESSION_MIGRATIONS,
  type ClaudeSessionRecord,
} from './claude-session-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

function createStore(
  db?: Database.Database,
  ttlMs?: number,
): { store: ClaudeSessionStore; db: Database.Database } {
  const database = db ?? createDb();
  const store = ClaudeSessionStore.create(database, CLAUDE_SESSION_MIGRATIONS, ttlMs);
  return { store, db: database };
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const VALID_UUID_3 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeSessionStore', () => {
  let store: ClaudeSessionStore;
  let db: Database.Database;

  beforeEach(() => {
    ({ store, db } = createStore());
  });

  afterEach(() => {
    store.close();
  });

  // -----------------------------------------------------------------------
  // Schema
  // -----------------------------------------------------------------------

  describe('schema', () => {
    it('creates claude_sessions table with correct columns', () => {
      const info = db.pragma('table_info(claude_sessions)') as Array<{ name: string }>;
      const columns = info.map((c) => c.name);
      expect(columns).toContain('group_name');
      expect(columns).toContain('claude_session_id');
      expect(columns).toContain('created_at');
      expect(columns).toContain('last_used_at');
    });

    it('creates index on group_name and last_used_at', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain('idx_sessions_group_recent');
    });
  });

  // -----------------------------------------------------------------------
  // save()
  // -----------------------------------------------------------------------

  describe('save()', () => {
    it('stores a session record', () => {
      store.save('email', VALID_UUID);

      const rows = db.prepare('SELECT * FROM claude_sessions').all() as Array<{
        group_name: string;
        claude_session_id: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.group_name).toBe('email');
      expect(rows[0]!.claude_session_id).toBe(VALID_UUID);
    });

    it('rejects invalid session ID format (not UUID)', () => {
      expect(() => store.save('email', 'not-a-uuid')).toThrow(/invalid.*session.*id/i);
      expect(() => store.save('email', '')).toThrow(/invalid.*session.*id/i);
      expect(() => store.save('email', '123')).toThrow(/invalid.*session.*id/i);
      expect(() => store.save('email', 'ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ')).toThrow(
        /invalid.*session.*id/i,
      );
    });

    it('upserts: save() with same group+sessionId updates lastUsedAt', () => {
      store.save('email', VALID_UUID);

      const rowBefore = db
        .prepare('SELECT last_used_at FROM claude_sessions WHERE claude_session_id = ?')
        .get(VALID_UUID) as { last_used_at: string };
      const beforeTs = rowBefore.last_used_at;

      // Save again — should update last_used_at
      store.save('email', VALID_UUID);

      const rowAfter = db
        .prepare('SELECT last_used_at FROM claude_sessions WHERE claude_session_id = ?')
        .get(VALID_UUID) as { last_used_at: string };

      // Count should still be 1 (upsert, not duplicate)
      const count = db.prepare('SELECT COUNT(*) as c FROM claude_sessions').get() as { c: number };
      expect(count.c).toBe(1);

      // Timestamp should be >= before (may be equal if test runs fast)
      expect(rowAfter.last_used_at >= beforeTs).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // getLatest()
  // -----------------------------------------------------------------------

  describe('getLatest()', () => {
    it('returns most recently used session for group', () => {
      store.save('email', VALID_UUID);
      store.save('email', VALID_UUID_2);

      // Backdate all, then touch VALID_UUID to give it the latest timestamp
      db.prepare(
        `UPDATE claude_sessions SET last_used_at = datetime('now', '-60 seconds')
         WHERE group_name = 'email'`,
      ).run();
      store.touch('email', VALID_UUID);

      const latest = store.getLatest('email');
      expect(latest).toBe(VALID_UUID);
    });

    it('returns null for unknown group', () => {
      const latest = store.getLatest('nonexistent');
      expect(latest).toBeNull();
    });

    it('skips expired sessions (>TTL)', () => {
      // Create store with 1-second TTL for testability
      const { store: shortTtlStore, db: shortTtlDb } = createStore(undefined, 1000);

      shortTtlStore.save('email', VALID_UUID);

      // Manually backdate the last_used_at to 2 seconds ago
      shortTtlDb
        .prepare(
          `UPDATE claude_sessions SET last_used_at = datetime('now', '-2 seconds')
         WHERE claude_session_id = ?`,
        )
        .run(VALID_UUID);

      const latest = shortTtlStore.getLatest('email');
      expect(latest).toBeNull();

      shortTtlStore.close();
    });

    it('returns non-expired session when some are expired', () => {
      // Create store with 1-hour TTL
      const { store: ttlStore, db: ttlDb } = createStore(undefined, 3600 * 1000);

      ttlStore.save('email', VALID_UUID);
      ttlStore.save('email', VALID_UUID_2);

      // Backdate the first one to 2 hours ago (expired)
      ttlDb
        .prepare(
          `UPDATE claude_sessions SET last_used_at = datetime('now', '-7200 seconds')
         WHERE claude_session_id = ?`,
        )
        .run(VALID_UUID);

      // Second should still be returned
      const latest = ttlStore.getLatest('email');
      expect(latest).toBe(VALID_UUID_2);

      ttlStore.close();
    });

    it('returns most recent when multiple sessions per group', () => {
      store.save('email', VALID_UUID);
      store.save('email', VALID_UUID_2);
      store.save('email', VALID_UUID_3);

      // Backdate all records, then touch UUID_2 to give it the latest timestamp
      db.prepare(
        `UPDATE claude_sessions SET last_used_at = datetime('now', '-60 seconds')
         WHERE group_name = 'email'`,
      ).run();
      store.touch('email', VALID_UUID_2);

      const latest = store.getLatest('email');
      expect(latest).toBe(VALID_UUID_2);
    });
  });

  // -----------------------------------------------------------------------
  // touch()
  // -----------------------------------------------------------------------

  describe('touch()', () => {
    it('updates lastUsedAt timestamp', () => {
      store.save('email', VALID_UUID);

      // Backdate the record
      db.prepare(
        `UPDATE claude_sessions SET last_used_at = datetime('now', '-3600 seconds')
       WHERE claude_session_id = ?`,
      ).run(VALID_UUID);

      const before = db
        .prepare('SELECT last_used_at FROM claude_sessions WHERE claude_session_id = ?')
        .get(VALID_UUID) as { last_used_at: string };

      store.touch('email', VALID_UUID);

      const after = db
        .prepare('SELECT last_used_at FROM claude_sessions WHERE claude_session_id = ?')
        .get(VALID_UUID) as { last_used_at: string };

      expect(after.last_used_at > before.last_used_at).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // list()
  // -----------------------------------------------------------------------

  describe('list()', () => {
    it('returns all sessions for group (including expired)', () => {
      store.save('email', VALID_UUID);
      store.save('email', VALID_UUID_2);

      // Backdate one to make it "expired"
      db.prepare(
        `UPDATE claude_sessions SET last_used_at = datetime('now', '-172800 seconds')
       WHERE claude_session_id = ?`,
      ).run(VALID_UUID);

      const sessions = store.list('email');
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.claudeSessionId)).toContain(VALID_UUID);
      expect(sessions.map((s) => s.claudeSessionId)).toContain(VALID_UUID_2);
    });

    it('returns empty array for unknown group', () => {
      const sessions = store.list('nonexistent');
      expect(sessions).toEqual([]);
    });

    it('returns records with correct shape', () => {
      store.save('email', VALID_UUID);

      const sessions = store.list('email');
      expect(sessions).toHaveLength(1);

      const session = sessions[0]!;
      expect(session.group).toBe('email');
      expect(session.claudeSessionId).toBe(VALID_UUID);
      expect(typeof session.createdAt).toBe('string');
      expect(typeof session.lastUsedAt).toBe('string');
    });
  });

  // -----------------------------------------------------------------------
  // Group isolation
  // -----------------------------------------------------------------------

  describe('group isolation', () => {
    it('group A sessions not returned for group B', () => {
      store.save('email', VALID_UUID);
      store.save('slack', VALID_UUID_2);

      const emailSessions = store.list('email');
      const slackSessions = store.list('slack');

      expect(emailSessions).toHaveLength(1);
      expect(emailSessions[0]!.claudeSessionId).toBe(VALID_UUID);

      expect(slackSessions).toHaveLength(1);
      expect(slackSessions[0]!.claudeSessionId).toBe(VALID_UUID_2);

      // getLatest also respects group
      expect(store.getLatest('email')).toBe(VALID_UUID);
      expect(store.getLatest('slack')).toBe(VALID_UUID_2);
    });
  });

  // -----------------------------------------------------------------------
  // close()
  // -----------------------------------------------------------------------

  describe('close()', () => {
    it('releases database resources', () => {
      store.save('email', VALID_UUID);
      store.close();

      // After close, the database handle should be closed
      expect(() => db.prepare('SELECT 1')).toThrow();
    });
  });
});
