/**
 * SQLite and FTS5 injection security tests.
 *
 * Verifies that all SQLite operations use parameterized queries and
 * cannot be injected. Covers:
 * 1. SQL injection through memory content, tags, and search query fields
 * 2. FTS5 query syntax injection (NEAR, AND, OR, NOT, column filters)
 * 3. Path traversal in group names used for SQLite file paths
 * 4. PRAGMA injection attempts
 *
 * These tests exercise the actual MemoryStore against a real SQLite
 * database (in-memory) to verify that injection payloads are harmless.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryStore, MEMORY_MIGRATIONS } from './memory-store.js';
import { MemoryHandler } from './memory-handler.js';
import { SqliteManager } from '../../core/sqlite-manager.js';
import { sanitizeFtsQuery } from './memory-security.js';
import type { PluginContext } from '../../core/plugin-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

function createStore(): { store: MemoryStore; db: Database.Database } {
  const db = createDb();
  const store = MemoryStore.create(db, MEMORY_MIGRATIONS);
  return { store, db };
}

function createHandler(): { handler: MemoryHandler; store: MemoryStore; db: Database.Database } {
  const db = createDb();
  const store = MemoryStore.create(db, MEMORY_MIGRATIONS);
  const handler = new MemoryHandler(store);
  return { handler, store, db };
}

function makeContext(overrides?: Partial<PluginContext>): PluginContext {
  return {
    group: 'test-group',
    sessionId: 'sess-001',
    correlationId: 'corr-001',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SQL Injection — memory content field
// ---------------------------------------------------------------------------

describe('SQL injection through memory content', () => {
  let store: MemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
  });

  it('stores content with SQL injection payload without executing it', () => {
    const malicious = "'; DROP TABLE entries; --";
    const entry = store.store({
      type: 'fact',
      content: malicious,
      session_id: 'sess-001',
      group: 'test',
    });

    expect(entry.content).toBe(malicious);
    // Table should still exist and be queryable
    expect(store.count()).toBe(1);
    const fetched = store.getById(entry.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe(malicious);
  });

  it('stores content with UNION SELECT injection payload', () => {
    const malicious =
      "' UNION SELECT id, type, content, 1, '[]', null, null, '', '', '' FROM entries --";
    const entry = store.store({
      type: 'fact',
      content: malicious,
      session_id: 'sess-001',
      group: 'test',
    });

    expect(entry.content).toBe(malicious);
    expect(store.count()).toBe(1);
  });

  it('stores content with nested quote escapes', () => {
    const malicious = "test''; DROP TABLE entries; --";
    const entry = store.store({
      type: 'fact',
      content: malicious,
      session_id: 'sess-001',
      group: 'test',
    });

    expect(entry.content).toBe(malicious);
    expect(store.count()).toBe(1);
  });

  it('stores content with null byte injection', () => {
    const malicious = "normal\x00'; DROP TABLE entries; --";
    const entry = store.store({
      type: 'fact',
      content: malicious,
      session_id: 'sess-001',
      group: 'test',
    });

    // Content is stored — null byte doesn't cause SQL injection
    expect(store.count()).toBe(1);
    expect(entry.id).toMatch(/^mem-/);
  });

  it('stores content with backslash escape sequences', () => {
    const malicious = "test\\'; DROP TABLE entries; --";
    const entry = store.store({
      type: 'fact',
      content: malicious,
      session_id: 'sess-001',
      group: 'test',
    });

    expect(entry.content).toBe(malicious);
    expect(store.count()).toBe(1);
  });

  it('stores content with SQL comment injection', () => {
    const malicious = 'test /* injected comment */ value';
    const entry = store.store({
      type: 'fact',
      content: malicious,
      session_id: 'sess-001',
      group: 'test',
    });

    expect(entry.content).toBe(malicious);
    expect(store.count()).toBe(1);
  });

  it('stores content with PRAGMA injection in content', () => {
    const malicious = "test'; PRAGMA table_info(entries); --";
    const entry = store.store({
      type: 'fact',
      content: malicious,
      session_id: 'sess-001',
      group: 'test',
    });

    expect(entry.content).toBe(malicious);
    expect(store.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SQL Injection — tags field
// ---------------------------------------------------------------------------

describe('SQL injection through tags field', () => {
  let store: MemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
  });

  it('stores tags containing SQL injection payloads', () => {
    const maliciousTags = ['normal', "'; DROP TABLE entries; --"];
    const entry = store.store({
      type: 'fact',
      content: 'Test entry',
      tags: maliciousTags,
      session_id: 'sess-001',
      group: 'test',
    });

    expect(entry.tags).toEqual(maliciousTags);
    expect(store.count()).toBe(1);
  });

  it('tag with JSON injection does not corrupt stored data', () => {
    const maliciousTags = ['tag1', '","evil":"value"'];
    const entry = store.store({
      type: 'fact',
      content: 'Test entry',
      tags: maliciousTags,
      session_id: 'sess-001',
      group: 'test',
    });

    // Tags are stored as JSON.stringify — the injection is just a string
    const fetched = store.getById(entry.id);
    expect(fetched!.tags).toEqual(maliciousTags);
    expect(fetched!.tags[1]).toBe('","evil":"value"');
  });

  it('searches by tags containing SQL injection payloads', () => {
    store.store({
      type: 'fact',
      content: 'Safe entry',
      tags: ["'; DROP TABLE entries; --"],
      session_id: 'sess-001',
      group: 'test',
    });

    // Tag filtering is done in JavaScript, not SQL — but verify it works
    const results = store.search({ tags: ["'; DROP TABLE entries; --"] });
    expect(results).toHaveLength(1);
    expect(store.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SQL Injection — search query field
// ---------------------------------------------------------------------------

describe('SQL injection through search query field', () => {
  let store: MemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
    // Seed some entries
    store.store({ type: 'fact', content: 'TypeScript is great', session_id: 's1', group: 'test' });
    store.store({ type: 'fact', content: 'Python is versatile', session_id: 's1', group: 'test' });
  });

  it('handles SQL injection in FTS5 query without data exfiltration', () => {
    // This should either return empty results or throw an FTS5 parse error,
    // but must NOT execute the DROP TABLE
    const malicious = "'; DROP TABLE entries; --";
    try {
      const results = store.search({ query: malicious });
      // If it doesn't throw, verify table still exists
      expect(store.count()).toBe(2);
      expect(Array.isArray(results)).toBe(true);
    } catch {
      // FTS5 parse error is acceptable — the injection was rejected
      expect(store.count()).toBe(2);
    }
  });

  it('handles UNION SELECT injection in search query', () => {
    const malicious = "') UNION SELECT * FROM entries --";
    try {
      store.search({ query: malicious });
    } catch {
      // FTS5 parse error is acceptable
    }
    expect(store.count()).toBe(2);
  });

  it('sanitized query produces valid FTS5 search without injection', () => {
    const malicious = "TypeScript'; DROP TABLE entries; --";
    const sanitized = sanitizeFtsQuery(malicious);

    // Search with sanitized query should work safely
    const results = store.search({ query: sanitized });
    expect(store.count()).toBe(2);
    expect(Array.isArray(results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FTS5 query syntax injection
// ---------------------------------------------------------------------------

describe('FTS5 query syntax injection', () => {
  let store: MemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
    store.store({
      type: 'fact',
      content: 'TypeScript programming',
      session_id: 's1',
      group: 'test',
    });
    store.store({
      type: 'preference',
      content: 'Prefers dark mode',
      session_id: 's1',
      group: 'test',
    });
    store.store({ type: 'fact', content: 'Python data science', session_id: 's1', group: 'test' });
  });

  it('sanitizes column filter syntax (content:)', () => {
    const sanitized = sanitizeFtsQuery('content:secret');
    expect(sanitized).not.toContain(':');
    // Should still be searchable as plain text
    const results = store.search({ query: sanitized });
    expect(Array.isArray(results)).toBe(true);
  });

  it('sanitizes NEAR operator', () => {
    const sanitized = sanitizeFtsQuery('NEAR(TypeScript Python, 10)');
    expect(sanitized).not.toMatch(/\bNEAR\b/);
    const results = store.search({ query: sanitized });
    expect(Array.isArray(results)).toBe(true);
  });

  it('sanitizes boolean operators AND/OR/NOT', () => {
    const sanitized = sanitizeFtsQuery('TypeScript AND NOT Python OR dark');
    expect(sanitized).not.toMatch(/\bAND\b/);
    expect(sanitized).not.toMatch(/\bNOT\b/);
    expect(sanitized).not.toMatch(/\bOR\b/);
    expect(sanitized).toContain('TypeScript');
    expect(sanitized).toContain('Python');
    expect(sanitized).toContain('dark');
  });

  it('sanitizes prefix wildcard for term flooding', () => {
    const sanitized = sanitizeFtsQuery('a*');
    expect(sanitized).not.toContain('*');
  });

  it('sanitizes phrase query that could bypass relevance', () => {
    const sanitized = sanitizeFtsQuery('"exact phrase match"');
    expect(sanitized).not.toContain('"');
  });

  it('sanitizes boost operator', () => {
    const sanitized = sanitizeFtsQuery('^boosted');
    expect(sanitized).not.toContain('^');
  });

  it('sanitized query still finds relevant results', () => {
    // Ensure sanitization doesn't break legitimate searches
    const sanitized = sanitizeFtsQuery('TypeScript programming');
    const results = store.search({ query: sanitized });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.content).toContain('TypeScript');
  });

  it('raw FTS5 injection with column: syntax does not crash', () => {
    // Direct search (without sanitization) — should either work or throw FTS5 error
    try {
      const results = store.search({ query: 'content:secret OR tags:admin' });
      // If it succeeds, no data corruption
      expect(store.count()).toBe(3);
      expect(Array.isArray(results)).toBe(true);
    } catch {
      // FTS5 parse error is acceptable
      expect(store.count()).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// FTS5 ranking manipulation resistance
// ---------------------------------------------------------------------------

describe('FTS5 ranking manipulation resistance', () => {
  let store: MemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
  });

  it('keyword stuffing in content does not produce relevance > 1.0', () => {
    // Attacker stuffs keywords to game relevance ranking
    const stuffed = 'TypeScript '.repeat(100).trim();
    store.store({ type: 'fact', content: stuffed, session_id: 's1', group: 'test' });
    store.store({ type: 'fact', content: 'TypeScript once', session_id: 's1', group: 'test' });

    const results = store.search({ query: 'TypeScript' });
    for (const r of results) {
      expect(r.relevance_score).toBeLessThanOrEqual(1.0);
      expect(r.relevance_score).toBeGreaterThanOrEqual(0);
    }
  });

  it('entries with very long content do not crash FTS5', () => {
    const longContent = 'keyword '.repeat(500);
    store.store({ type: 'fact', content: longContent, session_id: 's1', group: 'test' });

    const results = store.search({ query: 'keyword' });
    expect(results).toHaveLength(1);
    expect(store.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Path traversal in group names
// ---------------------------------------------------------------------------

describe('Path traversal in group names', () => {
  it('SqliteManager rejects group names with directory traversal (..)', () => {
    const manager = new SqliteManager({ baseDir: '/tmp/test-db', useMemory: true });
    expect(() => manager.getDatabase('memory', '../../../etc/passwd')).toThrow(/invalid.*group/i);
  });

  it('SqliteManager rejects group names with forward slashes', () => {
    const manager = new SqliteManager({ baseDir: '/tmp/test-db', useMemory: true });
    expect(() => manager.getDatabase('memory', 'group/subdir')).toThrow(/invalid.*group/i);
  });

  it('SqliteManager rejects group names with backslashes', () => {
    const manager = new SqliteManager({ baseDir: '/tmp/test-db', useMemory: true });
    expect(() => manager.getDatabase('memory', 'group\\subdir')).toThrow(/invalid.*group/i);
  });

  it('SqliteManager rejects group names with dots', () => {
    const manager = new SqliteManager({ baseDir: '/tmp/test-db', useMemory: true });
    expect(() => manager.getDatabase('memory', '..')).toThrow(/invalid.*group/i);
    expect(() => manager.getDatabase('memory', '.')).toThrow(/invalid.*group/i);
  });

  it('SqliteManager rejects group names with spaces', () => {
    const manager = new SqliteManager({ baseDir: '/tmp/test-db', useMemory: true });
    expect(() => manager.getDatabase('memory', 'group name')).toThrow(/invalid.*group/i);
  });

  it('SqliteManager rejects empty group names', () => {
    const manager = new SqliteManager({ baseDir: '/tmp/test-db', useMemory: true });
    expect(() => manager.getDatabase('memory', '')).toThrow(/invalid.*group/i);
  });

  it('SqliteManager rejects group names starting with hyphen', () => {
    const manager = new SqliteManager({ baseDir: '/tmp/test-db', useMemory: true });
    expect(() => manager.getDatabase('memory', '-admin')).toThrow(/invalid.*group/i);
  });

  it('SqliteManager rejects group names starting with underscore', () => {
    const manager = new SqliteManager({ baseDir: '/tmp/test-db', useMemory: true });
    expect(() => manager.getDatabase('memory', '_system')).toThrow(/invalid.*group/i);
  });

  it('SqliteManager accepts valid group names', () => {
    const manager = new SqliteManager({ baseDir: '/tmp/test-db', useMemory: true });
    // These should not throw
    expect(() => manager.getDatabase('memory', 'main')).not.toThrow();
    expect(() => manager.getDatabase('memory', 'work-group')).not.toThrow();
    expect(() => manager.getDatabase('memory', 'user123')).not.toThrow();
    expect(() => manager.getDatabase('memory', 'Group_A')).not.toThrow();
    manager.shutdown();
  });

  it('SqliteManager rejects feature names with traversal', () => {
    const manager = new SqliteManager({ baseDir: '/tmp/test-db', useMemory: true });
    expect(() => manager.getDatabase('../secret', 'main')).toThrow(/invalid.*feature/i);
  });

  it('resolvePath produces expected safe paths', () => {
    const manager = new SqliteManager({ baseDir: '/data' });
    const resolved = manager.resolvePath('memory', 'main');
    expect(resolved).toBe('/data/memory/main.sqlite');
    // No traversal artifacts
    expect(resolved).not.toContain('..');
    expect(resolved).not.toContain('//');
  });
});

// ---------------------------------------------------------------------------
// PRAGMA injection attempts
// ---------------------------------------------------------------------------

describe('PRAGMA injection attempts', () => {
  it('PRAGMA injection in content does not change DB settings', () => {
    const { store, db } = createStore();

    // Store content that looks like a PRAGMA command
    store.store({
      type: 'fact',
      content: 'PRAGMA journal_mode=DELETE; PRAGMA user_version=999;',
      session_id: 'sess-001',
      group: 'test',
    });

    // Verify user_version is unchanged (still the migration version, not 999)
    const userVersion = (db.pragma('user_version') as Array<{ user_version: number }>)[0]!
      .user_version;
    expect(userVersion).toBe(1);

    // Journal mode should NOT be DELETE (in-memory DBs use "memory", file DBs use "wal")
    const journalMode = (db.pragma('journal_mode') as Array<{ journal_mode: string }>)[0]!
      .journal_mode;
    expect(journalMode).not.toBe('delete');
  });

  it('PRAGMA injection in tags does not change DB settings', () => {
    const { store, db } = createStore();

    store.store({
      type: 'fact',
      content: 'Normal content',
      tags: ['PRAGMA foreign_keys=OFF', 'PRAGMA cache_size=0'],
      session_id: 'sess-001',
      group: 'test',
    });

    // Verify user_version is unchanged — the PRAGMA strings in tags were not executed
    const userVersion = (db.pragma('user_version') as Array<{ user_version: number }>)[0]!
      .user_version;
    expect(userVersion).toBe(1);
  });

  it('PRAGMA injection in search query does not execute', () => {
    const { store, db } = createStore();
    store.store({ type: 'fact', content: 'Test entry', session_id: 's1', group: 'test' });

    try {
      store.search({ query: "test'; PRAGMA user_version=999; --" });
    } catch {
      // FTS5 parse error is fine
    }

    // User version should not have changed
    const userVersion = (db.pragma('user_version') as Array<{ user_version: number }>)[0]!
      .user_version;
    expect(userVersion).toBe(1);
  });

  it('PRAGMA injection in entry type does not execute', () => {
    const { store, db } = createStore();

    // Should throw due to invalid type, NOT execute the PRAGMA
    expect(() =>
      store.store({
        type: "fact'; PRAGMA user_version=999; --" as any,
        content: 'Test',
        session_id: 's1',
        group: 'test',
      }),
    ).toThrow();

    const userVersion = (db.pragma('user_version') as Array<{ user_version: number }>)[0]!
      .user_version;
    expect(userVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Parameterized query verification
// ---------------------------------------------------------------------------

describe('Parameterized query verification', () => {
  it('store() uses parameterized INSERT (verified by escaping)', () => {
    const { store } = createStore();

    // If this were string-concatenated, the single quote would break the SQL
    const entry = store.store({
      type: 'fact',
      content: "It's a test with 'quotes' and \"double quotes\"",
      session_id: "sess'001",
      group: "test'group",
    });

    expect(entry.content).toBe("It's a test with 'quotes' and \"double quotes\"");
    expect(entry.session_id).toBe("sess'001");
    expect(entry.group).toBe("test'group");
    expect(store.count()).toBe(1);
  });

  it('getById() uses parameterized SELECT (verified by escaping)', () => {
    const { store } = createStore();
    // ID with injection payload — won't match but should not error
    const result = store.getById("' OR 1=1 --");
    expect(result).toBeNull();
    expect(store.count()).toBe(0);
  });

  it('delete() uses parameterized DELETE (verified by escaping)', () => {
    const { store } = createStore();
    store.store({ type: 'fact', content: 'Entry A', session_id: 's1', group: 'test' });
    store.store({ type: 'fact', content: 'Entry B', session_id: 's1', group: 'test' });

    // Injection attempt in delete — should NOT delete all rows
    const deleted = store.delete("' OR 1=1 --");
    expect(deleted).toBe(false);
    expect(store.count()).toBe(2);
  });

  it('search() with type filter uses parameterized query', () => {
    const { store } = createStore();
    store.store({ type: 'fact', content: 'A fact', session_id: 's1', group: 'test' });
    store.store({ type: 'preference', content: 'A preference', session_id: 's1', group: 'test' });

    // Injection in type filter
    const results = store.search({ type: "' OR 1=1 --" as any });
    // Should return 0 results (no match), not all results
    expect(results).toHaveLength(0);
  });

  it('supersession uses parameterized UPDATE', () => {
    const { store } = createStore();
    const entry = store.store({
      type: 'fact',
      content: 'Original',
      session_id: 's1',
      group: 'test',
    });

    // Normal supersession works
    const replacement = store.store({
      type: 'fact',
      content: 'Replacement',
      supersedes: entry.id,
      session_id: 's1',
      group: 'test',
    });

    expect(replacement.supersedes).toBe(entry.id);
    const original = store.getById(entry.id);
    expect(original!.superseded_by).toBe(replacement.id);
  });

  it('purgeSuperseded() uses parameterized DELETE', () => {
    const { store, db } = createStore();

    // Create a superseded entry manually with old date
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO entries (id, type, content, behavioral, tags, supersedes, superseded_by,
       session_id, group_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mem-old', 'fact', 'Old', 0, '[]', null, 'mem-new', 'sess-1', 'test', oldDate);

    db.prepare(
      `INSERT INTO entries (id, type, content, behavioral, tags, supersedes, superseded_by,
       session_id, group_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'mem-new',
      'fact',
      'New',
      0,
      '[]',
      'mem-old',
      null,
      'sess-1',
      'test',
      new Date().toISOString(),
    );

    const purged = store.purgeSuperseded(90);
    expect(purged).toBe(1);
    // Only the old superseded entry was deleted
    expect(store.getById('mem-old')).toBeNull();
    expect(store.getById('mem-new')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Handler-level injection resistance
// ---------------------------------------------------------------------------

describe('Handler-level injection resistance', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    ({ handler } = createHandler());
  });

  it('memory_store handles SQL injection in content field', async () => {
    const result = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: "'; DROP TABLE entries; --" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result['content']).toBe("'; DROP TABLE entries; --");
  });

  it('memory_search handles SQL injection in query field', async () => {
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Safe entry' },
      makeContext(),
    );

    // Injection attempt through handler
    try {
      const result = await handler.handleToolInvocation(
        'memory_search',
        { query: "'; DROP TABLE entries; --" },
        makeContext(),
      );

      if (result.ok) {
        // Query was processed safely
        expect(Array.isArray(result.result['results'])).toBe(true);
      }
    } catch {
      // FTS5 parse error is acceptable
    }
  });

  it('memory_delete handles SQL injection in id field', async () => {
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Keep this' },
      makeContext(),
    );

    const result = await handler.handleToolInvocation(
      'memory_delete',
      { id: "' OR 1=1 --" },
      makeContext(),
    );

    // Should fail (not found), not delete everything
    expect(result.ok).toBe(false);

    // Verify the entry still exists
    const search = await handler.handleToolInvocation('memory_search', {}, makeContext());
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    const results = search.result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
  });

  it('memory_store handles injection in supersedes field', async () => {
    const result = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Test', supersedes: "' OR 1=1 --" },
      makeContext(),
    );

    // Should fail with "not found" error, not execute injection
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — combined attacks
// ---------------------------------------------------------------------------

describe('Combined attack vectors', () => {
  it('SQL injection in content does not leak through FTS5 search', () => {
    const { store } = createStore();

    // Store a malicious entry
    store.store({
      type: 'fact',
      content: "secret'; SELECT * FROM entries WHERE type='preference",
      session_id: 's1',
      group: 'test',
    });

    // Store a normal entry
    store.store({
      type: 'preference',
      content: 'Normal preference',
      session_id: 's1',
      group: 'test',
    });

    // Search should not leak entries through injection
    const results = store.search({ query: 'secret' });
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain('secret');
  });

  it('multiple concurrent injection attempts do not corrupt database', () => {
    const { store } = createStore();

    const payloads = [
      "'; DROP TABLE entries; --",
      "' UNION ALL SELECT 1,2,3,4,5,6,7,8,9,10 --",
      "1; ATTACH DATABASE ':memory:' AS evil; --",
      "'; INSERT INTO entries VALUES ('hack','fact','evil',0,'[]',null,null,'s','g','t'); --",
      "' OR '1'='1",
    ];

    for (const payload of payloads) {
      store.store({
        type: 'fact',
        content: payload,
        session_id: 's1',
        group: 'test',
      });
    }

    // All entries stored safely — none executed as SQL
    expect(store.count()).toBe(payloads.length);

    // Can retrieve each one
    const results = store.search({ limit: 100 });
    expect(results).toHaveLength(payloads.length);
  });

  it('group name traversal combined with SQL injection', () => {
    const manager = new SqliteManager({ baseDir: '/tmp/test-db', useMemory: true });

    // Combined attack: traverse path and inject SQL
    expect(() =>
      manager.getDatabase('memory', "../../../tmp/evil'; DROP TABLE entries; --"),
    ).toThrow(/invalid.*group/i);

    manager.shutdown();
  });
});
