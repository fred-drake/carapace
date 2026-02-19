/**
 * Audit log subsystem for Carapace.
 *
 * Writes structured JSON Lines (one JSON object per line) to
 * `{basePath}/{group}.jsonl`. Append-only — no mutations of
 * existing entries. Queryable by correlation ID, time range,
 * topic, and outcome.
 *
 * Handler errors produce TWO entries (before and after normalization),
 * linked by correlation ID.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of a pipeline processing step. */
export type AuditOutcome = 'routed' | 'rejected' | 'sanitized' | 'error';

/** Phase for dual-entry handler error logging. */
export type AuditPhase = 'before_normalization' | 'after_normalization';

/** Structured error info logged with error entries. */
export interface AuditErrorInfo {
  code: string;
  message: string;
}

/** A single audit log entry. */
export interface AuditEntry {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Session group. */
  group: string;
  /** Message source. */
  source: string;
  /** Message topic. */
  topic: string;
  /** Correlation ID (null for events without correlation). */
  correlation: string | null;
  /** Pipeline stage name. */
  stage: string;
  /** Processing outcome. */
  outcome: AuditOutcome;
  /** Rejection reason (only for outcome: 'rejected'). */
  reason?: string;
  /** Field paths affected by sanitization (only for outcome: 'sanitized'). */
  fieldPaths?: string[];
  /** Error details (only for outcome: 'error'). */
  error?: AuditErrorInfo;
  /** Normalization phase (only for dual-entry error logging). */
  phase?: AuditPhase;
}

// ---------------------------------------------------------------------------
// AuditLog
// ---------------------------------------------------------------------------

export class AuditLog {
  private readonly basePath: string;

  constructor(basePath: string = 'data/audit') {
    this.basePath = basePath;
    fs.mkdirSync(this.basePath, { recursive: true });
  }

  /**
   * Append an audit entry to the group's JSONL file.
   * Only serialises fields that are present (no undefined values).
   */
  append(entry: AuditEntry): void {
    const filePath = this.groupFilePath(entry.group);
    const serialisable: Record<string, unknown> = {
      timestamp: entry.timestamp,
      group: entry.group,
      source: entry.source,
      topic: entry.topic,
      correlation: entry.correlation,
      stage: entry.stage,
      outcome: entry.outcome,
    };

    if (entry.reason !== undefined) {
      serialisable.reason = entry.reason;
    }
    if (entry.fieldPaths !== undefined) {
      serialisable.fieldPaths = entry.fieldPaths;
    }
    if (entry.error !== undefined) {
      serialisable.error = entry.error;
    }
    if (entry.phase !== undefined) {
      serialisable.phase = entry.phase;
    }

    const line = JSON.stringify(serialisable) + '\n';
    fs.appendFileSync(filePath, line, 'utf-8');
  }

  /**
   * Query entries by correlation ID within a specific group.
   */
  queryByCorrelation(correlationId: string, group: string): AuditEntry[] {
    return this.readGroup(group).filter((e) => e.correlation === correlationId);
  }

  /**
   * Query entries within a time range (inclusive) for a specific group.
   */
  queryByTimeRange(start: string, end: string, group: string): AuditEntry[] {
    return this.readGroup(group).filter((e) => {
      return e.timestamp >= start && e.timestamp <= end;
    });
  }

  /**
   * Query entries by topic within a specific group.
   */
  queryByTopic(topic: string, group: string): AuditEntry[] {
    return this.readGroup(group).filter((e) => e.topic === topic);
  }

  /**
   * Query entries by outcome within a specific group.
   */
  queryByOutcome(outcome: AuditOutcome, group: string): AuditEntry[] {
    return this.readGroup(group).filter((e) => e.outcome === outcome);
  }

  /**
   * Read all entries for a group. Returns an empty array if no entries exist.
   */
  getEntries(group: string): AuditEntry[] {
    return this.readGroup(group);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private groupFilePath(group: string): string {
    return path.join(this.basePath, `${group}.jsonl`);
  }

  /**
   * Read and parse all entries from a group's JSONL file.
   * Returns an empty array if the file does not exist.
   */
  private readGroup(group: string): AuditEntry[] {
    const filePath = this.groupFilePath(group);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AuditEntry);
  }
}
