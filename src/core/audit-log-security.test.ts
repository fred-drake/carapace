import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SecureAuditLog } from './audit-log-security.js';
import type { AuditEntry } from './audit-log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carapace-sec-audit-'));
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

function readParsed(filePath: string): Array<Record<string, unknown>> {
  return readLines(filePath).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SecureAuditLog', () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Sequence numbers
  // -------------------------------------------------------------------------

  describe('sequence numbers', () => {
    it('adds seq starting from 1 to each entry', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry());

      const entries = readParsed(path.join(tmpDir, 'test-group.jsonl'));
      expect(entries[0]!['seq']).toBe(1);
    });

    it('increments seq for each append in same group', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry());
      log.append(makeEntry());
      log.append(makeEntry());

      const entries = readParsed(path.join(tmpDir, 'test-group.jsonl'));
      expect(entries[0]!['seq']).toBe(1);
      expect(entries[1]!['seq']).toBe(2);
      expect(entries[2]!['seq']).toBe(3);
    });

    it('maintains separate sequences per group', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry({ group: 'alpha' }));
      log.append(makeEntry({ group: 'beta' }));
      log.append(makeEntry({ group: 'alpha' }));

      const alpha = readParsed(path.join(tmpDir, 'alpha.jsonl'));
      const beta = readParsed(path.join(tmpDir, 'beta.jsonl'));
      expect(alpha[0]!['seq']).toBe(1);
      expect(alpha[1]!['seq']).toBe(2);
      expect(beta[0]!['seq']).toBe(1);
    });

    it('resumes sequence from existing entries on new instance', () => {
      const log1 = new SecureAuditLog(tmpDir);
      log1.append(makeEntry());
      log1.append(makeEntry());

      // New instance reads existing entries to resume sequence
      const log2 = new SecureAuditLog(tmpDir);
      log2.append(makeEntry());

      const entries = readParsed(path.join(tmpDir, 'test-group.jsonl'));
      expect(entries[2]!['seq']).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Integrity verification
  // -------------------------------------------------------------------------

  describe('verifyIntegrity', () => {
    it('returns valid for contiguous sequence', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry());
      log.append(makeEntry());
      log.append(makeEntry());

      const result = log.verifyIntegrity('test-group');
      expect(result.valid).toBe(true);
      expect(result.totalEntries).toBe(3);
      expect(result.errors).toHaveLength(0);
    });

    it('returns valid for empty group', () => {
      const log = new SecureAuditLog(tmpDir);
      const result = log.verifyIntegrity('empty-group');
      expect(result.valid).toBe(true);
      expect(result.totalEntries).toBe(0);
    });

    it('detects missing entries (gap in sequence)', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry());
      log.append(makeEntry());
      log.append(makeEntry());

      // Tamper: remove middle line
      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const lines = readLines(filePath);
      fs.writeFileSync(filePath, lines[0] + '\n' + lines[2] + '\n');

      const result = log.verifyIntegrity('test-group');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/gap|missing|sequence/i);
    });

    it('detects modified sequence numbers', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry());
      log.append(makeEntry());

      // Tamper: change seq of second entry
      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const lines = readLines(filePath);
      const tampered = JSON.parse(lines[1]!);
      tampered.seq = 5;
      fs.writeFileSync(filePath, lines[0] + '\n' + JSON.stringify(tampered) + '\n');

      const result = log.verifyIntegrity('test-group');
      expect(result.valid).toBe(false);
    });

    it('detects entries without sequence numbers', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry());

      // Tamper: append entry without seq
      const filePath = path.join(tmpDir, 'test-group.jsonl');
      fs.appendFileSync(filePath, JSON.stringify({ timestamp: 'now', group: 'test-group' }) + '\n');

      const result = log.verifyIntegrity('test-group');
      expect(result.valid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Credential scrubbing
  // -------------------------------------------------------------------------

  describe('credential scrubbing', () => {
    it('scrubs bearer tokens from error messages', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(
        makeEntry({
          outcome: 'error',
          error: {
            code: 'HANDLER_ERROR',
            message: 'Auth failed with Bearer ghp_ABC123DEF456GHI789JKL',
          },
        }),
      );

      const entries = readParsed(path.join(tmpDir, 'test-group.jsonl'));
      const error = entries[0]!['error'] as Record<string, string>;
      expect(error['message']).not.toContain('ghp_ABC123DEF456GHI789JKL');
      expect(error['message']).toContain('[REDACTED]');
    });

    it('scrubs API keys from rejection reasons', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(
        makeEntry({
          outcome: 'rejected',
          reason: 'Request with api_key=sk-1234567890abcdef was denied',
        }),
      );

      const entries = readParsed(path.join(tmpDir, 'test-group.jsonl'));
      expect(entries[0]!['reason']).not.toContain('sk-1234567890abcdef');
      expect(entries[0]!['reason']).toContain('[REDACTED]');
    });

    it('scrubs connection strings', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(
        makeEntry({
          outcome: 'error',
          error: {
            code: 'HANDLER_ERROR',
            message: 'Failed to connect: postgres://admin:secret@db.example.com/mydb',
          },
        }),
      );

      const entries = readParsed(path.join(tmpDir, 'test-group.jsonl'));
      const error = entries[0]!['error'] as Record<string, string>;
      expect(error['message']).not.toContain('admin:secret');
      expect(error['message']).toContain('[REDACTED]');
    });

    it('scrubs GitHub tokens from any string field', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(
        makeEntry({
          outcome: 'error',
          error: {
            code: 'HANDLER_ERROR',
            message: 'Token ghp_ABCDEFGHIJKLMNOP1234567890abcdef123456 expired',
          },
        }),
      );

      const entries = readParsed(path.join(tmpDir, 'test-group.jsonl'));
      const error = entries[0]!['error'] as Record<string, string>;
      expect(error['message']).not.toContain('ghp_');
    });

    it('scrubs private key blocks', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(
        makeEntry({
          outcome: 'error',
          error: {
            code: 'HANDLER_ERROR',
            message: 'Key: -----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg...',
          },
        }),
      );

      const entries = readParsed(path.join(tmpDir, 'test-group.jsonl'));
      const error = entries[0]!['error'] as Record<string, string>;
      expect(error['message']).not.toContain('BEGIN PRIVATE KEY');
    });

    it('preserves non-sensitive data unchanged', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(
        makeEntry({
          outcome: 'rejected',
          reason: 'Schema validation failed for field "name"',
        }),
      );

      const entries = readParsed(path.join(tmpDir, 'test-group.jsonl'));
      expect(entries[0]!['reason']).toBe('Schema validation failed for field "name"');
    });
  });

  // -------------------------------------------------------------------------
  // Append-only enforcement
  // -------------------------------------------------------------------------

  describe('append-only', () => {
    it('does not expose delete or modify methods', () => {
      const log = new SecureAuditLog(tmpDir);
      expect(log).not.toHaveProperty('delete');
      expect(log).not.toHaveProperty('modify');
      expect(log).not.toHaveProperty('clear');
      expect(log).not.toHaveProperty('truncate');
    });

    it('appending does not modify existing entries', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry({ correlation: 'first' }));

      const filePath = path.join(tmpDir, 'test-group.jsonl');
      const before = readLines(filePath)[0]!;

      log.append(makeEntry({ correlation: 'second' }));
      const after = readLines(filePath)[0]!;

      expect(after).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // Directory permissions
  // -------------------------------------------------------------------------

  describe('directory permissions', () => {
    it('sets restrictive permissions on base directory', () => {
      const auditDir = path.join(tmpDir, 'secure-audit');
      const _log = new SecureAuditLog(auditDir);

      const stats = fs.statSync(auditDir);
      // Check owner-only permissions (0o700 = rwx------)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o700);
    });
  });

  // -------------------------------------------------------------------------
  // Log rotation
  // -------------------------------------------------------------------------

  describe('rotate', () => {
    it('rotates a group log file to a timestamped archive', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry());
      log.append(makeEntry());

      const result = log.rotate('test-group');
      expect(result.rotated).toBe(true);
      expect(result.archivePath).toBeDefined();
      expect(fs.existsSync(result.archivePath!)).toBe(true);
    });

    it('creates a fresh empty log after rotation', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry());

      log.rotate('test-group');

      // Appending after rotation starts at seq 1 again? No — should continue.
      // Actually, rotation archives but the secure log tracks total seq.
      // After rotation, new entries start fresh but integrity check covers archive.
      const filePath = path.join(tmpDir, 'test-group.jsonl');
      // File should not exist or be empty after rotation
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        expect(content).toBe('');
      }
    });

    it('preserves all entries in the archive', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry({ correlation: 'a' }));
      log.append(makeEntry({ correlation: 'b' }));

      const result = log.rotate('test-group');
      const archived = readParsed(result.archivePath!);
      expect(archived).toHaveLength(2);
      expect(archived[0]!['correlation']).toBe('a');
      expect(archived[1]!['correlation']).toBe('b');
    });

    it('returns rotated=false when no log file exists', () => {
      const log = new SecureAuditLog(tmpDir);
      const result = log.rotate('empty-group');
      expect(result.rotated).toBe(false);
    });

    it('resets sequence after rotation', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry());
      log.append(makeEntry());

      log.rotate('test-group');

      log.append(makeEntry());
      const entries = readParsed(path.join(tmpDir, 'test-group.jsonl'));
      expect(entries[0]!['seq']).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Query passthrough
  // -------------------------------------------------------------------------

  describe('query methods', () => {
    it('getEntries returns all entries for a group', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry({ correlation: 'a' }));
      log.append(makeEntry({ correlation: 'b' }));

      const entries = log.getEntries('test-group');
      expect(entries).toHaveLength(2);
    });

    it('queryByCorrelation returns matching entries', () => {
      const log = new SecureAuditLog(tmpDir);
      log.append(makeEntry({ correlation: 'target' }));
      log.append(makeEntry({ correlation: 'other' }));

      const results = log.queryByCorrelation('target', 'test-group');
      expect(results).toHaveLength(1);
    });
  });
});
