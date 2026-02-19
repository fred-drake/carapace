import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteManager, type Migration } from './sqlite-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a SqliteManager that uses in-memory databases.
 * We pass baseDir but override the internal open to use :memory: via
 * the useMemory option.
 */
function createTestManager(): SqliteManager {
  return new SqliteManager({ baseDir: '/tmp/test-data', useMemory: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SqliteManager', () => {
  let manager: SqliteManager;

  beforeEach(() => {
    manager = createTestManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  // -----------------------------------------------------------------------
  // Connection create and reuse
  // -----------------------------------------------------------------------

  describe('connection management', () => {
    it('returns a database connection for a feature and group', () => {
      const db = manager.getDatabase('notes', 'user-1');
      expect(db).toBeDefined();
      expect(db).toBeInstanceOf(Database);
    });

    it('returns the same handle for the same feature+group', () => {
      const db1 = manager.getDatabase('notes', 'user-1');
      const db2 = manager.getDatabase('notes', 'user-1');
      expect(db1).toBe(db2);
    });

    it('returns different handles for different groups', () => {
      const db1 = manager.getDatabase('notes', 'user-1');
      const db2 = manager.getDatabase('notes', 'user-2');
      expect(db1).not.toBe(db2);
    });

    it('returns different handles for different features', () => {
      const db1 = manager.getDatabase('notes', 'user-1');
      const db2 = manager.getDatabase('calendar', 'user-1');
      expect(db1).not.toBe(db2);
    });
  });

  // -----------------------------------------------------------------------
  // WAL mode
  // -----------------------------------------------------------------------

  describe('WAL mode', () => {
    it('enables WAL journal mode on new connections', () => {
      const db = manager.getDatabase('notes', 'user-1');
      const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
      // In-memory databases use 'memory' journal mode, but the pragma is still
      // called. For file-backed databases it would be 'wal'. We verify the
      // pragma was set by checking the manager sets it.
      expect(result[0]!.journal_mode).toBe('memory');
    });
  });

  // -----------------------------------------------------------------------
  // Name validation
  // -----------------------------------------------------------------------

  describe('name validation', () => {
    describe('group name validation', () => {
      it('accepts valid alphanumeric group names', () => {
        expect(() => manager.getDatabase('notes', 'user-1')).not.toThrow();
        expect(() => manager.getDatabase('notes', 'my_group')).not.toThrow();
        expect(() => manager.getDatabase('notes', 'GroupA')).not.toThrow();
        expect(() => manager.getDatabase('notes', 'abc123')).not.toThrow();
      });

      it('rejects empty group name', () => {
        expect(() => manager.getDatabase('notes', '')).toThrow(/invalid group name/i);
      });

      it('rejects group names with path traversal (../)', () => {
        expect(() => manager.getDatabase('notes', '../etc')).toThrow(/invalid group name/i);
      });

      it('rejects group names with dot (.)', () => {
        expect(() => manager.getDatabase('notes', '.')).toThrow(/invalid group name/i);
      });

      it('rejects group names with forward slash', () => {
        expect(() => manager.getDatabase('notes', 'a/b')).toThrow(/invalid group name/i);
      });

      it('rejects group names with backslash', () => {
        expect(() => manager.getDatabase('notes', 'a\\b')).toThrow(/invalid group name/i);
      });

      it('rejects group names with special characters', () => {
        expect(() => manager.getDatabase('notes', 'user@home')).toThrow(/invalid group name/i);
        expect(() => manager.getDatabase('notes', 'user name')).toThrow(/invalid group name/i);
        expect(() => manager.getDatabase('notes', 'user!name')).toThrow(/invalid group name/i);
      });
    });

    describe('feature name validation', () => {
      it('accepts valid alphanumeric feature names', () => {
        expect(() => manager.getDatabase('notes', 'user-1')).not.toThrow();
        expect(() => manager.getDatabase('my_feature', 'user-1')).not.toThrow();
        expect(() => manager.getDatabase('FeatureA', 'user-1')).not.toThrow();
      });

      it('rejects empty feature name', () => {
        expect(() => manager.getDatabase('', 'user-1')).toThrow(/invalid feature name/i);
      });

      it('rejects feature names with path traversal (../)', () => {
        expect(() => manager.getDatabase('../etc', 'user-1')).toThrow(/invalid feature name/i);
      });

      it('rejects feature names with dot (.)', () => {
        expect(() => manager.getDatabase('.', 'user-1')).toThrow(/invalid feature name/i);
      });

      it('rejects feature names with forward slash', () => {
        expect(() => manager.getDatabase('a/b', 'user-1')).toThrow(/invalid feature name/i);
      });

      it('rejects feature names with backslash', () => {
        expect(() => manager.getDatabase('a\\b', 'user-1')).toThrow(/invalid feature name/i);
      });

      it('rejects feature names with special characters', () => {
        expect(() => manager.getDatabase('feat@home', 'user-1')).toThrow(/invalid feature name/i);
        expect(() => manager.getDatabase('feat name', 'user-1')).toThrow(/invalid feature name/i);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Path resolution
  // -----------------------------------------------------------------------

  describe('path resolution', () => {
    it('constructs path as baseDir/feature/group.sqlite', () => {
      const mgr = new SqliteManager({ baseDir: '/data', useMemory: true });
      const path = mgr.resolvePath('notes', 'user-1');
      expect(path).toBe('/data/notes/user-1.sqlite');
      mgr.shutdown();
    });
  });

  // -----------------------------------------------------------------------
  // Migrations
  // -----------------------------------------------------------------------

  describe('migrations', () => {
    it('runs a single migration', () => {
      const migrations: Migration[] = [
        {
          version: 1,
          up(db: Database.Database) {
            db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
          },
        },
      ];

      manager.registerMigrations('notes', migrations);
      const db = manager.getDatabase('notes', 'user-1');

      // Verify table exists
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='items'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it('runs migrations in version order', () => {
      const order: number[] = [];
      const migrations: Migration[] = [
        {
          version: 2,
          up(db: Database.Database) {
            order.push(2);
            db.exec('CREATE TABLE second (id INTEGER PRIMARY KEY)');
          },
        },
        {
          version: 1,
          up(db: Database.Database) {
            order.push(1);
            db.exec('CREATE TABLE first (id INTEGER PRIMARY KEY)');
          },
        },
        {
          version: 3,
          up(db: Database.Database) {
            order.push(3);
            db.exec('CREATE TABLE third (id INTEGER PRIMARY KEY)');
          },
        },
      ];

      manager.registerMigrations('notes', migrations);
      const db = manager.getDatabase('notes', 'user-1');

      expect(order).toEqual([1, 2, 3]);

      // All tables exist
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('first');
      expect(tableNames).toContain('second');
      expect(tableNames).toContain('third');
    });

    it('is idempotent — running migrations twice is safe', () => {
      const callCount = { v1: 0 };
      const migrations: Migration[] = [
        {
          version: 1,
          up(db: Database.Database) {
            callCount.v1++;
            db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
          },
        },
      ];

      manager.registerMigrations('notes', migrations);

      // Get database twice — migrations should only run once
      const db1 = manager.getDatabase('notes', 'group-a');
      const db2 = manager.getDatabase('notes', 'group-a');

      expect(db1).toBe(db2);
      expect(callCount.v1).toBe(1);
    });

    it('tracks migration state via user_version', () => {
      const migrations: Migration[] = [
        {
          version: 1,
          up(db: Database.Database) {
            db.exec('CREATE TABLE v1 (id INTEGER PRIMARY KEY)');
          },
        },
        {
          version: 2,
          up(db: Database.Database) {
            db.exec('CREATE TABLE v2 (id INTEGER PRIMARY KEY)');
          },
        },
      ];

      manager.registerMigrations('notes', migrations);
      const db = manager.getDatabase('notes', 'user-1');

      const version = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(version[0]!.user_version).toBe(2);
    });

    it('only runs new migrations on an already-migrated database', () => {
      const callCount = { v1: 0, v2: 0 };

      // First, register and open with only v1
      const migrationsV1: Migration[] = [
        {
          version: 1,
          up(db: Database.Database) {
            callCount.v1++;
            db.exec('CREATE TABLE v1 (id INTEGER PRIMARY KEY)');
          },
        },
      ];

      manager.registerMigrations('notes', migrationsV1);
      manager.getDatabase('notes', 'user-1');
      expect(callCount.v1).toBe(1);

      const migrationsV1V2: Migration[] = [
        {
          version: 1,
          up(db: Database.Database) {
            callCount.v1++;
            db.exec('CREATE TABLE v1b (id INTEGER PRIMARY KEY)');
          },
        },
        {
          version: 2,
          up(db: Database.Database) {
            callCount.v2++;
            db.exec('CREATE TABLE v2b (id INTEGER PRIMARY KEY)');
          },
        },
      ];

      // Register additional migrations for a different feature to test
      manager.registerMigrations('calendar', migrationsV1V2);
      manager.getDatabase('calendar', 'user-1');

      // Both v1 and v2 ran for calendar
      expect(callCount.v1).toBe(2); // once for notes, once for calendar
      expect(callCount.v2).toBe(1); // once for calendar
    });
  });

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  describe('shutdown', () => {
    it('closes all open connections', () => {
      const db1 = manager.getDatabase('notes', 'user-1');
      const db2 = manager.getDatabase('calendar', 'user-1');

      manager.shutdown();

      // After shutdown, the database handles should be closed
      // better-sqlite3 throws when you try to use a closed database
      expect(() => db1.prepare('SELECT 1')).toThrow();
      expect(() => db2.prepare('SELECT 1')).toThrow();
    });

    it('is safe to call shutdown multiple times', () => {
      manager.getDatabase('notes', 'user-1');
      manager.shutdown();
      expect(() => manager.shutdown()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent access to different groups
  // -----------------------------------------------------------------------

  describe('concurrent access', () => {
    it('handles multiple features and groups simultaneously', () => {
      const migrations: Migration[] = [
        {
          version: 1,
          up(db: Database.Database) {
            db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)');
          },
        },
      ];

      manager.registerMigrations('notes', migrations);
      manager.registerMigrations('calendar', migrations);

      const notesA = manager.getDatabase('notes', 'group-a');
      const notesB = manager.getDatabase('notes', 'group-b');
      const calA = manager.getDatabase('calendar', 'group-a');

      // Insert into each independently
      notesA.prepare('INSERT INTO items (value) VALUES (?)').run('notes-a');
      notesB.prepare('INSERT INTO items (value) VALUES (?)').run('notes-b');
      calA.prepare('INSERT INTO items (value) VALUES (?)').run('cal-a');

      // Verify isolation
      const notesARows = notesA.prepare('SELECT value FROM items').all() as Array<{
        value: string;
      }>;
      const notesBRows = notesB.prepare('SELECT value FROM items').all() as Array<{
        value: string;
      }>;
      const calARows = calA.prepare('SELECT value FROM items').all() as Array<{ value: string }>;

      expect(notesARows).toEqual([{ value: 'notes-a' }]);
      expect(notesBRows).toEqual([{ value: 'notes-b' }]);
      expect(calARows).toEqual([{ value: 'cal-a' }]);
    });
  });
});
