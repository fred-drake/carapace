/**
 * Memory store search latency benchmark (QA-11).
 *
 * Measures FTS5 search latency with varying dataset sizes.
 * Uses in-memory SQLite for deterministic benchmarks.
 *
 * Target: <50ms FTS5 search over 1000 entries.
 */

import { bench, describe } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { MemoryStore, MEMORY_MIGRATIONS } from '../plugins/memory/memory-store.js';
import type { MemoryEntryType } from '../plugins/memory/memory-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPopulatedStore(entryCount: number): MemoryStore {
  const db = new BetterSqlite3(':memory:');
  const store = MemoryStore.create(db, MEMORY_MIGRATIONS);

  const types: MemoryEntryType[] = ['preference', 'fact', 'instruction', 'context', 'correction'];
  const sampleTexts = [
    'Remember to use TypeScript strict mode in all projects',
    'The database connection string should use connection pooling',
    'Prefer functional programming patterns over imperative loops',
    'Use semantic versioning for all package releases',
    'The user prefers dark mode in all applications',
    'Always run linting before committing code changes',
    'Deploy to staging before production for safety',
    'Use environment variables for all configuration secrets',
    'The API rate limit is 100 requests per minute',
    'Prefer composition over inheritance in class design',
  ];

  for (let i = 0; i < entryCount; i++) {
    store.store({
      type: types[i % types.length]!,
      content: `${sampleTexts[i % sampleTexts.length]} (entry ${i})`,
      tags: [`tag-${i % 10}`, `category-${i % 5}`],
      session_id: `bench-session-${i % 3}`,
      group: 'bench',
    });
  }

  return store;
}

// Module-level setup
const store1k = createPopulatedStore(1000);
const store5k = createPopulatedStore(5000);

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('memory FTS5 search latency', () => {
  bench(
    'FTS5 search over 1000 entries',
    () => {
      store1k.search({ query: 'TypeScript strict mode' });
    },
    { iterations: 200, time: 5000 },
  );

  bench(
    'FTS5 search over 5000 entries',
    () => {
      store5k.search({ query: 'database connection pooling' });
    },
    { iterations: 200, time: 5000 },
  );

  bench(
    'filtered search (type + tags) over 1000 entries',
    () => {
      store1k.search({ type: 'preference', tags: ['tag-3'] });
    },
    { iterations: 200, time: 5000 },
  );

  bench(
    'combined FTS + filter over 1000 entries',
    () => {
      store1k.search({ query: 'programming patterns', type: 'fact', limit: 10 });
    },
    { iterations: 200, time: 5000 },
  );
});

describe('memory store write latency', () => {
  // Fresh store per bench call to avoid growing the DB
  const writeDb = new BetterSqlite3(':memory:');
  const writeStore = MemoryStore.create(writeDb, MEMORY_MIGRATIONS);

  bench(
    'store single entry',
    () => {
      writeStore.store({
        type: 'fact',
        content: `Benchmark entry ${Date.now()}`,
        tags: ['bench'],
        session_id: 'bench-session',
        group: 'bench',
      });
    },
    { iterations: 500, time: 5000 },
  );
});
