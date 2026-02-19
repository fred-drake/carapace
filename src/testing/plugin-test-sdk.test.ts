import { describe, it, expect } from 'vitest';
import {
  createTestContext,
  createTestInvocation,
  FakeCredentialStore,
  assertSuccessResult,
  assertErrorResult,
  assertNoCredentialLeak,
} from './plugin-test-sdk.js';
import type { PluginHandler, CoreServices, ToolInvocationResult } from '../core/plugin-handler.js';
import { ErrorCode } from '../types/index.js';

// ---------------------------------------------------------------------------
// Sample handlers for testing
// ---------------------------------------------------------------------------

function createEchoHandler(): PluginHandler {
  return {
    async initialize(_services: CoreServices): Promise<void> {},
    async handleToolInvocation(
      _tool: string,
      args: Record<string, unknown>,
      _context,
    ): Promise<ToolInvocationResult> {
      return { ok: true, result: { echoed: args['text'] ?? '' } };
    },
    async shutdown(): Promise<void> {},
  };
}

function createFailingHandler(): PluginHandler {
  return {
    async initialize(_services: CoreServices): Promise<void> {},
    async handleToolInvocation(): Promise<ToolInvocationResult> {
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: 'Something went wrong',
          retriable: false,
        },
      };
    },
    async shutdown(): Promise<void> {},
  };
}

// ---------------------------------------------------------------------------
// createTestContext()
// ---------------------------------------------------------------------------

describe('createTestContext', () => {
  it('returns a valid PluginContext with defaults', () => {
    const ctx = createTestContext();
    expect(ctx.group).toBe('test-group');
    expect(ctx.sessionId).toBe('test-session');
    expect(ctx.correlationId).toBe('test-correlation');
    expect(typeof ctx.timestamp).toBe('string');
  });

  it('accepts overrides for any field', () => {
    const ctx = createTestContext({
      group: 'my-group',
      sessionId: 'my-session',
    });
    expect(ctx.group).toBe('my-group');
    expect(ctx.sessionId).toBe('my-session');
    // Non-overridden fields still have defaults
    expect(ctx.correlationId).toBe('test-correlation');
  });

  it('overrides timestamp', () => {
    const ts = '2026-01-01T00:00:00.000Z';
    const ctx = createTestContext({ timestamp: ts });
    expect(ctx.timestamp).toBe(ts);
  });
});

// ---------------------------------------------------------------------------
// createTestInvocation()
// ---------------------------------------------------------------------------

describe('createTestInvocation', () => {
  it('invokes a handler with the given tool and args', async () => {
    const handler = createEchoHandler();
    const result = await createTestInvocation(handler, 'echo', { text: 'hello' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ echoed: 'hello' });
    }
  });

  it('uses default context when none provided', async () => {
    const handler = createEchoHandler();
    const result = await createTestInvocation(handler, 'echo', { text: 'test' });
    expect(result.ok).toBe(true);
  });

  it('accepts custom context overrides', async () => {
    let capturedGroup = '';
    const handler: PluginHandler = {
      async initialize(): Promise<void> {},
      async handleToolInvocation(_tool, _args, context): Promise<ToolInvocationResult> {
        capturedGroup = context.group;
        return { ok: true, result: {} };
      },
      async shutdown(): Promise<void> {},
    };

    await createTestInvocation(handler, 'test', {}, { group: 'custom-group' });
    expect(capturedGroup).toBe('custom-group');
  });

  it('returns error results from failing handlers', async () => {
    const handler = createFailingHandler();
    const result = await createTestInvocation(handler, 'fail', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.HANDLER_ERROR);
    }
  });

  it('calls initialize before first invocation when autoInit is true', async () => {
    let initCalled = false;
    const handler: PluginHandler = {
      async initialize(): Promise<void> {
        initCalled = true;
      },
      async handleToolInvocation(): Promise<ToolInvocationResult> {
        return { ok: true, result: { initialized: initCalled } };
      },
      async shutdown(): Promise<void> {},
    };

    const result = await createTestInvocation(handler, 'test', {}, undefined, {
      autoInit: true,
    });
    expect(initCalled).toBe(true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result['initialized']).toBe(true);
    }
  });

  it('does not call initialize by default', async () => {
    let initCalled = false;
    const handler: PluginHandler = {
      async initialize(): Promise<void> {
        initCalled = true;
      },
      async handleToolInvocation(): Promise<ToolInvocationResult> {
        return { ok: true, result: {} };
      },
      async shutdown(): Promise<void> {},
    };

    await createTestInvocation(handler, 'test', {});
    expect(initCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FakeCredentialStore
// ---------------------------------------------------------------------------

describe('FakeCredentialStore', () => {
  it('stores and retrieves credentials', () => {
    const store = new FakeCredentialStore();
    store.set('api-key', 'sk-test-12345');
    expect(store.get('api-key')).toBe('sk-test-12345');
  });

  it('returns undefined for missing credentials', () => {
    const store = new FakeCredentialStore();
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('initializes with pre-set credentials', () => {
    const store = new FakeCredentialStore({
      'api-key': 'sk-test',
      'oauth-token': 'Bearer abc',
    });
    expect(store.get('api-key')).toBe('sk-test');
    expect(store.get('oauth-token')).toBe('Bearer abc');
  });

  it('deletes credentials', () => {
    const store = new FakeCredentialStore({ key: 'value' });
    store.delete('key');
    expect(store.get('key')).toBeUndefined();
  });

  it('checks if credential exists', () => {
    const store = new FakeCredentialStore({ key: 'value' });
    expect(store.has('key')).toBe(true);
    expect(store.has('other')).toBe(false);
  });

  it('lists all credential keys', () => {
    const store = new FakeCredentialStore({
      a: '1',
      b: '2',
    });
    expect(store.keys().sort()).toEqual(['a', 'b']);
  });

  it('clears all credentials', () => {
    const store = new FakeCredentialStore({ a: '1', b: '2' });
    store.clear();
    expect(store.keys()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// assertSuccessResult()
// ---------------------------------------------------------------------------

describe('assertSuccessResult', () => {
  it('passes for ok result', () => {
    const result: ToolInvocationResult = { ok: true, result: { data: 'test' } };
    const data = assertSuccessResult(result);
    expect(data).toEqual({ data: 'test' });
  });

  it('throws for error result', () => {
    const result: ToolInvocationResult = {
      ok: false,
      error: { code: ErrorCode.HANDLER_ERROR, message: 'fail', retriable: false },
    };
    expect(() => assertSuccessResult(result)).toThrow(/expected.*success/i);
  });
});

// ---------------------------------------------------------------------------
// assertErrorResult()
// ---------------------------------------------------------------------------

describe('assertErrorResult', () => {
  it('passes for error result', () => {
    const result: ToolInvocationResult = {
      ok: false,
      error: { code: ErrorCode.HANDLER_ERROR, message: 'fail', retriable: false },
    };
    const error = assertErrorResult(result);
    expect(error.code).toBe(ErrorCode.HANDLER_ERROR);
  });

  it('optionally asserts error code', () => {
    const result: ToolInvocationResult = {
      ok: false,
      error: { code: ErrorCode.HANDLER_ERROR, message: 'fail', retriable: false },
    };
    const error = assertErrorResult(result, ErrorCode.HANDLER_ERROR);
    expect(error.code).toBe(ErrorCode.HANDLER_ERROR);
  });

  it('throws when error code does not match', () => {
    const result: ToolInvocationResult = {
      ok: false,
      error: { code: ErrorCode.HANDLER_ERROR, message: 'fail', retriable: false },
    };
    expect(() => assertErrorResult(result, ErrorCode.PLUGIN_ERROR)).toThrow(
      /expected.*PLUGIN_ERROR/i,
    );
  });

  it('throws for success result', () => {
    const result: ToolInvocationResult = { ok: true, result: {} };
    expect(() => assertErrorResult(result)).toThrow(/expected.*error/i);
  });
});

// ---------------------------------------------------------------------------
// assertNoCredentialLeak()
// ---------------------------------------------------------------------------

describe('assertNoCredentialLeak', () => {
  it('passes for clean results', () => {
    const result: ToolInvocationResult = {
      ok: true,
      result: { message: 'Hello world' },
    };
    expect(() => assertNoCredentialLeak(result)).not.toThrow();
  });

  it('detects Bearer tokens in result values', () => {
    const result: ToolInvocationResult = {
      ok: true,
      result: { auth: 'Bearer eyJhbGciOiJIUzI1NiJ9' },
    };
    expect(() => assertNoCredentialLeak(result)).toThrow(/credential.*leak/i);
  });

  it('detects API key patterns (sk-)', () => {
    const result: ToolInvocationResult = {
      ok: true,
      result: { key: 'sk-proj-abc123def456' },
    };
    expect(() => assertNoCredentialLeak(result)).toThrow(/credential.*leak/i);
  });

  it('detects X-API-Key patterns', () => {
    const result: ToolInvocationResult = {
      ok: true,
      result: { header: 'X-API-Key: abc123def456' },
    };
    expect(() => assertNoCredentialLeak(result)).toThrow(/credential.*leak/i);
  });

  it('detects credentials in nested objects', () => {
    const result: ToolInvocationResult = {
      ok: true,
      result: {
        data: {
          nested: {
            token: 'Bearer secret-token',
          },
        },
      },
    };
    expect(() => assertNoCredentialLeak(result)).toThrow(/credential.*leak/i);
  });

  it('detects credentials in error results', () => {
    const result: ToolInvocationResult = {
      ok: false,
      error: {
        code: ErrorCode.HANDLER_ERROR,
        message: 'Auth failed with Bearer abc123',
        retriable: false,
      },
    };
    expect(() => assertNoCredentialLeak(result)).toThrow(/credential.*leak/i);
  });

  it('passes for results with safe string values', () => {
    const result: ToolInvocationResult = {
      ok: true,
      result: {
        status: 'ok',
        count: 42,
        items: ['a', 'b'],
      },
    };
    expect(() => assertNoCredentialLeak(result)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: plugin test in under 20 lines
// ---------------------------------------------------------------------------

describe('plugin test SDK integration', () => {
  it('supports testing a plugin handler in under 20 lines', async () => {
    // This proves the acceptance criteria: plugin test in under 20 lines
    const handler: PluginHandler = {
      async initialize(): Promise<void> {},
      async handleToolInvocation(_tool, args): Promise<ToolInvocationResult> {
        return { ok: true, result: { doubled: String(args['text']).repeat(2) } };
      },
      async shutdown(): Promise<void> {},
    };

    const result = await createTestInvocation(handler, 'double', { text: 'hi' });
    const data = assertSuccessResult(result);
    expect(data['doubled']).toBe('hihi');
    assertNoCredentialLeak(result);
  });
});
