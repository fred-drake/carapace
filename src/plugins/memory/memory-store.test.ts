import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryStore, MEMORY_MIGRATIONS, HANDLER_SCHEMA_VERSION } from './memory-store.js';
import type { MemoryEntryType } from './memory-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

function createStore(db?: Database.Database): { store: MemoryStore; db: Database.Database } {
  const database = db ?? createDb();
  const store = MemoryStore.create(database, MEMORY_MIGRATIONS);
  return { store, db: database };
}

function storeEntry(
  store: MemoryStore,
  overrides?: Partial<{
    type: MemoryEntryType;
    content: string;
    tags: string[];
    supersedes: string;
    session_id: string;
    group: string;
  }>,
) {
  return store.store({
    type: 'fact',
    content: 'Test memory entry',
    tags: [],
    session_id: 'sess-001',
    group: 'test-group',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Schema and migrations
// ---------------------------------------------------------------------------

describe('MemoryStore schema', () => {
  it('creates entries table with correct columns', () => {
    const { db } = createStore();
    const info = db.pragma('table_info(entries)') as Array<{ name: string }>;
    const columns = info.map((c) => c.name);
    expect(columns).toContain('id');
    expect(columns).toContain('type');
    expect(columns).toContain('content');
    expect(columns).toContain('behavioral');
    expect(columns).toContain('tags');
    expect(columns).toContain('supersedes');
    expect(columns).toContain('superseded_by');
    expect(columns).toContain('session_id');
    expect(columns).toContain('group_name');
    expect(columns).toContain('created_at');
  });

  it('creates FTS5 virtual table', () => {
    const { db } = createStore();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries_fts'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('sets user_version to HANDLER_SCHEMA_VERSION', () => {
    const { db } = createStore();
    const version = (db.pragma('user_version') as Array<{ user_version: number }>)[0]!.user_version;
    expect(version).toBe(HANDLER_SCHEMA_VERSION);
  });

  it('refuses to open DB with version higher than handler', () => {
    const db = createDb();
    db.pragma(`user_version = ${HANDLER_SCHEMA_VERSION + 1}`);
    expect(() => MemoryStore.create(db, MEMORY_MIGRATIONS)).toThrow(/version.*higher|downgrade/i);
  });

  it('applies migrations idempotently', () => {
    const db = createDb();
    const store1 = MemoryStore.create(db, MEMORY_MIGRATIONS);
    store1.store({
      type: 'fact',
      content: 'Persisted entry',
      tags: [],
      session_id: 'sess-001',
      group: 'test',
    });

    // Re-create with same migrations — should not error
    const store2 = MemoryStore.create(db, MEMORY_MIGRATIONS);
    const results = store2.search({});
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe('Persisted entry');
  });
});

// ---------------------------------------------------------------------------
// store()
// ---------------------------------------------------------------------------

describe('MemoryStore.store', () => {
  let store: MemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
  });

  it('creates an entry with generated id and timestamp', () => {
    const entry = storeEntry(store);
    expect(entry.id).toMatch(/^mem-/);
    expect(entry.created_at).toBeDefined();
    expect(new Date(entry.created_at).toISOString()).toBe(entry.created_at);
  });

  it('derives behavioral=true for preference type', () => {
    const entry = storeEntry(store, { type: 'preference' });
    expect(entry.behavioral).toBe(true);
  });

  it('derives behavioral=true for instruction type', () => {
    const entry = storeEntry(store, { type: 'instruction' });
    expect(entry.behavioral).toBe(true);
  });

  it('derives behavioral=true for correction type', () => {
    const entry = storeEntry(store, { type: 'correction' });
    expect(entry.behavioral).toBe(true);
  });

  it('derives behavioral=false for fact type', () => {
    const entry = storeEntry(store, { type: 'fact' });
    expect(entry.behavioral).toBe(false);
  });

  it('derives behavioral=false for context type', () => {
    const entry = storeEntry(store, { type: 'context' });
    expect(entry.behavioral).toBe(false);
  });

  it('stores tags as JSON array', () => {
    const entry = storeEntry(store, { tags: ['coding', 'typescript'] });
    expect(entry.tags).toEqual(['coding', 'typescript']);
  });

  it('populates provenance from input', () => {
    const entry = storeEntry(store, {
      session_id: 'sess-abc',
      group: 'email',
    });
    expect(entry.session_id).toBe('sess-abc');
    expect(entry.group).toBe('email');
  });

  it('handles supersession chain', () => {
    const original = storeEntry(store, { content: 'Original fact' });
    const replacement = storeEntry(store, {
      content: 'Updated fact',
      supersedes: original.id,
    });

    expect(replacement.supersedes).toBe(original.id);

    // Original should now have superseded_by set
    const fetched = store.getById(original.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.superseded_by).toBe(replacement.id);
  });

  it('throws when superseding a non-existent entry', () => {
    expect(() => storeEntry(store, { supersedes: 'mem-nonexistent' })).toThrow(
      /not found|does not exist/i,
    );
  });

  it('throws on invalid entry type', () => {
    expect(() => storeEntry(store, { type: 'invalid' as MemoryEntryType })).toThrow(
      /invalid.*type/i,
    );
  });
});

// ---------------------------------------------------------------------------
// getById()
// ---------------------------------------------------------------------------

describe('MemoryStore.getById', () => {
  let store: MemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
  });

  it('returns entry by ID', () => {
    const entry = storeEntry(store);
    const fetched = store.getById(entry.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(entry.id);
    expect(fetched!.content).toBe('Test memory entry');
  });

  it('returns null for non-existent ID', () => {
    expect(store.getById('mem-nonexistent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

describe('MemoryStore.delete', () => {
  let store: MemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
  });

  it('deletes an existing entry', () => {
    const entry = storeEntry(store);
    const deleted = store.delete(entry.id);
    expect(deleted).toBe(true);
    expect(store.getById(entry.id)).toBeNull();
  });

  it('returns false for non-existent entry', () => {
    expect(store.delete('mem-nonexistent')).toBe(false);
  });

  it('entry is removed from FTS5 index after delete', () => {
    const entry = storeEntry(store, { content: 'unique searchable phrase xyz' });
    store.delete(entry.id);
    const results = store.search({ query: 'unique searchable phrase xyz' });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// search()
// ---------------------------------------------------------------------------

describe('MemoryStore.search', () => {
  let store: MemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
  });

  it('returns all active entries when no filters given', () => {
    storeEntry(store, { content: 'First' });
    storeEntry(store, { content: 'Second' });
    const results = store.search({});
    expect(results).toHaveLength(2);
  });

  it('returns results sorted by created_at descending when no query', () => {
    storeEntry(store, { content: 'Older entry' });
    storeEntry(store, { content: 'Newer entry' });
    const results = store.search({});
    expect(results[0]!.content).toBe('Newer entry');
    expect(results[1]!.content).toBe('Older entry');
  });

  it('searches by FTS5 query text', () => {
    storeEntry(store, { content: 'User prefers TypeScript for new projects' });
    storeEntry(store, { content: 'User has a dog named Luna' });

    const results = store.search({ query: 'TypeScript' });
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain('TypeScript');
  });

  it('returns relevance_score for FTS5 queries', () => {
    storeEntry(store, { content: 'TypeScript TypeScript TypeScript' });
    storeEntry(store, { content: 'TypeScript once' });

    const results = store.search({ query: 'TypeScript' });
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Higher relevance first
    expect(results[0]!.relevance_score).toBeGreaterThanOrEqual(results[1]!.relevance_score);
  });

  it('filters by entry type', () => {
    storeEntry(store, { type: 'preference', content: 'Likes dark mode' });
    storeEntry(store, { type: 'fact', content: 'Has a cat' });

    const results = store.search({ type: 'preference' });
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe('preference');
  });

  it('filters by tags (AND logic)', () => {
    storeEntry(store, { content: 'Entry A', tags: ['coding', 'typescript'] });
    storeEntry(store, { content: 'Entry B', tags: ['coding', 'python'] });
    storeEntry(store, { content: 'Entry C', tags: ['personal'] });

    const results = store.search({ tags: ['coding', 'typescript'] });
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe('Entry A');
  });

  it('excludes superseded entries by default', () => {
    const original = storeEntry(store, { content: 'Old preference' });
    storeEntry(store, { content: 'New preference', supersedes: original.id });

    const results = store.search({});
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe('New preference');
  });

  it('includes superseded entries when requested', () => {
    const original = storeEntry(store, { content: 'Old preference' });
    storeEntry(store, { content: 'New preference', supersedes: original.id });

    const results = store.search({ include_superseded: true });
    expect(results).toHaveLength(2);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      storeEntry(store, { content: `Entry ${i}` });
    }
    const results = store.search({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('defaults to limit of 20', () => {
    for (let i = 0; i < 25; i++) {
      storeEntry(store, { content: `Entry ${i}` });
    }
    const results = store.search({});
    expect(results).toHaveLength(20);
  });

  it('combines text query with type filter', () => {
    storeEntry(store, { type: 'preference', content: 'Likes dark mode' });
    storeEntry(store, { type: 'fact', content: 'Uses dark mode at night' });

    const results = store.search({ query: 'dark mode', type: 'preference' });
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe('preference');
  });
});

// ---------------------------------------------------------------------------
// purgeSuperseded()
// ---------------------------------------------------------------------------

describe('MemoryStore.purgeSuperseded', () => {
  let store: MemoryStore;
  let db: Database.Database;

  beforeEach(() => {
    ({ store, db } = createStore());
  });

  it('removes superseded entries older than specified days', () => {
    // Insert an old superseded entry manually
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO entries (id, type, content, behavioral, tags, supersedes, superseded_by,
       session_id, group_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mem-old', 'fact', 'Old entry', 0, '[]', null, 'mem-new', 'sess-1', 'test', oldDate);

    db.prepare(
      `INSERT INTO entries (id, type, content, behavioral, tags, supersedes, superseded_by,
       session_id, group_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'mem-new',
      'fact',
      'New entry',
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
    expect(store.getById('mem-old')).toBeNull();
    expect(store.getById('mem-new')).not.toBeNull();
  });

  it('does not purge active (non-superseded) entries', () => {
    storeEntry(store, { content: 'Active entry' });
    const purged = store.purgeSuperseded(0);
    expect(purged).toBe(0);
  });

  it('does not purge recently superseded entries', () => {
    const original = storeEntry(store, { content: 'Recent original' });
    storeEntry(store, { content: 'Recent replacement', supersedes: original.id });

    // Purge entries older than 90 days — both entries are brand new
    const purged = store.purgeSuperseded(90);
    expect(purged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// count()
// ---------------------------------------------------------------------------

describe('MemoryStore.count', () => {
  it('returns 0 for empty store', () => {
    const { store } = createStore();
    expect(store.count()).toBe(0);
  });

  it('returns correct count after storing entries', () => {
    const { store } = createStore();
    storeEntry(store, { content: 'First' });
    storeEntry(store, { content: 'Second' });
    expect(store.count()).toBe(2);
  });

  it('decrements after deletion', () => {
    const { store } = createStore();
    const entry = storeEntry(store, { content: 'To delete' });
    storeEntry(store, { content: 'To keep' });
    store.delete(entry.id);
    expect(store.count()).toBe(1);
  });
});
