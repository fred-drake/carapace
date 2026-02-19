/**
 * Memory plugin data layer for Carapace.
 *
 * SQLite schema and data access for typed memory entries with FTS5
 * full-text search, provenance tracking, and supersession chains.
 * See docs/MEMORY_DRAFT.md for the full design.
 */

import type Database from 'better-sqlite3';
import type { Migration } from '../../core/sqlite-manager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid memory entry types. */
export type MemoryEntryType = 'preference' | 'fact' | 'instruction' | 'context' | 'correction';

const VALID_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'preference',
  'fact',
  'instruction',
  'context',
  'correction',
]);

/** Types that produce behavioral=true entries. */
const BEHAVIORAL_TYPES: ReadonlySet<MemoryEntryType> = new Set([
  'preference',
  'instruction',
  'correction',
]);

/** A stored memory entry. */
export interface MemoryEntry {
  id: string;
  type: MemoryEntryType;
  content: string;
  behavioral: boolean;
  tags: string[];
  supersedes: string | null;
  superseded_by: string | null;
  session_id: string;
  group: string;
  created_at: string;
}

/** Input for creating a new memory entry. */
export interface StoreEntryInput {
  type: MemoryEntryType;
  content: string;
  tags?: string[];
  supersedes?: string;
  session_id: string;
  group: string;
}

/** Options for searching memory entries. */
export interface SearchOptions {
  query?: string;
  tags?: string[];
  type?: MemoryEntryType;
  include_superseded?: boolean;
  limit?: number;
}

/** A search result with relevance scoring. */
export interface SearchResult {
  id: string;
  type: string;
  content: string;
  behavioral: boolean;
  tags: string[];
  created_at: string;
  relevance_score: number;
}

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/** Current handler schema version. DB must not exceed this. */
export const HANDLER_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export const MEMORY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          id TEXT UNIQUE NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('preference', 'fact', 'instruction', 'context', 'correction')),
          content TEXT NOT NULL,
          behavioral INTEGER NOT NULL DEFAULT 0,
          tags TEXT NOT NULL DEFAULT '[]',
          supersedes TEXT,
          superseded_by TEXT,
          session_id TEXT NOT NULL,
          group_name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
        CREATE INDEX IF NOT EXISTS idx_entries_group ON entries(group_name);
        CREATE INDEX IF NOT EXISTS idx_entries_superseded_by ON entries(superseded_by);
        CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at);

        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
          content,
          content=entries,
          content_rowid=rowid
        );

        CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
          INSERT INTO entries_fts(rowid, content) VALUES (new.rowid, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
          INSERT INTO entries_fts(entries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
          INSERT INTO entries_fts(entries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
          INSERT INTO entries_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);
    },
  },
];

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Create a MemoryStore, applying migrations and checking schema version.
   *
   * Refuses to open if DB user_version exceeds handler version (prevents
   * running old code against a newer schema).
   */
  static create(db: Database.Database, migrations: Migration[]): MemoryStore {
    // Check for downgrade
    const currentVersion = (db.pragma('user_version') as Array<{ user_version: number }>)[0]!
      .user_version;

    if (currentVersion > HANDLER_SCHEMA_VERSION) {
      throw new Error(
        `Database version (${currentVersion}) is higher than handler version ` +
          `(${HANDLER_SCHEMA_VERSION}). Cannot downgrade — update Carapace first.`,
      );
    }

    // Apply pending migrations
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    for (const migration of sorted) {
      if (migration.version <= currentVersion) {
        continue;
      }
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    }

    return new MemoryStore(db);
  }

  // -------------------------------------------------------------------------
  // store()
  // -------------------------------------------------------------------------

  /** Create a new memory entry. */
  store(input: StoreEntryInput): MemoryEntry {
    if (!VALID_ENTRY_TYPES.has(input.type)) {
      throw new Error(`Invalid entry type: "${input.type}"`);
    }

    const id = `mem-${crypto.randomUUID()}`;
    const behavioral = BEHAVIORAL_TYPES.has(input.type);
    const tags = input.tags ?? [];
    const created_at = new Date().toISOString();

    // Handle supersession
    if (input.supersedes) {
      const existing = this.getById(input.supersedes);
      if (!existing) {
        throw new Error(`Superseded entry "${input.supersedes}" not found`);
      }

      // Mark the old entry as superseded
      this.db
        .prepare('UPDATE entries SET superseded_by = ? WHERE id = ?')
        .run(id, input.supersedes);
    }

    this.db
      .prepare(
        `INSERT INTO entries (id, type, content, behavioral, tags, supersedes, superseded_by,
         session_id, group_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.content,
        behavioral ? 1 : 0,
        JSON.stringify(tags),
        input.supersedes ?? null,
        null,
        input.session_id,
        input.group,
        created_at,
      );

    return {
      id,
      type: input.type,
      content: input.content,
      behavioral,
      tags,
      supersedes: input.supersedes ?? null,
      superseded_by: null,
      session_id: input.session_id,
      group: input.group,
      created_at,
    };
  }

  // -------------------------------------------------------------------------
  // getById()
  // -------------------------------------------------------------------------

  /** Retrieve a memory entry by ID, or null if not found. */
  getById(id: string): MemoryEntry | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as
      | RawEntryRow
      | undefined;
    if (!row) return null;
    return rowToEntry(row);
  }

  // -------------------------------------------------------------------------
  // delete()
  // -------------------------------------------------------------------------

  /** Delete a memory entry by ID. Returns true if it existed. */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // search()
  // -------------------------------------------------------------------------

  /** Search memory entries with optional filters and FTS5 text search. */
  search(options: SearchOptions): SearchResult[] {
    const limit = options.limit ?? 20;
    const includeSuperseded = options.include_superseded ?? false;

    if (options.query && options.query.trim().length > 0) {
      return this.searchWithFts(options.query.trim(), options, limit, includeSuperseded);
    }

    return this.searchWithoutFts(options, limit, includeSuperseded);
  }

  // -------------------------------------------------------------------------
  // purgeSuperseded()
  // -------------------------------------------------------------------------

  /**
   * Purge superseded entries older than the given number of days.
   * Returns the count of deleted entries.
   */
  purgeSuperseded(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db
      .prepare('DELETE FROM entries WHERE superseded_by IS NOT NULL AND created_at < ?')
      .run(cutoff);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // count()
  // -------------------------------------------------------------------------

  /** Return the total number of entries in the store. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM entries').get() as { cnt: number };
    return row.cnt;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private searchWithFts(
    query: string,
    options: SearchOptions,
    limit: number,
    includeSuperseded: boolean,
  ): SearchResult[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    // FTS5 match
    conditions.push('entries_fts.content MATCH ?');
    params.push(query);

    if (!includeSuperseded) {
      conditions.push('e.superseded_by IS NULL');
    }
    if (options.type) {
      conditions.push('e.type = ?');
      params.push(options.type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT e.*, rank
      FROM entries_fts
      JOIN entries e ON e.rowid = entries_fts.rowid
      ${where}
      ORDER BY rank
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<RawEntryRow & { rank: number }>;

    // Filter by tags in JavaScript (FTS5 doesn't index JSON arrays)
    let results = rows.map((row) => rowToSearchResult(row, row.rank));

    if (options.tags && options.tags.length > 0) {
      const requiredTags = new Set(options.tags);
      results = results.filter((r) => {
        const entryTags = new Set(r.tags);
        return [...requiredTags].every((t) => entryTags.has(t));
      });
    }

    return results;
  }

  private searchWithoutFts(
    options: SearchOptions,
    limit: number,
    includeSuperseded: boolean,
  ): SearchResult[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!includeSuperseded) {
      conditions.push('superseded_by IS NULL');
    }
    if (options.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT * FROM entries
      ${where}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as RawEntryRow[];

    // Filter by tags in JavaScript
    let results = rows.map((row) => rowToSearchResult(row, 0));

    if (options.tags && options.tags.length > 0) {
      const requiredTags = new Set(options.tags);
      results = results.filter((r) => {
        const entryTags = new Set(r.tags);
        return [...requiredTags].every((t) => entryTags.has(t));
      });
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface RawEntryRow {
  id: string;
  type: string;
  content: string;
  behavioral: number;
  tags: string;
  supersedes: string | null;
  superseded_by: string | null;
  session_id: string;
  group_name: string;
  created_at: string;
}

function rowToEntry(row: RawEntryRow): MemoryEntry {
  return {
    id: row.id,
    type: row.type as MemoryEntryType,
    content: row.content,
    behavioral: row.behavioral === 1,
    tags: JSON.parse(row.tags) as string[],
    supersedes: row.supersedes,
    superseded_by: row.superseded_by,
    session_id: row.session_id,
    group: row.group_name,
    created_at: row.created_at,
  };
}

function rowToSearchResult(row: RawEntryRow, rank: number): SearchResult {
  // FTS5 rank is negative (more negative = more relevant). Normalize to 0..1.
  const relevance_score = rank === 0 ? 0 : Math.min(1, Math.abs(rank));
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    behavioral: row.behavioral === 1,
    tags: JSON.parse(row.tags) as string[],
    created_at: row.created_at,
    relevance_score,
  };
}
