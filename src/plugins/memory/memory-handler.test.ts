import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryHandler } from './memory-handler.js';
import { MemoryStore, MEMORY_MIGRATIONS } from './memory-store.js';
import type { PluginContext } from '../../core/plugin-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
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
// memory_store
// ---------------------------------------------------------------------------

describe('MemoryHandler.memory_store', () => {
  let handler: MemoryHandler;
  let store: MemoryStore;

  beforeEach(() => {
    ({ handler, store } = createHandler());
  });

  it('stores a valid entry and returns it', async () => {
    const ctx = makeContext();
    const result = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'User has a cat named Luna' },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatchObject({
      id: expect.stringMatching(/^mem-/),
      type: 'fact',
      content: 'User has a cat named Luna',
      behavioral: false,
    });
  });

  it('derives behavioral=true for preference type', async () => {
    const result = await handler.handleToolInvocation(
      'memory_store',
      { type: 'preference', content: 'Prefers dark mode' },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result['behavioral']).toBe(true);
  });

  it('populates provenance from context, not arguments', async () => {
    const ctx = makeContext({ group: 'email', sessionId: 'sess-abc' });
    const result = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'A fact' },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result['session_id']).toBe('sess-abc');
    expect(result.result['group']).toBe('email');
  });

  it('stores with tags', async () => {
    const result = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Knows TypeScript', tags: ['coding', 'typescript'] },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result['tags']).toEqual(['coding', 'typescript']);
  });

  it('handles supersession', async () => {
    const first = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Old fact' },
      makeContext(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'New fact', supersedes: first.result['id'] as string },
      makeContext(),
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result['supersedes']).toBe(first.result['id']);
  });

  it('returns error when superseding non-existent entry', async () => {
    const result = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'New fact', supersedes: 'mem-nonexistent' },
      makeContext(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('HANDLER_ERROR');
    expect(result.error.message).toMatch(/not found/i);
  });

  it('returns error on invalid entry type', async () => {
    const result = await handler.handleToolInvocation(
      'memory_store',
      { type: 'bogus', content: 'Bad type' },
      makeContext(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('HANDLER_ERROR');
    expect(result.error.message).toMatch(/invalid.*type/i);
  });

  it('enforces max 20 stores per session', async () => {
    const ctx = makeContext({ sessionId: 'sess-limited' });

    for (let i = 0; i < 20; i++) {
      const r = await handler.handleToolInvocation(
        'memory_store',
        { type: 'fact', content: `Entry ${i}` },
        ctx,
      );
      expect(r.ok).toBe(true);
    }

    const result = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Entry 21' },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RATE_LIMITED');
    expect(result.error.retriable).toBe(false);
  });

  it('enforces max 5 supersedes per session', async () => {
    const ctx = makeContext({ sessionId: 'sess-supersede' });

    // Create entries to supersede
    const entries: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await handler.handleToolInvocation(
        'memory_store',
        { type: 'fact', content: `Base ${i}` },
        ctx,
      );
      if (r.ok) entries.push(r.result['id'] as string);
    }

    // Supersede 5 entries — should succeed
    for (let i = 0; i < 5; i++) {
      const r = await handler.handleToolInvocation(
        'memory_store',
        { type: 'fact', content: `Replacement ${i}`, supersedes: entries[i] },
        ctx,
      );
      expect(r.ok).toBe(true);
    }

    // 6th supersession — should fail
    const result = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Replacement 6', supersedes: entries[5] },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RATE_LIMITED');
  });

  it('rate limits are per-session, not global', async () => {
    const ctx1 = makeContext({ sessionId: 'sess-a' });
    const ctx2 = makeContext({ sessionId: 'sess-b' });

    for (let i = 0; i < 20; i++) {
      await handler.handleToolInvocation(
        'memory_store',
        { type: 'fact', content: `Entry ${i}` },
        ctx1,
      );
    }

    // Different session should still work
    const result = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'From other session' },
      ctx2,
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------

describe('MemoryHandler.memory_search', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    ({ handler } = createHandler());
  });

  it('returns empty results for empty store', async () => {
    const result = await handler.handleToolInvocation('memory_search', {}, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result['results']).toEqual([]);
  });

  it('returns recent entries with no query', async () => {
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Fact A' },
      makeContext(),
    );
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Fact B' },
      makeContext(),
    );

    const result = await handler.handleToolInvocation('memory_search', {}, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const results = result.result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
  });

  it('searches by FTS5 text query', async () => {
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'User likes TypeScript' },
      makeContext(),
    );
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'User has a dog named Luna' },
      makeContext(),
    );

    const result = await handler.handleToolInvocation(
      'memory_search',
      { query: 'TypeScript' },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const results = result.result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]!['content']).toContain('TypeScript');
  });

  it('filters by type', async () => {
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'preference', content: 'Likes dark mode' },
      makeContext(),
    );
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Has a cat' },
      makeContext(),
    );

    const result = await handler.handleToolInvocation(
      'memory_search',
      { type: 'preference' },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const results = result.result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]!['type']).toBe('preference');
  });

  it('filters by tags', async () => {
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Knows TS', tags: ['coding', 'typescript'] },
      makeContext(),
    );
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Knows Python', tags: ['coding', 'python'] },
      makeContext(),
    );

    const result = await handler.handleToolInvocation(
      'memory_search',
      { tags: ['coding', 'typescript'] },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const results = result.result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]!['content']).toContain('TS');
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await handler.handleToolInvocation(
        'memory_store',
        { type: 'fact', content: `Entry ${i}` },
        makeContext(),
      );
    }

    const result = await handler.handleToolInvocation('memory_search', { limit: 2 }, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const results = result.result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
  });

  it('excludes superseded entries by default', async () => {
    const first = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Old fact' },
      makeContext(),
    );
    if (!first.ok) return;

    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'New fact', supersedes: first.result['id'] as string },
      makeContext(),
    );

    const result = await handler.handleToolInvocation('memory_search', {}, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const results = result.result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]!['content']).toBe('New fact');
  });

  it('includes superseded entries when requested', async () => {
    const first = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Old fact' },
      makeContext(),
    );
    if (!first.ok) return;

    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'New fact', supersedes: first.result['id'] as string },
      makeContext(),
    );

    const result = await handler.handleToolInvocation(
      'memory_search',
      { include_superseded: true },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const results = result.result['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// memory_brief
// ---------------------------------------------------------------------------

describe('MemoryHandler.memory_brief', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    ({ handler } = createHandler());
  });

  it('returns empty brief for empty store', async () => {
    const result = await handler.handleToolInvocation('memory_brief', {}, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result['entries']).toEqual([]);
    expect(result.result['entry_count']).toBe(0);
    expect(result.result['brief_count']).toBe(0);
    expect(result.result['generated_at']).toBeDefined();
  });

  it('returns entries with behavioral flag and stripped newlines', async () => {
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'preference', content: 'Likes dark\nmode\nplease' },
      makeContext(),
    );

    const result = await handler.handleToolInvocation('memory_brief', {}, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = result.result['entries'] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!['content']).toBe('Likes dark mode please');
    expect(entries[0]!['behavioral']).toBe(true);
    expect(entries[0]!['type']).toBe('preference');
  });

  it('strips \\r\\n, \\r, and unicode line separators', async () => {
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Line1\r\nLine2\rLine3\u2028Line4\u2029Line5' },
      makeContext(),
    );

    const result = await handler.handleToolInvocation('memory_brief', {}, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = result.result['entries'] as Array<Record<string, unknown>>;
    expect(entries[0]!['content']).toBe('Line1 Line2 Line3 Line4 Line5');
  });

  it('includes age_days in entries', async () => {
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Recent entry' },
      makeContext(),
    );

    const result = await handler.handleToolInvocation('memory_brief', {}, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = result.result['entries'] as Array<Record<string, unknown>>;
    expect(entries[0]!['age_days']).toBe(0);
  });

  it('excludes superseded entries', async () => {
    const first = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Old' },
      makeContext(),
    );
    if (!first.ok) return;

    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'New', supersedes: first.result['id'] as string },
      makeContext(),
    );

    const result = await handler.handleToolInvocation('memory_brief', {}, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = result.result['entries'] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!['content']).toBe('New');
  });

  it('sorts behavioral entries before non-behavioral', async () => {
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'Non-behavioral fact' },
      makeContext(),
    );
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'preference', content: 'Behavioral pref' },
      makeContext(),
    );

    const result = await handler.handleToolInvocation('memory_brief', {}, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = result.result['entries'] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]!['behavioral']).toBe(true);
    expect(entries[1]!['behavioral']).toBe(false);
  });

  it('respects max_brief_entries limit', async () => {
    const smallHandler = new MemoryHandler(createHandler().store, {
      maxBriefEntries: 3,
      maxBriefChars: 100000,
    });

    for (let i = 0; i < 5; i++) {
      await smallHandler.handleToolInvocation(
        'memory_store',
        { type: 'fact', content: `Entry ${i}` },
        makeContext(),
      );
    }

    const result = await smallHandler.handleToolInvocation('memory_brief', {}, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = result.result['entries'] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(3);
    expect(result.result['entry_count']).toBe(5);
    expect(result.result['brief_count']).toBe(3);
  });

  it('respects max_brief_chars limit', async () => {
    const smallHandler = new MemoryHandler(createHandler().store, {
      maxBriefEntries: 100,
      maxBriefChars: 50,
    });

    await smallHandler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'A'.repeat(30) },
      makeContext(),
    );
    await smallHandler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'B'.repeat(30) },
      makeContext(),
    );

    const result = await smallHandler.handleToolInvocation('memory_brief', {}, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = result.result['entries'] as Array<Record<string, unknown>>;
    // Only 1 entry fits within 50 chars
    expect(entries).toHaveLength(1);
  });

  it('includes provenance when include_provenance=true', async () => {
    await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'A fact' },
      makeContext({ sessionId: 'sess-prov' }),
    );

    const result = await handler.handleToolInvocation(
      'memory_brief',
      { include_provenance: true },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = result.result['entries'] as Array<Record<string, unknown>>;
    expect(entries[0]!['session_id']).toBe('sess-prov');
  });
});

// ---------------------------------------------------------------------------
// memory_delete
// ---------------------------------------------------------------------------

describe('MemoryHandler.memory_delete', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    ({ handler } = createHandler());
  });

  it('deletes an existing entry', async () => {
    const stored = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'To delete' },
      makeContext(),
    );
    if (!stored.ok) return;

    const result = await handler.handleToolInvocation(
      'memory_delete',
      { id: stored.result['id'] as string },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result['deleted']).toBe(true);
  });

  it('returns error for non-existent entry', async () => {
    const result = await handler.handleToolInvocation(
      'memory_delete',
      { id: 'mem-nonexistent' },
      makeContext(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('HANDLER_ERROR');
    expect(result.error.message).toMatch(/not found/i);
  });

  it('enforces max 5 deletes per session', async () => {
    const ctx = makeContext({ sessionId: 'sess-del' });

    // Store entries to delete
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await handler.handleToolInvocation(
        'memory_store',
        { type: 'fact', content: `Entry ${i}` },
        ctx,
      );
      if (r.ok) ids.push(r.result['id'] as string);
    }

    // Delete 5 — should succeed
    for (let i = 0; i < 5; i++) {
      const r = await handler.handleToolInvocation('memory_delete', { id: ids[i] }, ctx);
      expect(r.ok).toBe(true);
    }

    // 6th delete — should fail
    const result = await handler.handleToolInvocation('memory_delete', { id: ids[5] }, ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RATE_LIMITED');
    expect(result.error.retriable).toBe(false);
  });

  it('rate limits are per-session', async () => {
    const ctx1 = makeContext({ sessionId: 'sess-del-a' });
    const ctx2 = makeContext({ sessionId: 'sess-del-b' });

    // Exhaust deletes in session A
    for (let i = 0; i < 5; i++) {
      const stored = await handler.handleToolInvocation(
        'memory_store',
        { type: 'fact', content: `Entry ${i}` },
        ctx1,
      );
      if (stored.ok) {
        await handler.handleToolInvocation(
          'memory_delete',
          { id: stored.result['id'] as string },
          ctx1,
        );
      }
    }

    // Session B should still work
    const stored = await handler.handleToolInvocation(
      'memory_store',
      { type: 'fact', content: 'From B' },
      ctx2,
    );
    if (!stored.ok) return;

    const result = await handler.handleToolInvocation(
      'memory_delete',
      { id: stored.result['id'] as string },
      ctx2,
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown tool
// ---------------------------------------------------------------------------

describe('MemoryHandler unknown tool', () => {
  it('returns error for unknown tool name', async () => {
    const { handler } = createHandler();
    const result = await handler.handleToolInvocation('memory_unknown', {}, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('HANDLER_ERROR');
    expect(result.error.message).toMatch(/unknown.*tool/i);
  });
});
