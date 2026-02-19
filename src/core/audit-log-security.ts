/**
 * Secure audit log wrapper for Carapace.
 *
 * Adds security layers on top of the base AuditLog:
 * 1. Sequence numbers for tamper detection
 * 2. Credential scrubbing before write
 * 3. Integrity verification
 * 4. Restrictive directory permissions (0o700)
 * 5. Log rotation with archive preservation
 *
 * The API is append-only — no modify, delete, clear, or truncate
 * methods are exposed. Plugins interact via append() and queries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuditLog } from './audit-log.js';
import type { AuditEntry, AuditOutcome } from './audit-log.js';
import { ResponseSanitizer } from './response-sanitizer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of integrity verification. */
export interface IntegrityResult {
  valid: boolean;
  totalEntries: number;
  errors: string[];
}

/** Result of log rotation. */
export interface RotationResult {
  rotated: boolean;
  archivePath?: string;
}

// ---------------------------------------------------------------------------
// SecureAuditLog
// ---------------------------------------------------------------------------

export class SecureAuditLog {
  private readonly basePath: string;
  private readonly inner: AuditLog;
  private readonly sanitizer: ResponseSanitizer;
  private readonly sequences: Map<string, number> = new Map();

  constructor(basePath: string) {
    this.basePath = basePath;

    // Create directory with restrictive permissions
    fs.mkdirSync(basePath, { recursive: true, mode: 0o700 });
    // Ensure permissions even if directory already existed
    fs.chmodSync(basePath, 0o700);

    this.inner = new AuditLog(basePath);
    this.sanitizer = new ResponseSanitizer();

    // Initialize sequences from existing files
    this.initializeSequences();
  }

  // -------------------------------------------------------------------------
  // append()
  // -------------------------------------------------------------------------

  /**
   * Append an audit entry with sequence number and credential scrubbing.
   * The entry is scrubbed of credential patterns before writing.
   */
  append(entry: AuditEntry): void {
    // Scrub credentials from string fields
    const scrubbed = this.scrubEntry(entry);

    // Get next sequence number for this group
    const seq = this.nextSeq(scrubbed.group);

    // Write entry with sequence number directly (bypass inner.append to add seq)
    const filePath = path.join(this.basePath, `${scrubbed.group}.jsonl`);
    const serializable: Record<string, unknown> = {
      seq,
      timestamp: scrubbed.timestamp,
      group: scrubbed.group,
      source: scrubbed.source,
      topic: scrubbed.topic,
      correlation: scrubbed.correlation,
      stage: scrubbed.stage,
      outcome: scrubbed.outcome,
    };

    if (scrubbed.reason !== undefined) {
      serializable['reason'] = scrubbed.reason;
    }
    if (scrubbed.fieldPaths !== undefined) {
      serializable['fieldPaths'] = scrubbed.fieldPaths;
    }
    if (scrubbed.error !== undefined) {
      serializable['error'] = scrubbed.error;
    }
    if (scrubbed.phase !== undefined) {
      serializable['phase'] = scrubbed.phase;
    }

    const line = JSON.stringify(serializable) + '\n';
    fs.appendFileSync(filePath, line, 'utf-8');
  }

  // -------------------------------------------------------------------------
  // verifyIntegrity()
  // -------------------------------------------------------------------------

  /**
   * Verify the integrity of a group's audit log.
   * Checks that sequence numbers are contiguous starting from 1.
   */
  verifyIntegrity(group: string): IntegrityResult {
    const filePath = path.join(this.basePath, `${group}.jsonl`);
    if (!fs.existsSync(filePath)) {
      return { valid: true, totalEntries: 0, errors: [] };
    }

    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (content.length === 0) {
      return { valid: true, totalEntries: 0, errors: [] };
    }

    const lines = content.split('\n').filter((l) => l.length > 0);
    const errors: string[] = [];
    let expectedSeq = 1;

    for (let i = 0; i < lines.length; i++) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(lines[i]!) as Record<string, unknown>;
      } catch {
        errors.push(`Line ${i + 1}: invalid JSON`);
        continue;
      }

      const seq = parsed['seq'];
      if (seq === undefined || seq === null) {
        errors.push(`Line ${i + 1}: missing sequence number`);
        continue;
      }

      if (typeof seq !== 'number' || seq !== expectedSeq) {
        errors.push(
          `Line ${i + 1}: expected sequence ${expectedSeq}, found ${seq} (gap or modification detected)`,
        );
      }

      expectedSeq = (typeof seq === 'number' ? seq : expectedSeq) + 1;
    }

    return {
      valid: errors.length === 0,
      totalEntries: lines.length,
      errors,
    };
  }

  // -------------------------------------------------------------------------
  // rotate()
  // -------------------------------------------------------------------------

  /**
   * Rotate a group's log file to a timestamped archive.
   * Creates a fresh empty log file. Resets sequence counter.
   */
  rotate(group: string): RotationResult {
    const filePath = path.join(this.basePath, `${group}.jsonl`);
    if (!fs.existsSync(filePath)) {
      return { rotated: false };
    }

    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (content.length === 0) {
      return { rotated: false };
    }

    // Create archive filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(this.basePath, `${group}.${timestamp}.jsonl`);

    // Move current file to archive
    fs.renameSync(filePath, archivePath);

    // Create fresh empty file
    fs.writeFileSync(filePath, '', 'utf-8');

    // Reset sequence counter for this group
    this.sequences.set(group, 0);

    return { rotated: true, archivePath };
  }

  // -------------------------------------------------------------------------
  // Query passthroughs
  // -------------------------------------------------------------------------

  getEntries(group: string): AuditEntry[] {
    return this.inner.getEntries(group);
  }

  queryByCorrelation(correlationId: string, group: string): AuditEntry[] {
    return this.inner.queryByCorrelation(correlationId, group);
  }

  queryByTimeRange(start: string, end: string, group: string): AuditEntry[] {
    return this.inner.queryByTimeRange(start, end, group);
  }

  queryByTopic(topic: string, group: string): AuditEntry[] {
    return this.inner.queryByTopic(topic, group);
  }

  queryByOutcome(outcome: AuditOutcome, group: string): AuditEntry[] {
    return this.inner.queryByOutcome(outcome, group);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private initializeSequences(): void {
    // Scan existing JSONL files to resume sequence numbers
    if (!fs.existsSync(this.basePath)) return;

    const files = fs.readdirSync(this.basePath);
    for (const file of files) {
      if (!file.endsWith('.jsonl') || file.includes('.')) {
        // Only process primary log files (group.jsonl), not archives (group.timestamp.jsonl)
        // Check: count dots before .jsonl
        const name = file.replace('.jsonl', '');
        if (name.includes('.')) continue; // archive file
      }

      const group = file.replace('.jsonl', '');
      if (group.includes('.')) continue; // archive file

      const filePath = path.join(this.basePath, file);
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (content.length === 0) continue;

      const lines = content.split('\n').filter((l) => l.length > 0);
      if (lines.length === 0) continue;

      // Find the highest seq in the file
      let maxSeq = 0;
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const seq = parsed['seq'];
          if (typeof seq === 'number' && seq > maxSeq) {
            maxSeq = seq;
          }
        } catch {
          // Skip unparseable lines
        }
      }

      this.sequences.set(group, maxSeq);
    }
  }

  private nextSeq(group: string): number {
    const current = this.sequences.get(group) ?? 0;
    const next = current + 1;
    this.sequences.set(group, next);
    return next;
  }

  private scrubEntry(entry: AuditEntry): AuditEntry {
    const scrubbed: AuditEntry = { ...entry };

    // Scrub reason
    if (scrubbed.reason !== undefined) {
      scrubbed.reason = this.scrubString(scrubbed.reason);
    }

    // Scrub error messages
    if (scrubbed.error !== undefined) {
      scrubbed.error = {
        code: scrubbed.error.code,
        message: this.scrubString(scrubbed.error.message),
      };
    }

    return scrubbed;
  }

  private scrubString(value: string): string {
    const result = this.sanitizer.sanitize(value);
    return result.value as string;
  }
}
