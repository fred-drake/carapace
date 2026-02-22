/**
 * Core services implementation for Carapace.
 *
 * Provides the {@link CoreServices} interface to plugin handlers with
 * automatic group-scoping via {@link AsyncLocalStorage}. The router sets
 * the request context before dispatching to handlers; all service methods
 * read the current group from that context.
 *
 * - `getAuditLog()` never returns entries from other groups.
 * - `getSessionInfo()` returns the session for the current request.
 * - `getToolCatalog()` returns all registered tools (not group-scoped).
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  CoreServices,
  ChannelServices,
  AuditLogFilter,
  AuditLogEntry,
  SessionInfo,
} from './plugin-handler.js';
import type { AuditLog, AuditEntry, AuditOutcome } from './audit-log.js';
import type { ToolCatalog } from './tool-catalog.js';
import type { ToolDeclaration } from '../types/manifest.js';
import type { EventBus } from './event-bus.js';
import { PROTOCOL_VERSION } from '../types/protocol.js';
import type { EventEnvelope } from '../types/protocol.js';

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

/**
 * Per-request context stored in {@link AsyncLocalStorage}.
 * Set by the router before dispatching to plugin handlers.
 */
export interface RequestContext {
  group: string;
  sessionId: string;
  startedAt: string;
}

/**
 * AsyncLocalStorage instance for request context propagation.
 * The router calls `requestStorage.run(ctx, callback)` to establish
 * context for the duration of a request.
 */
export const requestStorage = new AsyncLocalStorage<RequestContext>();

// ---------------------------------------------------------------------------
// Outcome mapping
// ---------------------------------------------------------------------------

/**
 * Map internal audit outcomes to the simplified success/error model
 * exposed to plugin handlers.
 *
 * - `routed`, `sanitized` → `success` (message was processed)
 * - `rejected`, `error` → `error` (message was not processed)
 */
function mapOutcome(outcome: AuditOutcome): 'success' | 'error' {
  switch (outcome) {
    case 'routed':
    case 'sanitized':
      return 'success';
    case 'rejected':
    case 'error':
      return 'error';
  }
}

/**
 * Map an internal {@link AuditEntry} to the public {@link AuditLogEntry}
 * format returned to plugin handlers.
 */
function mapEntry(entry: AuditEntry, index: number): AuditLogEntry {
  const detail: Record<string, unknown> = {
    stage: entry.stage,
    source: entry.source,
  };

  if (entry.reason !== undefined) {
    detail.reason = entry.reason;
  }
  if (entry.fieldPaths !== undefined) {
    detail.fieldPaths = entry.fieldPaths;
  }
  if (entry.error !== undefined) {
    detail.error = entry.error;
  }
  if (entry.phase !== undefined) {
    detail.phase = entry.phase;
  }

  return {
    id: `${entry.timestamp}-${index}`,
    timestamp: entry.timestamp,
    topic: entry.topic,
    correlation: entry.correlation ?? '',
    outcome: mapOutcome(entry.outcome),
    detail,
  };
}

// ---------------------------------------------------------------------------
// CoreServicesImpl
// ---------------------------------------------------------------------------

export class CoreServicesImpl implements CoreServices {
  private readonly auditLog: AuditLog;
  private readonly toolCatalog: ToolCatalog;
  private readonly credentialReader: ((key: string) => string) | undefined;

  constructor(
    auditLog: AuditLog,
    toolCatalog: ToolCatalog,
    credentialReader?: (key: string) => string,
  ) {
    this.auditLog = auditLog;
    this.toolCatalog = toolCatalog;
    this.credentialReader = credentialReader;
  }

  async getAuditLog(filters: AuditLogFilter): Promise<AuditLogEntry[]> {
    const ctx = this.requireContext();

    // Always read from the current group — never cross-group.
    const raw = this.auditLog.getEntries(ctx.group);
    let mapped = raw.map(mapEntry);

    if (filters.correlation !== undefined) {
      mapped = mapped.filter((e) => e.correlation === filters.correlation);
    }

    if (filters.topic !== undefined) {
      mapped = mapped.filter((e) => e.topic === filters.topic);
    }

    if (filters.outcome !== undefined) {
      mapped = mapped.filter((e) => e.outcome === filters.outcome);
    }

    if (filters.since !== undefined) {
      mapped = mapped.filter((e) => e.timestamp >= filters.since!);
    }

    if (filters.until !== undefined) {
      mapped = mapped.filter((e) => e.timestamp <= filters.until!);
    }

    if (filters.last_n !== undefined) {
      mapped = mapped.slice(-filters.last_n);
    }

    return mapped;
  }

  getToolCatalog(): ToolDeclaration[] {
    return this.toolCatalog.list();
  }

  getSessionInfo(): SessionInfo {
    const ctx = this.requireContext();
    return {
      group: ctx.group,
      sessionId: ctx.sessionId,
      startedAt: ctx.startedAt,
    };
  }

  readCredential(key: string): string {
    if (!this.credentialReader) {
      throw new Error('readCredential is not available: no credential reader configured');
    }
    return this.credentialReader(key);
  }

  private requireContext(): RequestContext {
    const ctx = requestStorage.getStore();
    if (!ctx) {
      throw new Error('CoreServices accessed outside of a request context');
    }
    return ctx;
  }
}

// ---------------------------------------------------------------------------
// ChannelServicesImpl
// ---------------------------------------------------------------------------

export class ChannelServicesImpl extends CoreServicesImpl implements ChannelServices {
  private readonly eventBus: EventBus;

  constructor(auditLog: AuditLog, toolCatalog: ToolCatalog, eventBus: EventBus) {
    super(auditLog, toolCatalog);
    this.eventBus = eventBus;
  }

  async publishEvent(partial: {
    topic: string;
    source: string;
    group: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const envelope: EventEnvelope = {
      id: randomUUID(),
      version: PROTOCOL_VERSION,
      type: 'event',
      topic: partial.topic,
      source: partial.source,
      correlation: null,
      timestamp: new Date().toISOString(),
      group: partial.group,
      payload: partial.payload,
    };
    await this.eventBus.publish(envelope);
  }
}
