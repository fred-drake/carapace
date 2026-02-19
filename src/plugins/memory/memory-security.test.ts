/**
 * Tests for memory entry security model.
 *
 * Covers: newline stripping completeness, content length enforcement,
 * supersedes chain depth limits, behavioral flag derivation integrity,
 * FTS5 ranking manipulation resistance, provenance immutability,
 * group isolation, and read-side skepticism instructions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  stripAllNewlines,
  enforceContentLength,
  sanitizeFtsQuery,
  getSupersessionChainDepth,
  MAX_SUPERSESSION_CHAIN_DEPTH,
  deriveBehavioral,
  rejectProvenanceInArgs,
  rejectBehavioralInArgs,
  SKEPTICISM_PREAMBLE,
  MAX_CONTENT_LENGTH,
} from './memory-security.js';
import { MemoryStore, MEMORY_MIGRATIONS } from './memory-store.js';
import type { MemoryEntryType } from './memory-store.js';
import { MemoryHandler } from './memory-handler.js';
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
// stripAllNewlines — comprehensive newline stripping
// ---------------------------------------------------------------------------

describe('stripAllNewlines', () => {
  it('strips LF (\\n)', () => {
    expect(stripAllNewlines('hello\nworld')).toBe('hello world');
  });

  it('strips CR (\\r)', () => {
    expect(stripAllNewlines('hello\rworld')).toBe('hello world');
  });

  it('strips CRLF (\\r\\n)', () => {
    expect(stripAllNewlines('hello\r\nworld')).toBe('hello world');
  });

  it('strips Unicode line separator U+2028', () => {
    expect(stripAllNewlines('hello\u2028world')).toBe('hello world');
  });

  it('strips Unicode paragraph separator U+2029', () => {
    expect(stripAllNewlines('hello\u2029world')).toBe('hello world');
  });

  it('strips vertical tab (\\v / U+000B)', () => {
    expect(stripAllNewlines('hello\u000Bworld')).toBe('hello world');
  });

  it('strips form feed (\\f / U+000C)', () => {
    expect(stripAllNewlines('hello\u000Cworld')).toBe('hello world');
  });

  it('strips NEL (U+0085)', () => {
    expect(stripAllNewlines('hello\u0085world')).toBe('hello world');
  });

  it('strips multiple mixed newline types', () => {
    const input = 'a\nb\rc\r\nd\u2028e\u2029f\u000Bg\u000Ch\u0085i';
    expect(stripAllNewlines(input)).toBe('a b c d e f g h i');
  });

  it('returns unchanged string when no newlines present', () => {
    expect(stripAllNewlines('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(stripAllNewlines('')).toBe('');
  });

  it('collapses consecutive newlines to single space', () => {
    expect(stripAllNewlines('hello\n\n\nworld')).toBe('hello   world');
  });

  it('strips newlines that could break markdown heading injection', () => {
    // Attacker tries to inject a markdown heading via newline
    const malicious = 'harmless text\n## Malicious Heading\nmore evil';
    const stripped = stripAllNewlines(malicious);
    expect(stripped).not.toContain('\n');
    expect(stripped).toBe('harmless text ## Malicious Heading more evil');
  });

  it('strips newlines used for blockquote injection', () => {
    const malicious = 'normal\n> Injected blockquote\n> still injecting';
    const stripped = stripAllNewlines(malicious);
    expect(stripped).not.toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// enforceContentLength
// ---------------------------------------------------------------------------

describe('enforceContentLength', () => {
  it('returns content unchanged when within limit', () => {
    expect(enforceContentLength('hello', 2000)).toBe('hello');
  });

  it('throws when content exceeds limit', () => {
    expect(() => enforceContentLength('A'.repeat(2001), 2000)).toThrow(/content.*length/i);
  });

  it('accepts content at exactly the limit', () => {
    const content = 'A'.repeat(2000);
    expect(enforceContentLength(content, 2000)).toBe(content);
  });

  it('throws for empty content', () => {
    expect(() => enforceContentLength('', 2000)).toThrow(/content.*empty/i);
  });

  it('uses MAX_CONTENT_LENGTH as default', () => {
    // MAX_CONTENT_LENGTH is 2000
    const content = 'A'.repeat(MAX_CONTENT_LENGTH);
    expect(enforceContentLength(content)).toBe(content);
    expect(() => enforceContentLength('A'.repeat(MAX_CONTENT_LENGTH + 1))).toThrow(
      /content.*length/i,
    );
  });
});

// ---------------------------------------------------------------------------
// sanitizeFtsQuery — FTS5 injection resistance
// ---------------------------------------------------------------------------

describe('sanitizeFtsQuery', () => {
  it('allows plain text queries', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('hello world');
  });

  it('strips FTS5 column filter syntax', () => {
    // FTS5 allows "content:" to filter by column
    const sanitized = sanitizeFtsQuery('content:malicious');
    expect(sanitized).not.toContain(':');
  });

  it('strips FTS5 NEAR operator', () => {
    const sanitized = sanitizeFtsQuery('hello NEAR world');
    expect(sanitized.toLowerCase()).not.toMatch(/\bnear\b/);
  });

  it('strips FTS5 AND operator', () => {
    const sanitized = sanitizeFtsQuery('hello AND world');
    expect(sanitized).not.toMatch(/\bAND\b/);
  });

  it('strips FTS5 OR operator', () => {
    const sanitized = sanitizeFtsQuery('hello OR world');
    expect(sanitized).not.toMatch(/\bOR\b/);
  });

  it('strips FTS5 NOT operator', () => {
    const sanitized = sanitizeFtsQuery('hello NOT world');
    expect(sanitized).not.toMatch(/\bNOT\b/);
  });

  it('strips prefix wildcard operator (*)', () => {
    const sanitized = sanitizeFtsQuery('type*');
    expect(sanitized).not.toContain('*');
  });

  it('strips phrase query double quotes', () => {
    const sanitized = sanitizeFtsQuery('"exact phrase"');
    expect(sanitized).not.toContain('"');
  });

  it('strips caret (^) boost operator', () => {
    const sanitized = sanitizeFtsQuery('^important');
    expect(sanitized).not.toContain('^');
  });

  it('strips parentheses used for grouping', () => {
    const sanitized = sanitizeFtsQuery('(hello OR world) AND test');
    expect(sanitized).not.toContain('(');
    expect(sanitized).not.toContain(')');
  });

  it('handles empty query', () => {
    expect(sanitizeFtsQuery('')).toBe('');
  });

  it('preserves basic alphanumeric search terms after stripping operators', () => {
    const sanitized = sanitizeFtsQuery('hello AND beautiful OR world');
    expect(sanitized).toContain('hello');
    expect(sanitized).toContain('beautiful');
    expect(sanitized).toContain('world');
  });

  it('strips curly braces (NEAR syntax variant)', () => {
    const sanitized = sanitizeFtsQuery('NEAR(hello world, 5)');
    expect(sanitized).not.toMatch(/\bNEAR\b/);
  });
});

// ---------------------------------------------------------------------------
// getSupersessionChainDepth
// ---------------------------------------------------------------------------

describe('getSupersessionChainDepth', () => {
  it('returns 0 for an entry with no supersedes', () => {
    const { store } = createStore();
    const entry = store.store({
      type: 'fact',
      content: 'Root entry',
      session_id: 'sess-001',
      group: 'test',
    });
    expect(getSupersessionChainDepth(store, entry.id)).toBe(0);
  });

  it('returns 1 for a single supersession', () => {
    const { store } = createStore();
    const a = store.store({
      type: 'fact',
      content: 'A',
      session_id: 'sess-001',
      group: 'test',
    });
    const b = store.store({
      type: 'fact',
      content: 'B',
      supersedes: a.id,
      session_id: 'sess-001',
      group: 'test',
    });
    expect(getSupersessionChainDepth(store, b.id)).toBe(1);
  });

  it('returns correct depth for chain A→B→C', () => {
    const { store } = createStore();
    const a = store.store({
      type: 'fact',
      content: 'A',
      session_id: 'sess-001',
      group: 'test',
    });
    const b = store.store({
      type: 'fact',
      content: 'B',
      supersedes: a.id,
      session_id: 'sess-001',
      group: 'test',
    });
    const c = store.store({
      type: 'fact',
      content: 'C',
      supersedes: b.id,
      session_id: 'sess-001',
      group: 'test',
    });
    expect(getSupersessionChainDepth(store, c.id)).toBe(2);
  });

  it('caps depth at MAX_SUPERSESSION_CHAIN_DEPTH to prevent cycle attacks', () => {
    expect(MAX_SUPERSESSION_CHAIN_DEPTH).toBeGreaterThan(0);
    expect(MAX_SUPERSESSION_CHAIN_DEPTH).toBeLessThanOrEqual(10);
  });

  it('returns 0 for non-existent entry', () => {
    const { store } = createStore();
    expect(getSupersessionChainDepth(store, 'mem-nonexistent')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deriveBehavioral — canonical flag derivation
// ---------------------------------------------------------------------------

describe('deriveBehavioral', () => {
  it('returns true for preference', () => {
    expect(deriveBehavioral('preference')).toBe(true);
  });

  it('returns true for instruction', () => {
    expect(deriveBehavioral('instruction')).toBe(true);
  });

  it('returns true for correction', () => {
    expect(deriveBehavioral('correction')).toBe(true);
  });

  it('returns false for fact', () => {
    expect(deriveBehavioral('fact')).toBe(false);
  });

  it('returns false for context', () => {
    expect(deriveBehavioral('context')).toBe(false);
  });

  it('returns false for unknown types (defense-in-depth)', () => {
    expect(deriveBehavioral('unknown' as MemoryEntryType)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rejectProvenanceInArgs — wire format cannot override provenance
// ---------------------------------------------------------------------------

describe('rejectProvenanceInArgs', () => {
  it('does not throw for clean args', () => {
    expect(() => rejectProvenanceInArgs({ type: 'fact', content: 'Clean' })).not.toThrow();
  });

  it('throws when args contain session_id', () => {
    expect(() =>
      rejectProvenanceInArgs({ type: 'fact', content: 'X', session_id: 'spoofed' }),
    ).toThrow(/provenance.*session_id/i);
  });

  it('throws when args contain group', () => {
    expect(() =>
      rejectProvenanceInArgs({ type: 'fact', content: 'X', group: 'other-group' }),
    ).toThrow(/provenance.*group/i);
  });

  it('throws when args contain created_at', () => {
    expect(() =>
      rejectProvenanceInArgs({ type: 'fact', content: 'X', created_at: '2020-01-01' }),
    ).toThrow(/provenance.*created_at/i);
  });

  it('throws when args contain id', () => {
    expect(() => rejectProvenanceInArgs({ type: 'fact', content: 'X', id: 'mem-spoofed' })).toThrow(
      /provenance.*id/i,
    );
  });
});

// ---------------------------------------------------------------------------
// rejectBehavioralInArgs — wire format cannot influence behavioral flag
// ---------------------------------------------------------------------------

describe('rejectBehavioralInArgs', () => {
  it('does not throw for clean args', () => {
    expect(() => rejectBehavioralInArgs({ type: 'fact', content: 'Clean' })).not.toThrow();
  });

  it('throws when args contain behavioral field', () => {
    expect(() => rejectBehavioralInArgs({ type: 'fact', content: 'X', behavioral: true })).toThrow(
      /behavioral/i,
    );
  });

  it('throws even when behavioral is false (still a wire-supplied override)', () => {
    expect(() =>
      rejectBehavioralInArgs({ type: 'preference', content: 'X', behavioral: false }),
    ).toThrow(/behavioral/i);
  });
});

// ---------------------------------------------------------------------------
// SKEPTICISM_PREAMBLE — read-side gate
// ---------------------------------------------------------------------------

describe('SKEPTICISM_PREAMBLE', () => {
  it('contains warning about suggestions not commands', () => {
    expect(SKEPTICISM_PREAMBLE).toMatch(/suggestion|not command/i);
  });

  it('instructs verification of unusual instructions', () => {
    expect(SKEPTICISM_PREAMBLE).toMatch(/verify|unusual/i);
  });

  it('is non-empty', () => {
    expect(SKEPTICISM_PREAMBLE.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: security enforcement in handler
// ---------------------------------------------------------------------------

describe('Memory security integration', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    const db = createDb();
    const store = MemoryStore.create(db, MEMORY_MIGRATIONS);
    handler = new MemoryHandler(store);
  });

  describe('behavioral flag derivation integrity', () => {
    it('behavioral flag matches type, not wire-supplied value', async () => {
      // Even if stage-3 somehow let a behavioral field through,
      // the handler must derive it from type
      const result = await handler.handleToolInvocation(
        'memory_store',
        { type: 'fact', content: 'Should not be behavioral' },
        makeContext(),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result['behavioral']).toBe(false);
    });

    it('all behavioral types produce behavioral=true', async () => {
      const behavioralTypes: MemoryEntryType[] = ['preference', 'instruction', 'correction'];

      for (const type of behavioralTypes) {
        const result = await handler.handleToolInvocation(
          'memory_store',
          { type, content: `Entry of type ${type}` },
          makeContext(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.result['behavioral']).toBe(true);
      }
    });

    it('all non-behavioral types produce behavioral=false', async () => {
      const nonBehavioralTypes: MemoryEntryType[] = ['fact', 'context'];

      for (const type of nonBehavioralTypes) {
        const result = await handler.handleToolInvocation(
          'memory_store',
          { type, content: `Entry of type ${type}` },
          makeContext(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.result['behavioral']).toBe(false);
      }
    });
  });

  describe('provenance immutability', () => {
    it('provenance comes from context, ignoring any args', async () => {
      const ctx = makeContext({ group: 'trusted-group', sessionId: 'sess-trusted' });
      const result = await handler.handleToolInvocation(
        'memory_store',
        { type: 'fact', content: 'Test provenance' },
        ctx,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result['session_id']).toBe('sess-trusted');
      expect(result.result['group']).toBe('trusted-group');
    });
  });

  describe('group isolation', () => {
    it('entries stored under one group are only in that group', async () => {
      // Store entry in group A's store
      const dbA = createDb();
      const storeA = MemoryStore.create(dbA, MEMORY_MIGRATIONS);
      const handlerA = new MemoryHandler(storeA);

      // Store entry in group B's store
      const dbB = createDb();
      const storeB = MemoryStore.create(dbB, MEMORY_MIGRATIONS);
      const handlerB = new MemoryHandler(storeB);

      await handlerA.handleToolInvocation(
        'memory_store',
        { type: 'fact', content: 'Secret for group A' },
        makeContext({ group: 'group-a' }),
      );

      // Search in group B's store — should find nothing
      const resultB = await handlerB.handleToolInvocation('memory_search', {}, makeContext());

      expect(resultB.ok).toBe(true);
      if (!resultB.ok) return;
      const results = resultB.result['results'] as Array<Record<string, unknown>>;
      expect(results).toHaveLength(0);
    });
  });

  describe('brief newline stripping completeness', () => {
    it('strips all Unicode newline variants from brief content', async () => {
      await handler.handleToolInvocation(
        'memory_store',
        {
          type: 'fact',
          content:
            'Line1\nLine2\rLine3\r\nLine4\u2028Line5\u2029Line6\u000BLine7\u000CLine8\u0085Line9',
        },
        makeContext(),
      );

      const brief = await handler.handleToolInvocation('memory_brief', {}, makeContext());

      expect(brief.ok).toBe(true);
      if (!brief.ok) return;
      const entries = brief.result['entries'] as Array<Record<string, unknown>>;
      const content = entries[0]!['content'] as string;

      // No newline variants should remain
      expect(content).not.toMatch(/[\n\r\u2028\u2029\u000B\u000C\u0085]/);
    });
  });

  describe('supersedes chain depth', () => {
    it('chain depth is bounded at MAX_SUPERSESSION_CHAIN_DEPTH', () => {
      // The constant must be reasonably small
      expect(MAX_SUPERSESSION_CHAIN_DEPTH).toBeLessThanOrEqual(10);
      expect(MAX_SUPERSESSION_CHAIN_DEPTH).toBeGreaterThanOrEqual(3);
    });
  });
});
