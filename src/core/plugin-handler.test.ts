import { describe, it, expect, vi, expectTypeOf } from 'vitest';
import type {
  PluginHandler,
  CoreServices,
  PluginContext,
  ToolInvocationResult,
  SessionInfo,
  AuditLogFilter,
  AuditLogEntry,
} from './plugin-handler.js';
import { formatErrorMessage } from './plugin-handler.js';

// ---------------------------------------------------------------------------
// Test: Interface is implementable
// ---------------------------------------------------------------------------

describe('PluginHandler interface', () => {
  it('can be implemented by a test handler', () => {
    const handler: PluginHandler = {
      initialize: async () => {},
      handleToolInvocation: async () => ({ ok: true, result: {} }),
      shutdown: async () => {},
    };

    expect(handler.initialize).toBeDefined();
    expect(handler.handleToolInvocation).toBeDefined();
    expect(handler.shutdown).toBeDefined();
  });

  it('handleEvent is optional', () => {
    const handler: PluginHandler = {
      initialize: async () => {},
      handleToolInvocation: async () => ({ ok: true, result: {} }),
      shutdown: async () => {},
    };

    expect(handler.handleEvent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test: PluginContext has all necessary fields
// ---------------------------------------------------------------------------

describe('PluginContext', () => {
  it('includes group, sessionId, correlationId, and timestamp', () => {
    const ctx: PluginContext = {
      group: 'user-123',
      sessionId: 'sess-abc',
      correlationId: 'corr-001',
      timestamp: '2026-02-19T00:00:00.000Z',
    };

    expect(ctx.group).toBe('user-123');
    expect(ctx.sessionId).toBe('sess-abc');
    expect(ctx.correlationId).toBe('corr-001');
    expect(ctx.timestamp).toBe('2026-02-19T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Test: ToolInvocationResult — success and error
// ---------------------------------------------------------------------------

describe('ToolInvocationResult', () => {
  it('represents a successful result', () => {
    const result: ToolInvocationResult = {
      ok: true,
      result: { message: 'echoed' },
    };

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ message: 'echoed' });
    }
  });

  it('represents a structured error', () => {
    const result: ToolInvocationResult = {
      ok: false,
      error: {
        code: 'HANDLER_ERROR',
        message: 'Something went wrong',
        retriable: false,
      },
    };

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('HANDLER_ERROR');
      expect(result.error.message).toBe('Something went wrong');
      expect(result.error.retriable).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: CoreServices type has required methods
// ---------------------------------------------------------------------------

describe('CoreServices', () => {
  it('exposes getAuditLog, getToolCatalog, and getSessionInfo', () => {
    const services: CoreServices = {
      getAuditLog: vi.fn(async () => []),
      getToolCatalog: vi.fn(() => []),
      getSessionInfo: vi.fn(() => ({
        group: 'test-group',
        sessionId: 'sess-001',
        startedAt: '2026-02-19T00:00:00.000Z',
      })),
    };

    expect(services.getAuditLog).toBeDefined();
    expect(services.getToolCatalog).toBeDefined();
    expect(services.getSessionInfo).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test: Lifecycle hooks fire in correct order
// ---------------------------------------------------------------------------

describe('Lifecycle: init → handleToolInvocation → shutdown', () => {
  it('executes lifecycle methods in order', async () => {
    const callOrder: string[] = [];

    const handler: PluginHandler = {
      initialize: async () => {
        callOrder.push('init');
      },
      handleToolInvocation: async () => {
        callOrder.push('handle');
        return { ok: true, result: {} };
      },
      shutdown: async () => {
        callOrder.push('shutdown');
      },
    };

    const services: CoreServices = {
      getAuditLog: async () => [],
      getToolCatalog: () => [],
      getSessionInfo: () => ({
        group: 'g',
        sessionId: 's',
        startedAt: '2026-02-19T00:00:00.000Z',
      }),
    };

    await handler.initialize(services);
    await handler.handleToolInvocation(
      'echo',
      { text: 'hello' },
      {
        group: 'g',
        sessionId: 's',
        correlationId: 'c',
        timestamp: '2026-02-19T00:00:00.000Z',
      },
    );
    await handler.shutdown();

    expect(callOrder).toEqual(['init', 'handle', 'shutdown']);
  });
});

// ---------------------------------------------------------------------------
// Test: Error message template
// ---------------------------------------------------------------------------

describe('formatErrorMessage', () => {
  it('generates [COMPONENT] Error: {what}. Fix: {how}. Docs: {link}', () => {
    const msg = formatErrorMessage({
      component: 'PluginLoader',
      what: 'Manifest validation failed',
      how: 'Check your manifest.json against the schema',
      docs: 'https://carapace.dev/docs/manifest',
    });

    expect(msg).toBe(
      '[PluginLoader] Error: Manifest validation failed. Fix: Check your manifest.json against the schema. Docs: https://carapace.dev/docs/manifest',
    );
  });

  it('omits Docs section when link is not provided', () => {
    const msg = formatErrorMessage({
      component: 'Router',
      what: 'Unknown tool',
      how: 'Check the tool name matches a registered plugin',
    });

    expect(msg).toBe(
      '[Router] Error: Unknown tool. Fix: Check the tool name matches a registered plugin.',
    );
  });
});

// ---------------------------------------------------------------------------
// Test: Echo plugin example works
// ---------------------------------------------------------------------------

describe('Echo plugin example', () => {
  it('echoes input text back', async () => {
    // Inline echo handler matching examples/echo-plugin/handler.ts
    const handler: PluginHandler = {
      async initialize() {},
      async handleToolInvocation(_tool, args) {
        return { ok: true, result: { echoed: args['text'] ?? '' } };
      },
      async shutdown() {},
    };

    const result = await handler.handleToolInvocation(
      'echo',
      { text: 'hello world' },
      {
        group: 'g',
        sessionId: 's',
        correlationId: 'c',
        timestamp: '2026-02-19T00:00:00.000Z',
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ echoed: 'hello world' });
    }
  });
});

// ---------------------------------------------------------------------------
// Test: TypeScript types provide full autocomplete
// ---------------------------------------------------------------------------

describe('Type-level tests (autocomplete verification)', () => {
  it('PluginHandler has correct method signatures', () => {
    expectTypeOf<PluginHandler['initialize']>().toBeFunction();
    expectTypeOf<PluginHandler['handleToolInvocation']>().toBeFunction();
    expectTypeOf<PluginHandler['shutdown']>().toBeFunction();
    expectTypeOf<PluginHandler['handleEvent']>().toEqualTypeOf<PluginHandler['handleEvent']>();
  });

  it('CoreServices has typed method signatures', () => {
    expectTypeOf<CoreServices['getAuditLog']>().toBeFunction();
    expectTypeOf<CoreServices['getToolCatalog']>().toBeFunction();
    expectTypeOf<CoreServices['getSessionInfo']>().toBeFunction();
  });

  it('PluginContext has all required fields', () => {
    expectTypeOf<PluginContext>().toHaveProperty('group');
    expectTypeOf<PluginContext>().toHaveProperty('sessionId');
    expectTypeOf<PluginContext>().toHaveProperty('correlationId');
    expectTypeOf<PluginContext>().toHaveProperty('timestamp');
  });

  it('ToolInvocationResult is a discriminated union', () => {
    const success: ToolInvocationResult = { ok: true, result: {} };
    const failure: ToolInvocationResult = {
      ok: false,
      error: { code: 'HANDLER_ERROR', message: 'fail', retriable: false },
    };
    expectTypeOf(success).toMatchTypeOf<ToolInvocationResult>();
    expectTypeOf(failure).toMatchTypeOf<ToolInvocationResult>();
  });

  it('SessionInfo has group, sessionId, startedAt', () => {
    expectTypeOf<SessionInfo>().toHaveProperty('group');
    expectTypeOf<SessionInfo>().toHaveProperty('sessionId');
    expectTypeOf<SessionInfo>().toHaveProperty('startedAt');
  });

  it('AuditLogFilter has optional filter fields', () => {
    const filter: AuditLogFilter = {};
    expectTypeOf(filter).toMatchTypeOf<AuditLogFilter>();
  });

  it('AuditLogEntry has required fields', () => {
    expectTypeOf<AuditLogEntry>().toHaveProperty('id');
    expectTypeOf<AuditLogEntry>().toHaveProperty('timestamp');
    expectTypeOf<AuditLogEntry>().toHaveProperty('topic');
    expectTypeOf<AuditLogEntry>().toHaveProperty('outcome');
  });
});
