import { describe, it, expect } from 'vitest';
import { MessageRouter } from './router.js';
import { ToolCatalog } from './tool-catalog.js';
import type { ToolHandler } from './tool-catalog.js';
import { ErrorCode, PROTOCOL_VERSION } from '../types/index.js';
import { createWireMessage, createToolDeclaration } from '../testing/factories.js';
import type {
  SessionContext,
  PipelineStage,
  PipelineContext,
  PipelineResult,
} from './pipeline/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides?: Partial<SessionContext>): SessionContext {
  return {
    sessionId: 'sess-001',
    group: 'test-group',
    source: 'agent-test',
    startedAt: '2026-02-18T10:00:00Z',
    ...overrides,
  };
}

function setupCatalog(toolName: string, handler: ToolHandler): ToolCatalog {
  const catalog = new ToolCatalog();
  const tool = createToolDeclaration({
    name: toolName,
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string' },
      },
    },
  });
  catalog.register(tool, handler);
  return catalog;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageRouter', () => {
  describe('valid message flow', () => {
    it('flows through all 6 stages and returns a response', async () => {
      const handler: ToolHandler = async (envelope) => ({
        reminder_id: '42',
        title: (envelope.payload.arguments as Record<string, unknown>).input,
      });
      const catalog = setupCatalog('test_tool', handler);
      const router = new MessageRouter(catalog);

      const wire = createWireMessage({
        topic: 'tool.invoke.test_tool',
        correlation: 'corr-abc',
        arguments: { input: 'buy milk' },
      });
      const session = makeSession();

      const response = await router.processRequest(wire, session);

      expect(response.type).toBe('response');
      expect(response.version).toBe(PROTOCOL_VERSION);
      expect(response.correlation).toBe('corr-abc');
      expect(response.payload.error).toBeNull();
      expect(response.payload.result).toEqual({
        reminder_id: '42',
        title: 'buy milk',
      });
    });
  });

  describe('unknown tool', () => {
    it('returns UNKNOWN_TOOL error response', async () => {
      const catalog = new ToolCatalog();
      const router = new MessageRouter(catalog);

      const wire = createWireMessage({
        topic: 'tool.invoke.nonexistent_tool',
        correlation: 'corr-xyz',
      });

      const response = await router.processRequest(wire, makeSession());

      expect(response.type).toBe('response');
      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.UNKNOWN_TOOL);
      expect(response.payload.result).toBeNull();
    });
  });

  describe('invalid arguments', () => {
    it('returns VALIDATION_FAILED error response', async () => {
      const handler: ToolHandler = async () => ({ ok: true });
      const catalog = setupCatalog('test_tool', handler);
      const router = new MessageRouter(catalog);

      const wire = createWireMessage({
        topic: 'tool.invoke.test_tool',
        correlation: 'corr-val',
        arguments: { input: 12345 }, // wrong type — should be string
      });

      const response = await router.processRequest(wire, makeSession());

      expect(response.type).toBe('response');
      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(response.payload.result).toBeNull();
    });
  });

  describe('malformed input', () => {
    it('does not crash on empty topic', async () => {
      const catalog = new ToolCatalog();
      const router = new MessageRouter(catalog);

      const wire = createWireMessage({
        topic: '',
        correlation: 'corr-empty',
      });

      const response = await router.processRequest(wire, makeSession());

      expect(response.type).toBe('response');
      expect(response.payload.error).not.toBeNull();
    });

    it('does not crash on malformed topic', async () => {
      const catalog = new ToolCatalog();
      const router = new MessageRouter(catalog);

      const wire = createWireMessage({
        topic: 'not-a-valid-topic',
        correlation: 'corr-bad',
      });

      const response = await router.processRequest(wire, makeSession());

      expect(response.type).toBe('response');
      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.UNKNOWN_TOOL);
    });
  });

  describe('correlation ID', () => {
    it('error responses include correct correlation ID from wire message', async () => {
      const catalog = new ToolCatalog();
      const router = new MessageRouter(catalog);

      const wire = createWireMessage({
        topic: 'tool.invoke.missing',
        correlation: 'unique-corr-999',
      });

      const response = await router.processRequest(wire, makeSession());

      expect(response.correlation).toBe('unique-corr-999');
    });

    it('success responses include correct correlation ID from wire message', async () => {
      const handler: ToolHandler = async () => ({ done: true });
      const catalog = setupCatalog('test_tool', handler);
      const router = new MessageRouter(catalog);

      const wire = createWireMessage({
        topic: 'tool.invoke.test_tool',
        correlation: 'success-corr-42',
        arguments: { input: 'test' },
      });

      const response = await router.processRequest(wire, makeSession());

      expect(response.correlation).toBe('success-corr-42');
    });
  });

  describe('handler exception', () => {
    it('returns PLUGIN_ERROR response when handler throws', async () => {
      const handler: ToolHandler = async () => {
        throw new Error('Database connection failed');
      };
      const catalog = setupCatalog('test_tool', handler);
      const router = new MessageRouter(catalog);

      const wire = createWireMessage({
        topic: 'tool.invoke.test_tool',
        correlation: 'corr-err',
        arguments: { input: 'test' },
      });

      const response = await router.processRequest(wire, makeSession());

      expect(response.type).toBe('response');
      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.PLUGIN_ERROR);
      expect(response.payload.error!.message).toContain('Database connection failed');
      expect(response.correlation).toBe('corr-err');
    });

    it('handles non-Error throws gracefully', async () => {
      const handler: ToolHandler = async () => {
        throw 'string error';
      };
      const catalog = setupCatalog('test_tool', handler);
      const router = new MessageRouter(catalog);

      const wire = createWireMessage({
        topic: 'tool.invoke.test_tool',
        correlation: 'corr-str',
        arguments: { input: 'test' },
      });

      const response = await router.processRequest(wire, makeSession());

      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.PLUGIN_ERROR);
      expect(response.payload.error!.message).toContain('string error');
    });
  });

  describe('handler not found', () => {
    it('returns PLUGIN_UNAVAILABLE when tool has no handler', async () => {
      const catalog = new ToolCatalog();
      const tool = createToolDeclaration({
        name: 'orphan_tool',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      });
      // Register tool with a handler, then remove handler from catalog entry
      // by re-setting the internal entry. We need the tool in the catalog for
      // stage 2 to pass, but with no handler for stage 6 to fail.
      catalog.register(tool, async () => ({ ok: true }));
      // Access internals to null out the handler
      const entry = catalog.get('orphan_tool') as { tool: typeof tool; handler: unknown };
      entry.handler = undefined;

      const router = new MessageRouter(catalog);
      const wire = createWireMessage({
        topic: 'tool.invoke.orphan_tool',
        correlation: 'corr-orphan',
        arguments: {},
      });

      const response = await router.processRequest(wire, makeSession());

      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.PLUGIN_UNAVAILABLE);
      expect(response.payload.error!.message).toContain('orphan_tool');
    });
  });

  describe('response envelope structure', () => {
    it('success response has proper envelope fields', async () => {
      const handler: ToolHandler = async () => ({ result: 'ok' });
      const catalog = setupCatalog('test_tool', handler);
      const router = new MessageRouter(catalog);

      const wire = createWireMessage({
        topic: 'tool.invoke.test_tool',
        arguments: { input: 'hi' },
      });
      const session = makeSession({ source: 'my-source', group: 'my-group' });

      const response = await router.processRequest(wire, session);

      expect(response.id).toBeDefined();
      expect(response.version).toBe(PROTOCOL_VERSION);
      expect(response.type).toBe('response');
      expect(response.topic).toBe('tool.invoke.test_tool');
      expect(response.timestamp).toBeDefined();
      expect(Date.parse(response.timestamp)).not.toBeNaN();
    });
  });

  describe('defensive pipeline guards', () => {
    it('returns PLUGIN_ERROR when sync stage returns ok:true', async () => {
      const catalog = new ToolCatalog();
      // Custom stage that returns a success PipelineResult (unexpected from sync stages)
      const okStage: PipelineStage = {
        name: 'mock-ok',
        execute: () =>
          ({
            ok: true,
            envelope: {} as PipelineResult & { ok: true },
            tool: {} as PipelineResult & { ok: true },
          }) as unknown as PipelineResult,
      };
      const router = new MessageRouter(catalog, [okStage]);

      const wire = createWireMessage({ topic: 'tool.invoke.test', correlation: 'c1' });
      const response = await router.processRequest(wire, makeSession());

      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.PLUGIN_ERROR);
      expect(response.payload.error!.message).toContain('unexpected success');
    });

    it('returns PLUGIN_ERROR when pipeline completes without envelope', async () => {
      const catalog = new ToolCatalog();
      // Custom stage that passes through context unchanged (no envelope/tool set)
      const passthrough: PipelineStage = {
        name: 'passthrough',
        execute: (ctx: PipelineContext) => ctx,
      };
      const router = new MessageRouter(catalog, [passthrough]);

      const wire = createWireMessage({ topic: 'tool.invoke.test', correlation: 'c2' });
      const response = await router.processRequest(wire, makeSession());

      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.PLUGIN_ERROR);
      expect(response.payload.error!.message).toContain('envelope or tool not resolved');
    });
  });
});
