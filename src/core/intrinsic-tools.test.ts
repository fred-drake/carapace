/**
 * Tests for core intrinsic tools.
 *
 * Three intrinsic tools: get_diagnostics, list_tools, get_session_info.
 * All are registered in the ToolCatalog and invoked through the standard
 * pipeline like any plugin tool.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ToolCatalog } from './tool-catalog.js';
import { SessionManager } from './session-manager.js';
import { AuditLog } from './audit-log.js';
import { registerIntrinsicTools, INTRINSIC_TOOL_NAMES } from './intrinsic-tools.js';
import { createRequestEnvelope } from '../testing/factories.js';
import type { PluginLoadResult } from './plugin-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestEnvelope(toolName: string, args: Record<string, unknown>) {
  return createRequestEnvelope({
    topic: `tool.invoke.${toolName}`,
    payload: { arguments: args },
    group: 'test-group',
    source: 'container-1',
    correlation: 'corr-test',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('intrinsic tools', () => {
  let catalog: ToolCatalog;
  let sessionManager: SessionManager;
  let auditLog: AuditLog;
  let tmpDir: string;

  beforeEach(() => {
    catalog = new ToolCatalog();
    sessionManager = new SessionManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carapace-test-'));
    auditLog = new AuditLog(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  describe('registerIntrinsicTools', () => {
    it('registers all three intrinsic tools in the catalog', () => {
      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      expect(catalog.has('get_diagnostics')).toBe(true);
      expect(catalog.has('list_tools')).toBe(true);
      expect(catalog.has('get_session_info')).toBe(true);
    });

    it('registers exactly the reserved intrinsic tool names', () => {
      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      for (const name of INTRINSIC_TOOL_NAMES) {
        expect(catalog.has(name)).toBe(true);
      }
    });

    it('sets risk_level to "low" for all intrinsic tools', () => {
      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      for (const name of INTRINSIC_TOOL_NAMES) {
        const entry = catalog.get(name);
        expect(entry!.tool.risk_level).toBe('low');
      }
    });

    it('sets additionalProperties: false on all argument schemas', () => {
      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      for (const name of INTRINSIC_TOOL_NAMES) {
        const entry = catalog.get(name);
        expect(entry!.tool.arguments_schema.additionalProperties).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // list_tools
  // -------------------------------------------------------------------------

  describe('list_tools', () => {
    it('returns intrinsic tools when no plugins are loaded', async () => {
      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      const entry = catalog.get('list_tools')!;
      const envelope = createTestEnvelope('list_tools', {});
      const result = await entry.handler(envelope);

      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
      const tools = result.tools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).toContain('get_diagnostics');
      expect(names).toContain('list_tools');
      expect(names).toContain('get_session_info');
    });

    it('includes plugin tools alongside intrinsic tools', async () => {
      // Register a "plugin" tool before intrinsics
      catalog.register(
        {
          name: 'create_reminder',
          description: 'Create a reminder',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: { title: { type: 'string' } },
          },
        },
        async () => ({}),
      );

      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      const entry = catalog.get('list_tools')!;
      const envelope = createTestEnvelope('list_tools', {});
      const result = await entry.handler(envelope);

      const tools = result.tools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).toContain('create_reminder');
      expect(names).toContain('list_tools');
    });

    it('returns tool name, description, and risk_level for each tool', async () => {
      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      const entry = catalog.get('list_tools')!;
      const envelope = createTestEnvelope('list_tools', {});
      const result = await entry.handler(envelope);

      const tools = result.tools as Array<Record<string, unknown>>;
      for (const tool of tools) {
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.risk_level).toBe('string');
      }
    });
  });

  // -------------------------------------------------------------------------
  // get_session_info
  // -------------------------------------------------------------------------

  describe('get_session_info', () => {
    it('returns group and session start time from session manager', async () => {
      const session = sessionManager.create({
        containerId: 'container-1',
        group: 'test-group',
        connectionIdentity: 'conn-1',
      });

      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      const entry = catalog.get('get_session_info')!;
      const envelope = createTestEnvelope('get_session_info', {});
      const result = await entry.handler(envelope);

      expect(result.group).toBe('test-group');
      expect(result.session_start).toBe(session.startedAt);
    });

    it('returns healthy plugins list', async () => {
      sessionManager.create({
        containerId: 'container-1',
        group: 'test-group',
        connectionIdentity: 'conn-1',
      });

      const pluginResults: PluginLoadResult[] = [
        {
          ok: true,
          pluginName: 'telegram',
          manifest: {
            description: 'Telegram',
            version: '1.0.0',
            app_compat: '>=0.1.0',
            author: { name: 'Test' },
            provides: { channels: [], tools: [] },
            subscribes: [],
          },
          handler: {
            initialize: async () => {},
            handleToolInvocation: async () => ({ ok: true, result: {} }),
            shutdown: async () => {},
          },
        },
        {
          ok: true,
          pluginName: 'email',
          manifest: {
            description: 'Email',
            version: '1.0.0',
            app_compat: '>=0.1.0',
            author: { name: 'Test' },
            provides: { channels: [], tools: [] },
            subscribes: [],
          },
          handler: {
            initialize: async () => {},
            handleToolInvocation: async () => ({ ok: true, result: {} }),
            shutdown: async () => {},
          },
        },
      ];

      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults,
      });

      const entry = catalog.get('get_session_info')!;
      const envelope = createTestEnvelope('get_session_info', {});
      const result = await entry.handler(envelope);

      const plugins = result.plugins as { healthy: string[]; failed: unknown[] };
      expect(plugins.healthy).toContain('telegram');
      expect(plugins.healthy).toContain('email');
      expect(plugins.failed).toEqual([]);
    });

    it('returns failed plugins with category', async () => {
      sessionManager.create({
        containerId: 'container-1',
        group: 'test-group',
        connectionIdentity: 'conn-1',
      });

      const pluginResults: PluginLoadResult[] = [
        {
          ok: false,
          pluginName: 'reminders',
          error: 'Connection refused',
          category: 'init_error',
        },
        {
          ok: false,
          pluginName: 'github-bugs',
          error: 'Invalid credentials',
          category: 'timeout',
        },
      ];

      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults,
      });

      const entry = catalog.get('get_session_info')!;
      const envelope = createTestEnvelope('get_session_info', {});
      const result = await entry.handler(envelope);

      const plugins = result.plugins as {
        healthy: string[];
        failed: Array<{ name: string; category: string }>;
      };
      expect(plugins.healthy).toEqual([]);
      expect(plugins.failed).toHaveLength(2);
      expect(plugins.failed).toContainEqual({
        name: 'reminders',
        category: 'INTERNAL_ERROR',
      });
      expect(plugins.failed).toContainEqual({
        name: 'github-bugs',
        category: 'INTERNAL_ERROR',
      });
    });

    it('maps init failure categories to closed enum', async () => {
      sessionManager.create({
        containerId: 'container-1',
        group: 'test-group',
        connectionIdentity: 'conn-1',
      });

      const pluginResults: PluginLoadResult[] = [
        { ok: false, pluginName: 'a', error: 'bad manifest', category: 'invalid_manifest' },
        { ok: false, pluginName: 'b', error: 'init failed', category: 'init_error' },
        { ok: false, pluginName: 'c', error: 'timed out', category: 'timeout' },
        { ok: false, pluginName: 'd', error: 'no handler', category: 'missing_handler' },
      ];

      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults,
      });

      const entry = catalog.get('get_session_info')!;
      const envelope = createTestEnvelope('get_session_info', {});
      const result = await entry.handler(envelope);

      const plugins = result.plugins as {
        failed: Array<{ name: string; category: string }>;
      };
      // All categories should be from the closed enum
      for (const failed of plugins.failed) {
        expect(['NETWORK_ERROR', 'AUTH_ERROR', 'CONFIG_ERROR', 'INTERNAL_ERROR']).toContain(
          failed.category,
        );
      }
    });

    it('returns error when session is not found', async () => {
      // Don't create a session for container-1
      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      const entry = catalog.get('get_session_info')!;
      const envelope = createTestEnvelope('get_session_info', {});
      const result = await entry.handler(envelope);

      expect(result.error).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // get_diagnostics
  // -------------------------------------------------------------------------

  describe('get_diagnostics', () => {
    it('returns audit entries for a given correlation ID (trace mode)', async () => {
      sessionManager.create({
        containerId: 'container-1',
        group: 'test-group',
        connectionIdentity: 'conn-1',
      });

      // Write some audit entries
      auditLog.append({
        timestamp: '2026-02-19T10:00:00Z',
        group: 'test-group',
        source: 'container-1',
        topic: 'tool.invoke.create_reminder',
        correlation: 'req-789',
        stage: 'construct',
        outcome: 'routed',
      });
      auditLog.append({
        timestamp: '2026-02-19T10:00:01Z',
        group: 'test-group',
        source: 'container-1',
        topic: 'tool.invoke.create_reminder',
        correlation: 'req-789',
        stage: 'handler',
        outcome: 'error',
        error: { code: 'PLUGIN_TIMEOUT', message: 'Handler timed out' },
      });

      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      const entry = catalog.get('get_diagnostics')!;
      const envelope = createTestEnvelope('get_diagnostics', {
        correlation: 'req-789',
      });
      const result = await entry.handler(envelope);

      expect(result.entries).toBeDefined();
      const entries = result.entries as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(2);
      expect(entries[0].correlation).toBe('req-789');
      expect(entries[1].correlation).toBe('req-789');
    });

    it('returns recent errors (last_n mode)', async () => {
      sessionManager.create({
        containerId: 'container-1',
        group: 'test-group',
        connectionIdentity: 'conn-1',
      });

      // Write mixed entries
      auditLog.append({
        timestamp: '2026-02-19T10:00:00Z',
        group: 'test-group',
        source: 'container-1',
        topic: 'tool.invoke.test',
        correlation: 'req-1',
        stage: 'handler',
        outcome: 'routed',
      });
      auditLog.append({
        timestamp: '2026-02-19T10:00:01Z',
        group: 'test-group',
        source: 'container-1',
        topic: 'tool.invoke.test',
        correlation: 'req-2',
        stage: 'handler',
        outcome: 'error',
        error: { code: 'PLUGIN_ERROR', message: 'Something broke' },
      });
      auditLog.append({
        timestamp: '2026-02-19T10:00:02Z',
        group: 'test-group',
        source: 'container-1',
        topic: 'tool.invoke.test',
        correlation: 'req-3',
        stage: 'handler',
        outcome: 'error',
        error: { code: 'PLUGIN_TIMEOUT', message: 'Handler timed out' },
      });

      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      const entry = catalog.get('get_diagnostics')!;
      const envelope = createTestEnvelope('get_diagnostics', {
        last_n: 5,
        filter_outcome: 'error',
      });
      const result = await entry.handler(envelope);

      const entries = result.entries as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(2);
      // All should be errors
      for (const e of entries) {
        expect(e.outcome).toBe('error');
      }
    });

    it('limits results to the requested last_n', async () => {
      sessionManager.create({
        containerId: 'container-1',
        group: 'test-group',
        connectionIdentity: 'conn-1',
      });

      for (let i = 0; i < 10; i++) {
        auditLog.append({
          timestamp: `2026-02-19T10:00:${String(i).padStart(2, '0')}Z`,
          group: 'test-group',
          source: 'container-1',
          topic: 'tool.invoke.test',
          correlation: `req-${i}`,
          stage: 'handler',
          outcome: 'error',
          error: { code: 'PLUGIN_ERROR', message: `Error ${i}` },
        });
      }

      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      const entry = catalog.get('get_diagnostics')!;
      const envelope = createTestEnvelope('get_diagnostics', {
        last_n: 3,
        filter_outcome: 'error',
      });
      const result = await entry.handler(envelope);

      const entries = result.entries as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(3);
    });

    it('filters by group — does not return other group entries', async () => {
      sessionManager.create({
        containerId: 'container-1',
        group: 'test-group',
        connectionIdentity: 'conn-1',
      });

      // Entry for a different group
      auditLog.append({
        timestamp: '2026-02-19T10:00:00Z',
        group: 'other-group',
        source: 'container-2',
        topic: 'tool.invoke.test',
        correlation: 'req-other',
        stage: 'handler',
        outcome: 'error',
        error: { code: 'PLUGIN_ERROR', message: 'Other group error' },
      });

      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      const entry = catalog.get('get_diagnostics')!;
      const envelope = createTestEnvelope('get_diagnostics', {
        correlation: 'req-other',
      });
      const result = await entry.handler(envelope);

      const entries = result.entries as Array<Record<string, unknown>>;
      // Should not find the entry because it's in a different group
      expect(entries).toHaveLength(0);
    });

    it('returns empty entries when no audit data matches', async () => {
      sessionManager.create({
        containerId: 'container-1',
        group: 'test-group',
        connectionIdentity: 'conn-1',
      });

      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      const entry = catalog.get('get_diagnostics')!;
      const envelope = createTestEnvelope('get_diagnostics', {
        correlation: 'nonexistent',
      });
      const result = await entry.handler(envelope);

      const entries = result.entries as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(0);
    });

    it('returns error when session is not found', async () => {
      registerIntrinsicTools({
        catalog,
        sessionManager,
        auditLog,
        pluginResults: [],
      });

      const entry = catalog.get('get_diagnostics')!;
      const envelope = createTestEnvelope('get_diagnostics', {
        correlation: 'req-1',
      });
      const result = await entry.handler(envelope);

      expect(result.error).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // INTRINSIC_TOOL_NAMES constant
  // -------------------------------------------------------------------------

  describe('INTRINSIC_TOOL_NAMES', () => {
    it('contains exactly the three reserved names', () => {
      expect(INTRINSIC_TOOL_NAMES).toEqual(['get_diagnostics', 'list_tools', 'get_session_info']);
    });
  });
});
