import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CoreServicesImpl, requestStorage } from './core-services.js';
import { AuditLog } from './audit-log.js';
import { ToolCatalog } from './tool-catalog.js';
import type { CoreServices, SessionInfo } from './plugin-handler.js';
import type { AuditEntry } from './audit-log.js';
import type { ToolDeclaration } from '../types/manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carapace-core-services-'));
}

function makeEntry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    group: 'test-group',
    source: 'container-1',
    topic: 'email.send',
    correlation: 'corr-1',
    stage: 'route',
    outcome: 'routed',
    ...overrides,
  };
}

function makeTool(name: string): ToolDeclaration {
  return {
    name,
    description: `Tool ${name}`,
    risk_level: 'low' as const,
    arguments_schema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false as const,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoreServicesImpl', () => {
  let tmpDir: string;
  let auditLog: AuditLog;
  let toolCatalog: ToolCatalog;
  let services: CoreServicesImpl;

  beforeEach(() => {
    tmpDir = createTempDir();
    auditLog = new AuditLog(tmpDir);
    toolCatalog = new ToolCatalog();
    services = new CoreServicesImpl(auditLog, toolCatalog);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Type compatibility
  // -----------------------------------------------------------------------

  it('implements the CoreServices interface', () => {
    // Verified inside a request context.
    requestStorage.run({ group: 'g', sessionId: 's', startedAt: new Date().toISOString() }, () => {
      const _svc: CoreServices = services;
      expect(_svc).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Context enforcement
  // -----------------------------------------------------------------------

  describe('context enforcement', () => {
    it('getSessionInfo throws outside of a request context', () => {
      expect(() => services.getSessionInfo()).toThrow(/outside.*request context/i);
    });

    it('getAuditLog throws outside of a request context', async () => {
      await expect(services.getAuditLog({})).rejects.toThrow(/outside.*request context/i);
    });

    it('getToolCatalog works without a request context', () => {
      // Tool catalog is not group-scoped — available anytime.
      expect(services.getToolCatalog()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getSessionInfo
  // -----------------------------------------------------------------------

  describe('getSessionInfo', () => {
    it('returns session info from the current request context', () => {
      const ctx = {
        group: 'email',
        sessionId: 'sess-123',
        startedAt: '2026-01-15T10:00:00.000Z',
      };

      requestStorage.run(ctx, () => {
        const info: SessionInfo = services.getSessionInfo();
        expect(info.group).toBe('email');
        expect(info.sessionId).toBe('sess-123');
        expect(info.startedAt).toBe('2026-01-15T10:00:00.000Z');
      });
    });

    it('returns different info for different contexts', () => {
      requestStorage.run(
        { group: 'email', sessionId: 's1', startedAt: '2026-01-01T00:00:00Z' },
        () => {
          expect(services.getSessionInfo().group).toBe('email');
        },
      );

      requestStorage.run(
        { group: 'slack', sessionId: 's2', startedAt: '2026-01-02T00:00:00Z' },
        () => {
          expect(services.getSessionInfo().group).toBe('slack');
        },
      );
    });
  });

  // -----------------------------------------------------------------------
  // getToolCatalog
  // -----------------------------------------------------------------------

  describe('getToolCatalog', () => {
    it('returns an empty list when no tools are registered', () => {
      expect(services.getToolCatalog()).toEqual([]);
    });

    it('returns all registered tools', () => {
      const handler = async () => ({});
      toolCatalog.register(makeTool('email.send'), handler);
      toolCatalog.register(makeTool('email.read'), handler);

      const tools = services.getToolCatalog();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name).sort()).toEqual(['email.read', 'email.send']);
    });
  });

  // -----------------------------------------------------------------------
  // getAuditLog — group scoping
  // -----------------------------------------------------------------------

  describe('getAuditLog — group scoping', () => {
    it('returns only entries from the current group', async () => {
      // Write entries for two groups.
      auditLog.append(makeEntry({ group: 'email', topic: 'email.send', correlation: 'c1' }));
      auditLog.append(makeEntry({ group: 'email', topic: 'email.read', correlation: 'c2' }));
      auditLog.append(makeEntry({ group: 'slack', topic: 'slack.post', correlation: 'c3' }));

      const result = await requestStorage.run(
        { group: 'email', sessionId: 's1', startedAt: '2026-01-01T00:00:00Z' },
        () => services.getAuditLog({}),
      );

      expect(result).toHaveLength(2);
      expect(result.every((e) => e.topic.startsWith('email.'))).toBe(true);
    });

    it('never returns cross-group entries', async () => {
      auditLog.append(makeEntry({ group: 'email', correlation: 'shared-corr' }));
      auditLog.append(makeEntry({ group: 'slack', correlation: 'shared-corr' }));

      const result = await requestStorage.run(
        { group: 'slack', sessionId: 's2', startedAt: '2026-01-01T00:00:00Z' },
        () => services.getAuditLog({ correlation: 'shared-corr' }),
      );

      // Should only return the slack entry, not the email one.
      expect(result).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // getAuditLog — filters
  // -----------------------------------------------------------------------

  describe('getAuditLog — filters', () => {
    const group = 'test-group';
    const ctx = { group, sessionId: 's1', startedAt: '2026-01-01T00:00:00Z' };

    it('filters by correlation', async () => {
      auditLog.append(makeEntry({ group, correlation: 'corr-a' }));
      auditLog.append(makeEntry({ group, correlation: 'corr-b' }));

      const result = await requestStorage.run(ctx, () =>
        services.getAuditLog({ correlation: 'corr-a' }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].correlation).toBe('corr-a');
    });

    it('filters by topic', async () => {
      auditLog.append(makeEntry({ group, topic: 'email.send' }));
      auditLog.append(makeEntry({ group, topic: 'email.read' }));

      const result = await requestStorage.run(ctx, () =>
        services.getAuditLog({ topic: 'email.send' }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].topic).toBe('email.send');
    });

    it('filters by outcome (success maps to routed/sanitized)', async () => {
      auditLog.append(makeEntry({ group, outcome: 'routed', correlation: 'c1' }));
      auditLog.append(makeEntry({ group, outcome: 'sanitized', correlation: 'c2' }));
      auditLog.append(makeEntry({ group, outcome: 'error', correlation: 'c3' }));
      auditLog.append(makeEntry({ group, outcome: 'rejected', correlation: 'c4' }));

      const successResult = await requestStorage.run(ctx, () =>
        services.getAuditLog({ outcome: 'success' }),
      );
      expect(successResult).toHaveLength(2);

      const errorResult = await requestStorage.run(ctx, () =>
        services.getAuditLog({ outcome: 'error' }),
      );
      expect(errorResult).toHaveLength(2);
    });

    it('filters by time range (since)', async () => {
      auditLog.append(makeEntry({ group, timestamp: '2026-01-10T00:00:00Z', correlation: 'c1' }));
      auditLog.append(makeEntry({ group, timestamp: '2026-01-20T00:00:00Z', correlation: 'c2' }));

      const result = await requestStorage.run(ctx, () =>
        services.getAuditLog({ since: '2026-01-15T00:00:00Z' }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].correlation).toBe('c2');
    });

    it('filters by time range (until)', async () => {
      auditLog.append(makeEntry({ group, timestamp: '2026-01-10T00:00:00Z', correlation: 'c1' }));
      auditLog.append(makeEntry({ group, timestamp: '2026-01-20T00:00:00Z', correlation: 'c2' }));

      const result = await requestStorage.run(ctx, () =>
        services.getAuditLog({ until: '2026-01-15T00:00:00Z' }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].correlation).toBe('c1');
    });

    it('applies last_n to return only the most recent entries', async () => {
      auditLog.append(makeEntry({ group, correlation: 'c1' }));
      auditLog.append(makeEntry({ group, correlation: 'c2' }));
      auditLog.append(makeEntry({ group, correlation: 'c3' }));

      const result = await requestStorage.run(ctx, () => services.getAuditLog({ last_n: 2 }));
      expect(result).toHaveLength(2);
      expect(result[0].correlation).toBe('c2');
      expect(result[1].correlation).toBe('c3');
    });

    it('combines multiple filters', async () => {
      auditLog.append(
        makeEntry({
          group,
          topic: 'email.send',
          outcome: 'routed',
          correlation: 'c1',
          timestamp: '2026-01-10T00:00:00Z',
        }),
      );
      auditLog.append(
        makeEntry({
          group,
          topic: 'email.send',
          outcome: 'error',
          correlation: 'c2',
          timestamp: '2026-01-20T00:00:00Z',
        }),
      );
      auditLog.append(
        makeEntry({
          group,
          topic: 'email.read',
          outcome: 'routed',
          correlation: 'c3',
          timestamp: '2026-01-20T00:00:00Z',
        }),
      );

      const result = await requestStorage.run(ctx, () =>
        services.getAuditLog({
          topic: 'email.send',
          outcome: 'success',
          since: '2026-01-05T00:00:00Z',
        }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].correlation).toBe('c1');
    });

    it('returns empty array when no entries match', async () => {
      const result = await requestStorage.run(ctx, () =>
        services.getAuditLog({ correlation: 'nonexistent' }),
      );
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getAuditLog — entry mapping
  // -----------------------------------------------------------------------

  describe('getAuditLog — entry mapping', () => {
    const group = 'test-group';
    const ctx = { group, sessionId: 's1', startedAt: '2026-01-01T00:00:00Z' };

    it('maps AuditEntry fields to AuditLogEntry', async () => {
      auditLog.append(
        makeEntry({
          group,
          timestamp: '2026-01-15T10:00:00Z',
          topic: 'email.send',
          correlation: 'corr-1',
          outcome: 'routed',
          stage: 'route',
          source: 'container-1',
        }),
      );

      const result = await requestStorage.run(ctx, () => services.getAuditLog({}));

      expect(result).toHaveLength(1);
      const entry = result[0];
      expect(entry.timestamp).toBe('2026-01-15T10:00:00Z');
      expect(entry.topic).toBe('email.send');
      expect(entry.correlation).toBe('corr-1');
      expect(entry.outcome).toBe('success');
      expect(entry.id).toBeDefined();
      expect(entry.detail).toBeDefined();
      expect(entry.detail.stage).toBe('route');
      expect(entry.detail.source).toBe('container-1');
    });

    it('maps "routed" and "sanitized" outcomes to "success"', async () => {
      auditLog.append(makeEntry({ group, outcome: 'routed', correlation: 'c1' }));
      auditLog.append(makeEntry({ group, outcome: 'sanitized', correlation: 'c2' }));

      const result = await requestStorage.run(ctx, () => services.getAuditLog({}));
      expect(result.every((e) => e.outcome === 'success')).toBe(true);
    });

    it('maps "rejected" and "error" outcomes to "error"', async () => {
      auditLog.append(makeEntry({ group, outcome: 'rejected', correlation: 'c1' }));
      auditLog.append(makeEntry({ group, outcome: 'error', correlation: 'c2' }));

      const result = await requestStorage.run(ctx, () => services.getAuditLog({}));
      expect(result.every((e) => e.outcome === 'error')).toBe(true);
    });

    it('includes error details in the detail field', async () => {
      auditLog.append(
        makeEntry({
          group,
          outcome: 'error',
          error: { code: 'HANDLER_ERROR', message: 'something broke' },
          phase: 'before_normalization',
          correlation: 'c1',
        }),
      );

      const result = await requestStorage.run(ctx, () => services.getAuditLog({}));
      expect(result[0].detail.error).toEqual({
        code: 'HANDLER_ERROR',
        message: 'something broke',
      });
      expect(result[0].detail.phase).toBe('before_normalization');
    });

    it('includes rejection reason in the detail field', async () => {
      auditLog.append(
        makeEntry({
          group,
          outcome: 'rejected',
          reason: 'Invalid topic',
          correlation: 'c1',
        }),
      );

      const result = await requestStorage.run(ctx, () => services.getAuditLog({}));
      expect(result[0].detail.reason).toBe('Invalid topic');
    });

    it('includes sanitization field paths in the detail field', async () => {
      auditLog.append(
        makeEntry({
          group,
          outcome: 'sanitized',
          fieldPaths: ['$.password', '$.token'],
          correlation: 'c1',
        }),
      );

      const result = await requestStorage.run(ctx, () => services.getAuditLog({}));
      expect(result[0].detail.fieldPaths).toEqual(['$.password', '$.token']);
    });

    it('handles null correlation in entries', async () => {
      auditLog.append(makeEntry({ group, correlation: null }));

      const result = await requestStorage.run(ctx, () => services.getAuditLog({}));
      expect(result).toHaveLength(1);
      expect(result[0].correlation).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // AsyncLocalStorage isolation
  // -----------------------------------------------------------------------

  describe('AsyncLocalStorage isolation', () => {
    it('concurrent contexts see their own group', async () => {
      auditLog.append(makeEntry({ group: 'email', topic: 'email.send', correlation: 'c1' }));
      auditLog.append(makeEntry({ group: 'slack', topic: 'slack.post', correlation: 'c2' }));

      const [emailResult, slackResult] = await Promise.all([
        requestStorage.run(
          { group: 'email', sessionId: 's1', startedAt: '2026-01-01T00:00:00Z' },
          () => services.getAuditLog({}),
        ),
        requestStorage.run(
          { group: 'slack', sessionId: 's2', startedAt: '2026-01-01T00:00:00Z' },
          () => services.getAuditLog({}),
        ),
      ]);

      expect(emailResult).toHaveLength(1);
      expect(emailResult[0].topic).toBe('email.send');

      expect(slackResult).toHaveLength(1);
      expect(slackResult[0].topic).toBe('slack.post');
    });
  });
});
