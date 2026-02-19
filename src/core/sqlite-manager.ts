/**
 * SQLite connection manager for Carapace.
 *
 * Manages per-feature, per-group SQLite databases at
 * `data/{feature}/{group}.sqlite`. Supports ordered migrations tracked
 * via `PRAGMA user_version`. Connection handles are reused within a
 * session and all closed on shutdown.
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Migration {
  version: number;
  up(db: Database.Database): void;
}

export interface SqliteManagerOptions {
  /** Base directory for database files (e.g. `data/`). */
  baseDir: string;
  /** Use in-memory databases for testing. */
  useMemory?: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Pattern for valid feature and group names: alphanumeric, hyphens, underscores.
 * No dots, slashes, spaces, or other special characters.
 */
const VALID_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function validateName(value: string, label: 'feature' | 'group'): void {
  if (!VALID_NAME_PATTERN.test(value)) {
    throw new Error(`Invalid ${label} name: "${value}". Only [a-zA-Z0-9_-] allowed.`);
  }
}

// ---------------------------------------------------------------------------
// SqliteManager
// ---------------------------------------------------------------------------

export class SqliteManager {
  private readonly baseDir: string;
  private readonly useMemory: boolean;
  private readonly connections: Map<string, Database.Database> = new Map();
  private readonly migrations: Map<string, Migration[]> = new Map();

  constructor(opts: SqliteManagerOptions) {
    this.baseDir = opts.baseDir;
    this.useMemory = opts.useMemory ?? false;
  }

  /**
   * Resolve the filesystem path for a feature+group database.
   * Does NOT validate names — call `validateName` first.
   */
  resolvePath(feature: string, group: string): string {
    return join(this.baseDir, feature, `${group}.sqlite`);
  }

  /**
   * Register migrations for a feature. Migrations are sorted by version
   * and applied in order when a database is first opened.
   */
  registerMigrations(feature: string, migrations: Migration[]): void {
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    this.migrations.set(feature, sorted);
  }

  /**
   * Get (or create) a database connection for the given feature and group.
   * Returns the same handle if called again with the same arguments.
   */
  getDatabase(feature: string, group: string): Database.Database {
    validateName(feature, 'feature');
    validateName(group, 'group');

    const key = `${feature}/${group}`;

    const existing = this.connections.get(key);
    if (existing) {
      return existing;
    }

    const db = this.openDatabase(feature, group);
    this.connections.set(key, db);

    // Apply pending migrations
    this.applyMigrations(db, feature);

    return db;
  }

  /**
   * Close all open database connections.
   * Safe to call multiple times.
   */
  shutdown(): void {
    for (const [key, db] of this.connections) {
      try {
        db.close();
      } catch {
        // Already closed — ignore
      }
      this.connections.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private openDatabase(feature: string, group: string): Database.Database {
    if (this.useMemory) {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      return db;
    }

    const dbPath = this.resolvePath(feature, group);
    const dir = join(this.baseDir, feature);
    mkdirSync(dir, { recursive: true });

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    return db;
  }

  private applyMigrations(db: Database.Database, feature: string): void {
    const featureMigrations = this.migrations.get(feature);
    if (!featureMigrations || featureMigrations.length === 0) {
      return;
    }

    const currentVersion = (db.pragma('user_version') as Array<{ user_version: number }>)[0]!
      .user_version;

    for (const migration of featureMigrations) {
      if (migration.version <= currentVersion) {
        continue;
      }

      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    }
  }
}
