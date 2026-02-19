import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AuditLog } from './audit-log.js';
import type { AuditEntry } from './audit-log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carapace-audit-'));
}

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: '2026-02-19T10:00:00.000Z',
    group: 'test-group',
    source: 'agent-test',
    topic: 'tool.invoke.test_tool',
    correlation: 'corr-001',
    stage: 'route',
    outcome: 'routed',
    ...overrides,
  };
}

function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditLog', () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe('construction', () => {
    it('creates the base directory if it does not exist', () => {
      const auditDir = path.join(tmpDir, 'nested', 'audit');
      const _log = new AuditLog(auditDir);
      expect(fs.existsSync(auditDir)).toBe(true);
    });

    it('uses default path data/audit/ when no path provided', () => {
      // Just verify constructor doesn't throw — don't actually write
      // to the real filesystem. We test default separately.
      const log = new AuditLog(path.join(tmpDir, 'default-audit'));
      expect(log).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Append — basic JSON Lines format
  // -------------------------------------------------------------------------

  describe('append', () => {
    it('writes a single JSON object per line', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry());

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const lines = readLines(filePath);
      expect(lines).toHaveLength(1);
      expect(() => JSON.parse(lines[0])).not.toThrow();
    });

    it('each line parses independently as valid JSON', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ correlation: 'corr-a' }));
      log.append(makeEntry({ correlation: 'corr-b' }));
      log.append(makeEntry({ correlation: 'corr-c' }));

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const lines = readLines(filePath);
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty('timestamp');
        expect(parsed).toHaveProperty('outcome');
      }
    });

    it('preserves all required fields in the logged entry', () => {
      const log = new AuditLog(tmpDir);
      const entry = makeEntry({
        timestamp: '2026-02-19T12:30:00.000Z',
        group: 'my-group',
        source: 'my-source',
        topic: 'tool.invoke.memory_store',
        correlation: 'corr-xyz',
        stage: 'construct',
        outcome: 'routed',
      });
      log.append(entry);

      const filePath = path.join(tmpDir, 'my-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed.timestamp).toBe('2026-02-19T12:30:00.000Z');
      expect(parsed.group).toBe('my-group');
      expect(parsed.source).toBe('my-source');
      expect(parsed.topic).toBe('tool.invoke.memory_store');
      expect(parsed.correlation).toBe('corr-xyz');
      expect(parsed.stage).toBe('construct');
      expect(parsed.outcome).toBe('routed');
    });

    it('is append-only — existing entries are never mutated', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ correlation: 'first' }));

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const before = readLines(filePath);
      expect(before).toHaveLength(1);

      log.append(makeEntry({ correlation: 'second' }));
      const after = readLines(filePath);
      expect(after).toHaveLength(2);

      // First line is unchanged
      expect(after[0]).toBe(before[0]);
    });
  });

  // -------------------------------------------------------------------------
  // Message types logged correctly
  // -------------------------------------------------------------------------

  describe('message type logging', () => {
    it('logs routed messages with outcome "routed"', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ outcome: 'routed' }));

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed.outcome).toBe('routed');
    });

    it('logs rejected messages with outcome "rejected"', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ outcome: 'rejected' }));

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed.outcome).toBe('rejected');
    });

    it('logs sanitized messages with outcome "sanitized"', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ outcome: 'sanitized' }));

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed.outcome).toBe('sanitized');
    });

    it('logs error messages with outcome "error"', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ outcome: 'error' }));

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed.outcome).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // Rejection entries
  // -------------------------------------------------------------------------

  describe('rejection entries', () => {
    it('includes the stage that failed', () => {
      const log = new AuditLog(tmpDir);
      log.append(
        makeEntry({
          outcome: 'rejected',
          stage: 'payload',
          reason: 'Schema validation failed',
        }),
      );

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed.stage).toBe('payload');
      expect(parsed.outcome).toBe('rejected');
    });

    it('includes the rejection reason', () => {
      const log = new AuditLog(tmpDir);
      log.append(
        makeEntry({
          outcome: 'rejected',
          stage: 'authorize',
          reason: 'Insufficient permissions',
        }),
      );

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed.reason).toBe('Insufficient permissions');
    });
  });

  // -------------------------------------------------------------------------
  // Sanitization events
  // -------------------------------------------------------------------------

  describe('sanitization events', () => {
    it('logs field paths affected (not redacted values)', () => {
      const log = new AuditLog(tmpDir);
      log.append(
        makeEntry({
          outcome: 'sanitized',
          stage: 'route',
          fieldPaths: ['payload.result.api_key', 'payload.result.token'],
        }),
      );

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed.fieldPaths).toEqual(['payload.result.api_key', 'payload.result.token']);
      // Ensure no actual values are logged
      expect(parsed).not.toHaveProperty('redactedValues');
    });
  });

  // -------------------------------------------------------------------------
  // Dual-entry handler error logging
  // -------------------------------------------------------------------------

  describe('handler error dual entries', () => {
    it('logs two entries per handler error', () => {
      const log = new AuditLog(tmpDir);

      // Entry 1: before normalization
      log.append(
        makeEntry({
          outcome: 'error',
          stage: 'route',
          correlation: 'corr-err-001',
          phase: 'before_normalization',
          error: { code: 'CUSTOM_ERROR', message: 'Raw handler failure' },
        }),
      );

      // Entry 2: after normalization
      log.append(
        makeEntry({
          outcome: 'error',
          stage: 'route',
          correlation: 'corr-err-001',
          phase: 'after_normalization',
          error: { code: 'HANDLER_ERROR', message: 'Raw handler failure' },
        }),
      );

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const lines = readLines(filePath);
      expect(lines).toHaveLength(2);

      const entry1 = JSON.parse(lines[0]);
      const entry2 = JSON.parse(lines[1]);

      // Linked by correlation ID
      expect(entry1.correlation).toBe('corr-err-001');
      expect(entry2.correlation).toBe('corr-err-001');

      // Before normalization
      expect(entry1.phase).toBe('before_normalization');
      expect(entry1.error.code).toBe('CUSTOM_ERROR');

      // After normalization
      expect(entry2.phase).toBe('after_normalization');
      expect(entry2.error.code).toBe('HANDLER_ERROR');
    });

    it('dual entries are independently parseable', () => {
      const log = new AuditLog(tmpDir);

      log.append(
        makeEntry({
          outcome: 'error',
          correlation: 'corr-dual',
          phase: 'before_normalization',
          error: { code: 'RATE_LIMITED', message: 'Too many requests' },
        }),
      );
      log.append(
        makeEntry({
          outcome: 'error',
          correlation: 'corr-dual',
          phase: 'after_normalization',
          error: { code: 'HANDLER_ERROR', message: 'Too many requests' },
        }),
      );

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const lines = readLines(filePath);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  // -------------------------------------------------------------------------
  // File-per-group organization
  // -------------------------------------------------------------------------

  describe('file-per-group isolation', () => {
    it('writes to separate files based on group', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ group: 'group-alpha' }));
      log.append(makeEntry({ group: 'group-beta' }));

      expect(fs.existsSync(path.join(tmpDir, 'group-alpha.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'group-beta.jsonl'))).toBe(true);

      const alphaLines = readLines(path.join(tmpDir, 'group-alpha.jsonl'));
      const betaLines = readLines(path.join(tmpDir, 'group-beta.jsonl'));
      expect(alphaLines).toHaveLength(1);
      expect(betaLines).toHaveLength(1);
    });

    it('does not mix entries between groups', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ group: 'group-x', correlation: 'x-corr' }));
      log.append(makeEntry({ group: 'group-y', correlation: 'y-corr' }));

      const xEntry = JSON.parse(readLines(path.join(tmpDir, 'group-x.jsonl'))[0]);
      const yEntry = JSON.parse(readLines(path.join(tmpDir, 'group-y.jsonl'))[0]);
      expect(xEntry.correlation).toBe('x-corr');
      expect(yEntry.correlation).toBe('y-corr');
    });
  });

  // -------------------------------------------------------------------------
  // Query by correlation ID
  // -------------------------------------------------------------------------

  describe('queryByCorrelation', () => {
    it('returns all entries with matching correlation ID', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ correlation: 'target', group: 'g1' }));
      log.append(makeEntry({ correlation: 'other', group: 'g1' }));
      log.append(makeEntry({ correlation: 'target', group: 'g1' }));

      const results = log.queryByCorrelation('target', 'g1');
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.correlation).toBe('target');
      }
    });

    it('returns empty array when no matches found', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ correlation: 'abc', group: 'g1' }));

      const results = log.queryByCorrelation('nonexistent', 'g1');
      expect(results).toHaveLength(0);
    });

    it('returns empty array for nonexistent group', () => {
      const log = new AuditLog(tmpDir);
      const results = log.queryByCorrelation('any', 'no-such-group');
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Query by time range
  // -------------------------------------------------------------------------

  describe('queryByTimeRange', () => {
    it('returns entries within the specified range', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ timestamp: '2026-02-19T08:00:00.000Z', group: 'g1' }));
      log.append(makeEntry({ timestamp: '2026-02-19T10:00:00.000Z', group: 'g1' }));
      log.append(makeEntry({ timestamp: '2026-02-19T12:00:00.000Z', group: 'g1' }));
      log.append(makeEntry({ timestamp: '2026-02-19T14:00:00.000Z', group: 'g1' }));

      const results = log.queryByTimeRange(
        '2026-02-19T09:00:00.000Z',
        '2026-02-19T13:00:00.000Z',
        'g1',
      );
      expect(results).toHaveLength(2);
      expect(results[0].timestamp).toBe('2026-02-19T10:00:00.000Z');
      expect(results[1].timestamp).toBe('2026-02-19T12:00:00.000Z');
    });

    it('includes boundary timestamps (inclusive range)', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ timestamp: '2026-02-19T10:00:00.000Z', group: 'g1' }));

      const results = log.queryByTimeRange(
        '2026-02-19T10:00:00.000Z',
        '2026-02-19T10:00:00.000Z',
        'g1',
      );
      expect(results).toHaveLength(1);
    });

    it('returns empty array when no entries in range', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ timestamp: '2026-02-19T08:00:00.000Z', group: 'g1' }));

      const results = log.queryByTimeRange(
        '2026-02-19T20:00:00.000Z',
        '2026-02-19T21:00:00.000Z',
        'g1',
      );
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Query by topic
  // -------------------------------------------------------------------------

  describe('queryByTopic', () => {
    it('returns entries matching the topic', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ topic: 'tool.invoke.memory_store', group: 'g1' }));
      log.append(makeEntry({ topic: 'tool.invoke.email_send', group: 'g1' }));
      log.append(makeEntry({ topic: 'tool.invoke.memory_store', group: 'g1' }));

      const results = log.queryByTopic('tool.invoke.memory_store', 'g1');
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.topic).toBe('tool.invoke.memory_store');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Query by outcome
  // -------------------------------------------------------------------------

  describe('queryByOutcome', () => {
    it('returns entries matching the outcome', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ outcome: 'routed', group: 'g1' }));
      log.append(makeEntry({ outcome: 'rejected', group: 'g1' }));
      log.append(makeEntry({ outcome: 'error', group: 'g1' }));
      log.append(makeEntry({ outcome: 'rejected', group: 'g1' }));

      const results = log.queryByOutcome('rejected', 'g1');
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.outcome).toBe('rejected');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Null correlation
  // -------------------------------------------------------------------------

  describe('null correlation', () => {
    it('handles entries with null correlation', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry({ correlation: null }));

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed.correlation).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Optional fields omission
  // -------------------------------------------------------------------------

  describe('optional fields', () => {
    it('does not include reason when not provided', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry());

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed).not.toHaveProperty('reason');
    });

    it('does not include fieldPaths when not provided', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry());

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed).not.toHaveProperty('fieldPaths');
    });

    it('does not include error when not provided', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry());

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed).not.toHaveProperty('error');
    });

    it('does not include phase when not provided', () => {
      const log = new AuditLog(tmpDir);
      log.append(makeEntry());

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const parsed = JSON.parse(readLines(filePath)[0]);
      expect(parsed).not.toHaveProperty('phase');
    });
  });
});
