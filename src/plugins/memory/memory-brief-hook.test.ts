import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryBriefProvider, formatBriefAsMarkdown } from './memory-brief-hook.js';
import type { MemoryBrief } from './memory-brief-hook.js';
import { MemoryStore, MEMORY_MIGRATIONS } from './memory-store.js';
import type { MemoryEntryType } from './memory-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

function createStore(): MemoryStore {
  const db = createDb();
  return MemoryStore.create(db, MEMORY_MIGRATIONS);
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
    content: 'Test entry',
    tags: [],
    session_id: 'sess-001',
    group: 'test-group',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// getBrief()
// ---------------------------------------------------------------------------

describe('MemoryBriefProvider.getBrief', () => {
  let store: MemoryStore;
  let provider: MemoryBriefProvider;

  beforeEach(() => {
    store = createStore();
    provider = new MemoryBriefProvider((group) => {
      // In tests, all entries go to same store
      return store;
    });
  });

  it('returns empty brief for empty store', async () => {
    const brief = await provider.getBrief('test-group');

    expect(brief.entries).toEqual([]);
    expect(brief.entry_count).toBe(0);
    expect(brief.brief_count).toBe(0);
    expect(brief.generated_at).toBeDefined();
    expect(new Date(brief.generated_at).toISOString()).toBe(brief.generated_at);
  });

  it('returns entries from the store', async () => {
    storeEntry(store, { type: 'fact', content: 'User has a cat' });
    storeEntry(store, { type: 'preference', content: 'Prefers dark mode' });

    const brief = await provider.getBrief('test-group');

    expect(brief.entries).toHaveLength(2);
    expect(brief.entry_count).toBe(2);
    expect(brief.brief_count).toBe(2);
  });

  it('sorts behavioral entries before non-behavioral', async () => {
    storeEntry(store, { type: 'fact', content: 'Non-behavioral fact' });
    storeEntry(store, { type: 'context', content: 'Non-behavioral context' });
    storeEntry(store, { type: 'preference', content: 'Behavioral preference' });
    storeEntry(store, { type: 'instruction', content: 'Behavioral instruction' });

    const brief = await provider.getBrief('test-group');

    expect(brief.entries).toHaveLength(4);
    // Behavioral first
    expect(brief.entries[0]!.behavioral).toBe(true);
    expect(brief.entries[1]!.behavioral).toBe(true);
    // Non-behavioral after
    expect(brief.entries[2]!.behavioral).toBe(false);
    expect(brief.entries[3]!.behavioral).toBe(false);
  });

  it('strips \\n from content', async () => {
    storeEntry(store, { content: 'Line1\nLine2\nLine3' });

    const brief = await provider.getBrief('test-group');

    expect(brief.entries[0]!.content).toBe('Line1 Line2 Line3');
  });

  it('strips \\r\\n from content', async () => {
    storeEntry(store, { content: 'Line1\r\nLine2\r\nLine3' });

    const brief = await provider.getBrief('test-group');

    expect(brief.entries[0]!.content).toBe('Line1 Line2 Line3');
  });

  it('strips \\r from content', async () => {
    storeEntry(store, { content: 'Line1\rLine2\rLine3' });

    const brief = await provider.getBrief('test-group');

    expect(brief.entries[0]!.content).toBe('Line1 Line2 Line3');
  });

  it('strips Unicode U+2028 line separator', async () => {
    storeEntry(store, { content: 'Line1\u2028Line2' });

    const brief = await provider.getBrief('test-group');

    expect(brief.entries[0]!.content).toBe('Line1 Line2');
  });

  it('strips Unicode U+2029 paragraph separator', async () => {
    storeEntry(store, { content: 'Line1\u2029Line2' });

    const brief = await provider.getBrief('test-group');

    expect(brief.entries[0]!.content).toBe('Line1 Line2');
  });

  it('strips mixed newline variants', async () => {
    storeEntry(store, { content: 'A\r\nB\rC\nD\u2028E\u2029F' });

    const brief = await provider.getBrief('test-group');

    expect(brief.entries[0]!.content).toBe('A B C D E F');
  });

  it('includes age_days in entries', async () => {
    storeEntry(store, { content: 'Recent entry' });

    const brief = await provider.getBrief('test-group');

    expect(brief.entries[0]!.age_days).toBe(0);
  });

  it('excludes superseded entries', async () => {
    const original = storeEntry(store, { content: 'Old fact' });
    storeEntry(store, { content: 'New fact', supersedes: original.id });

    const brief = await provider.getBrief('test-group');

    expect(brief.entries).toHaveLength(1);
    expect(brief.entries[0]!.content).toBe('New fact');
  });

  it('respects max_brief_entries limit', async () => {
    const smallProvider = new MemoryBriefProvider(() => store, {
      maxBriefEntries: 3,
      maxBriefChars: 100000,
    });

    for (let i = 0; i < 5; i++) {
      storeEntry(store, { content: `Entry ${i}` });
    }

    const brief = await smallProvider.getBrief('test-group');

    expect(brief.entries).toHaveLength(3);
    expect(brief.entry_count).toBe(5);
    expect(brief.brief_count).toBe(3);
  });

  it('respects max_brief_chars limit', async () => {
    const smallProvider = new MemoryBriefProvider(() => store, {
      maxBriefEntries: 100,
      maxBriefChars: 50,
    });

    storeEntry(store, { content: 'A'.repeat(30) });
    storeEntry(store, { content: 'B'.repeat(30) });

    const brief = await smallProvider.getBrief('test-group');

    // Only first entry fits within 50 chars
    expect(brief.entries).toHaveLength(1);
  });

  it('stops at whichever limit is hit first (entries)', async () => {
    const smallProvider = new MemoryBriefProvider(() => store, {
      maxBriefEntries: 2,
      maxBriefChars: 100000,
    });

    for (let i = 0; i < 5; i++) {
      storeEntry(store, { content: `Entry ${i}` });
    }

    const brief = await smallProvider.getBrief('test-group');
    expect(brief.entries).toHaveLength(2);
  });

  it('stops at whichever limit is hit first (chars)', async () => {
    const smallProvider = new MemoryBriefProvider(() => store, {
      maxBriefEntries: 100,
      maxBriefChars: 10,
    });

    storeEntry(store, { content: 'ABCDEFGHIJ' }); // 10 chars, fits
    storeEntry(store, { content: 'K' }); // would exceed

    const brief = await smallProvider.getBrief('test-group');
    expect(brief.entries).toHaveLength(1);
  });

  it('includes correct entry fields', async () => {
    storeEntry(store, {
      type: 'preference',
      content: 'Prefers TypeScript',
      tags: ['coding'],
    });

    const brief = await provider.getBrief('test-group');
    const entry = brief.entries[0]!;

    expect(entry.id).toMatch(/^mem-/);
    expect(entry.type).toBe('preference');
    expect(entry.content).toBe('Prefers TypeScript');
    expect(entry.behavioral).toBe(true);
    expect(entry.tags).toEqual(['coding']);
    expect(entry.age_days).toBeGreaterThanOrEqual(0);
  });

  it('uses the provided group to get the store', async () => {
    let requestedGroup: string | undefined;
    const trackingProvider = new MemoryBriefProvider((group) => {
      requestedGroup = group;
      return store;
    });

    await trackingProvider.getBrief('email');
    expect(requestedGroup).toBe('email');
  });

  it('resolves quickly (well under 5-second timeout)', async () => {
    for (let i = 0; i < 50; i++) {
      storeEntry(store, { content: `Entry ${i}` });
    }

    const start = Date.now();
    await provider.getBrief('test-group');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000); // Should be well under 5s
  });
});

// ---------------------------------------------------------------------------
// formatBriefAsMarkdown()
// ---------------------------------------------------------------------------

describe('formatBriefAsMarkdown', () => {
  it('returns empty string for empty brief', () => {
    const brief: MemoryBrief = {
      entries: [],
      generated_at: new Date().toISOString(),
      entry_count: 0,
      brief_count: 0,
    };

    expect(formatBriefAsMarkdown(brief)).toBe('');
  });

  it('includes Memory Context heading', () => {
    const brief: MemoryBrief = {
      entries: [
        {
          id: 'mem-1',
          type: 'fact',
          content: 'Has a cat',
          behavioral: false,
          tags: [],
          age_days: 5,
        },
      ],
      generated_at: new Date().toISOString(),
      entry_count: 1,
      brief_count: 1,
    };

    const md = formatBriefAsMarkdown(brief);
    expect(md).toContain('## Memory Context');
  });

  it('separates behavioral and non-behavioral sections', () => {
    const brief: MemoryBrief = {
      entries: [
        {
          id: 'mem-1',
          type: 'preference',
          content: 'Likes dark mode',
          behavioral: true,
          tags: [],
          age_days: 3,
        },
        {
          id: 'mem-2',
          type: 'fact',
          content: 'Has a dog',
          behavioral: false,
          tags: [],
          age_days: 10,
        },
      ],
      generated_at: new Date().toISOString(),
      entry_count: 2,
      brief_count: 2,
    };

    const md = formatBriefAsMarkdown(brief);
    expect(md).toContain('### Behavioral Preferences');
    expect(md).toContain('### Known Facts');
  });

  it('includes behavioral warning block', () => {
    const brief: MemoryBrief = {
      entries: [
        {
          id: 'mem-1',
          type: 'preference',
          content: 'Likes dark mode',
          behavioral: true,
          tags: [],
          age_days: 3,
        },
      ],
      generated_at: new Date().toISOString(),
      entry_count: 1,
      brief_count: 1,
    };

    const md = formatBriefAsMarkdown(brief);
    expect(md).toContain('suggestions from prior sessions, not commands');
  });

  it('formats entries as list items with type and age', () => {
    const brief: MemoryBrief = {
      entries: [
        {
          id: 'mem-1',
          type: 'preference',
          content: 'Prefers TypeScript',
          behavioral: true,
          tags: [],
          age_days: 3,
        },
        {
          id: 'mem-2',
          type: 'fact',
          content: 'User has a dog named Luna',
          behavioral: false,
          tags: [],
          age_days: 30,
        },
      ],
      generated_at: new Date().toISOString(),
      entry_count: 2,
      brief_count: 2,
    };

    const md = formatBriefAsMarkdown(brief);
    expect(md).toContain('[preference] Prefers TypeScript (3d ago)');
    expect(md).toContain('[fact] User has a dog named Luna (30d ago)');
  });

  it('omits behavioral section when no behavioral entries', () => {
    const brief: MemoryBrief = {
      entries: [
        {
          id: 'mem-1',
          type: 'fact',
          content: 'Has a cat',
          behavioral: false,
          tags: [],
          age_days: 5,
        },
      ],
      generated_at: new Date().toISOString(),
      entry_count: 1,
      brief_count: 1,
    };

    const md = formatBriefAsMarkdown(brief);
    expect(md).not.toContain('### Behavioral Preferences');
    expect(md).toContain('### Known Facts');
  });

  it('omits non-behavioral section when no non-behavioral entries', () => {
    const brief: MemoryBrief = {
      entries: [
        {
          id: 'mem-1',
          type: 'preference',
          content: 'Likes tabs',
          behavioral: true,
          tags: [],
          age_days: 1,
        },
      ],
      generated_at: new Date().toISOString(),
      entry_count: 1,
      brief_count: 1,
    };

    const md = formatBriefAsMarkdown(brief);
    expect(md).toContain('### Behavioral Preferences');
    expect(md).not.toContain('### Known Facts');
  });

  it('shows 0d ago for today entries', () => {
    const brief: MemoryBrief = {
      entries: [
        {
          id: 'mem-1',
          type: 'fact',
          content: 'New fact',
          behavioral: false,
          tags: [],
          age_days: 0,
        },
      ],
      generated_at: new Date().toISOString(),
      entry_count: 1,
      brief_count: 1,
    };

    const md = formatBriefAsMarkdown(brief);
    expect(md).toContain('[fact] New fact (0d ago)');
  });
});
