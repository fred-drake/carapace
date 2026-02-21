/**
 * Claude session store for Carapace.
 *
 * SQLite-backed persistent store for Claude Code session IDs (the --resume
 * IDs). This is SEPARATE from the in-memory SessionManager which tracks
 * ephemeral container sessions.
 *
 * Each group (e.g. "email", "slack") maintains its own set of sessions.
 * Sessions older than the configurable TTL are skipped by getLatest()
 * but still returned by list() for audit purposes.
 */

import type Database from 'better-sqlite3';
import type { Migration } from './sqlite-manager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TTL: 24 hours in milliseconds. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** UUID v4-style pattern: 8-4-4-4-12 hex characters. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeSessionRecord {
  group: string;
  claudeSessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export const CLAUDE_SESSION_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE claude_sessions (
          group_name TEXT NOT NULL,
          claude_session_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (group_name, claude_session_id)
        );
        CREATE INDEX idx_sessions_group_recent
          ON claude_sessions(group_name, last_used_at DESC);
      `);
    },
  },
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateSessionId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new Error(`Invalid session ID: "${id}". Must be a UUID (8-4-4-4-12 hex).`);
  }
}

// ---------------------------------------------------------------------------
// ClaudeSessionStore
// ---------------------------------------------------------------------------

export class ClaudeSessionStore {
  private readonly db: Database.Database;
  private readonly ttlMs: number;

  private constructor(db: Database.Database, ttlMs: number) {
    this.db = db;
    this.ttlMs = ttlMs;
  }

  /**
   * Create a new ClaudeSessionStore with migrations applied.
   *
   * @param db - A better-sqlite3 database handle (can be :memory: for tests).
   * @param migrations - The migration list to apply.
   * @param ttlMs - TTL in milliseconds for getLatest() expiry (default 24h).
   */
  static create(
    db: Database.Database,
    migrations: Migration[],
    ttlMs: number = DEFAULT_TTL_MS,
  ): ClaudeSessionStore {
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const currentVersion = (db.pragma('user_version') as Array<{ user_version: number }>)[0]!
      .user_version;

    for (const migration of sorted) {
      if (migration.version <= currentVersion) continue;
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    }

    return new ClaudeSessionStore(db, ttlMs);
  }

  /**
   * Save a Claude session ID for a group. If the same group+sessionId
   * already exists, updates last_used_at (upsert).
   */
  save(group: string, claudeSessionId: string): void {
    validateSessionId(claudeSessionId);

    this.db
      .prepare(
        `INSERT INTO claude_sessions (group_name, claude_session_id, created_at, last_used_at)
         VALUES (?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(group_name, claude_session_id)
         DO UPDATE SET last_used_at = datetime('now')`,
      )
      .run(group, claudeSessionId);
  }

  /**
   * Get the most recently used session ID for a group.
   * Returns null if no sessions exist or all are expired (older than TTL).
   */
  getLatest(group: string): string | null {
    const ttlSeconds = Math.floor(this.ttlMs / 1000);

    const row = this.db
      .prepare(
        `SELECT claude_session_id FROM claude_sessions
         WHERE group_name = ?
           AND last_used_at >= datetime('now', '-' || ? || ' seconds')
         ORDER BY last_used_at DESC
         LIMIT 1`,
      )
      .get(group, ttlSeconds) as { claude_session_id: string } | undefined;

    return row?.claude_session_id ?? null;
  }

  /**
   * Update last_used_at for an existing session.
   */
  touch(group: string, claudeSessionId: string): void {
    this.db
      .prepare(
        `UPDATE claude_sessions SET last_used_at = datetime('now')
         WHERE group_name = ? AND claude_session_id = ?`,
      )
      .run(group, claudeSessionId);
  }

  /**
   * List all sessions for a group, including expired ones.
   * Ordered by last_used_at descending.
   */
  list(group: string): ClaudeSessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT group_name, claude_session_id, created_at, last_used_at
         FROM claude_sessions
         WHERE group_name = ?
         ORDER BY last_used_at DESC`,
      )
      .all(group) as Array<{
      group_name: string;
      claude_session_id: string;
      created_at: string;
      last_used_at: string;
    }>;

    return rows.map((r) => ({
      group: r.group_name,
      claudeSessionId: r.claude_session_id,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  /**
   * Close the underlying database connection.
   */
  close(): void {
    this.db.close();
  }
}
