import { describe, it, expect } from 'vitest';
import { executeHandler, DEFAULT_HANDLER_OPTIONS } from './error-handler.js';
import { ToolError } from './tool-error.js';
import { ErrorCode } from '../types/errors.js';
import type { PluginHandler, PluginContext } from './plugin-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<PluginContext>): PluginContext {
  return {
    group: 'test-group',
    sessionId: 'sess-001',
    correlationId: 'corr-001',
    timestamp: '2026-02-19T00:00:00.000Z',
    ...overrides,
  };
}

function makeHandler(impl: PluginHandler['handleToolInvocation']): PluginHandler {
  return {
    initialize: async () => {},
    handleToolInvocation: impl,
    shutdown: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Success path: return values → success response
// ---------------------------------------------------------------------------

describe('executeHandler', () => {
  describe('success path', () => {
    it('returns success response when handler returns ok:true', async () => {
      const handler = makeHandler(async () => ({
        ok: true,
        result: { message: 'done' },
      }));

      const response = await executeHandler(
        handler,
        'test_tool',
        { input: 'hello' },
        makeContext(),
      );

      expect(response.error).toBeNull();
      expect(response.result).toEqual({ message: 'done' });
    });

    it('returns structured error when handler returns ok:false', async () => {
      const handler = makeHandler(async () => ({
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: 'API returned 503',
          retriable: true,
        },
      }));

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.result).toBeNull();
      expect(response.error).toEqual({
        code: 'HANDLER_ERROR',
        message: 'API returned 503',
        retriable: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // ToolError throws → structured error response
  // ---------------------------------------------------------------------------

  describe('ToolError throw path', () => {
    it('converts ToolError to structured error response', async () => {
      const handler = makeHandler(async () => {
        throw new ToolError({
          code: ErrorCode.HANDLER_ERROR,
          message: 'Apple Reminders API failed',
          retriable: true,
        });
      });

      const response = await executeHandler(handler, 'create_reminder', {}, makeContext());

      expect(response.result).toBeNull();
      expect(response.error).toEqual({
        code: 'HANDLER_ERROR',
        message: 'Apple Reminders API failed',
        retriable: true,
      });
    });

    it('includes field in error response when ToolError has field', async () => {
      const handler = makeHandler(async () => {
        throw new ToolError({
          code: ErrorCode.HANDLER_ERROR,
          message: 'invalid date format',
          field: 'due_date',
        });
      });

      const response = await executeHandler(handler, 'create_reminder', {}, makeContext());

      expect(response.error!.field).toBe('due_date');
    });

    it('includes retry_after in error response when ToolError has retry_after', async () => {
      const handler = makeHandler(async () => {
        throw new ToolError({
          code: ErrorCode.HANDLER_ERROR,
          message: 'upstream rate limit',
          retriable: true,
          retry_after: 30,
        });
      });

      const response = await executeHandler(handler, 'create_reminder', {}, makeContext());

      expect(response.error!.retry_after).toBe(30);
    });

    it('normalizes reserved pipeline codes in thrown ToolError', async () => {
      const handler = makeHandler(async () => {
        throw new ToolError({
          code: ErrorCode.UNAUTHORIZED,
          message: 'handler tried to use pipeline code',
        });
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.error!.code).toBe('HANDLER_ERROR');
      expect(response.error!.message).toBe('handler tried to use pipeline code');
    });
  });

  // ---------------------------------------------------------------------------
  // Non-ToolError throws → generic PLUGIN_ERROR
  // ---------------------------------------------------------------------------

  describe('generic error path', () => {
    it('converts plain Error to generic PLUGIN_ERROR', async () => {
      const handler = makeHandler(async () => {
        throw new Error('internal database connection failed');
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.result).toBeNull();
      expect(response.error!.code).toBe('PLUGIN_ERROR');
      expect(response.error!.retriable).toBe(false);
    });

    it('does not leak internal error message', async () => {
      const handler = makeHandler(async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:5432');
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.error!.message).not.toContain('ECONNREFUSED');
      expect(response.error!.message).not.toContain('127.0.0.1');
    });

    it('does not leak stack trace', async () => {
      const handler = makeHandler(async () => {
        throw new Error('secret details');
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      const serialized = JSON.stringify(response.error);
      expect(serialized).not.toContain('at ');
      expect(serialized).not.toContain('secret details');
    });

    it('converts string throw to generic PLUGIN_ERROR', async () => {
      const handler = makeHandler(async () => {
        throw 'something bad happened';
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.error!.code).toBe('PLUGIN_ERROR');
      expect(response.error!.message).not.toContain('something bad happened');
    });

    it('converts TypeError to generic PLUGIN_ERROR', async () => {
      const handler = makeHandler(async () => {
        const obj: Record<string, unknown> = {};
        (obj.foo as () => void)();
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.error!.code).toBe('PLUGIN_ERROR');
    });

    it('converts rejected promise to generic PLUGIN_ERROR', async () => {
      const handler = makeHandler(() => {
        return Promise.reject(new Error('async failure'));
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.error!.code).toBe('PLUGIN_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // Timeout → PLUGIN_TIMEOUT
  // ---------------------------------------------------------------------------

  describe('timeout path', () => {
    it('produces PLUGIN_TIMEOUT when handler exceeds timeout', async () => {
      const handler = makeHandler(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { ok: true, result: {} };
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext(), {
        timeoutMs: 50,
      });

      expect(response.error!.code).toBe('PLUGIN_TIMEOUT');
      expect(response.error!.retriable).toBe(true);
    });

    it('PLUGIN_TIMEOUT message includes tool name', async () => {
      const handler = makeHandler(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { ok: true, result: {} };
      });

      const response = await executeHandler(handler, 'create_reminder', {}, makeContext(), {
        timeoutMs: 50,
      });

      expect(response.error!.message).toContain('create_reminder');
    });

    it('uses default timeout from DEFAULT_HANDLER_OPTIONS', () => {
      expect(DEFAULT_HANDLER_OPTIONS.timeoutMs).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Oversized response → HANDLER_ERROR
  // ---------------------------------------------------------------------------

  describe('oversized response', () => {
    it('produces HANDLER_ERROR when success response exceeds size limit', async () => {
      const largeData = 'x'.repeat(2_000_000);
      const handler = makeHandler(async () => ({
        ok: true,
        result: { data: largeData },
      }));

      const response = await executeHandler(handler, 'test_tool', {}, makeContext(), {
        maxResponseBytes: 1_048_576,
      });

      expect(response.error!.code).toBe('HANDLER_ERROR');
      expect(response.error!.message).toContain('size');
    });

    it('produces HANDLER_ERROR when error response exceeds size limit', async () => {
      const largeMessage = 'x'.repeat(2_000_000);
      const handler = makeHandler(async () => ({
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: largeMessage,
          retriable: false,
        },
      }));

      const response = await executeHandler(handler, 'test_tool', {}, makeContext(), {
        maxResponseBytes: 1_048_576,
      });

      expect(response.error!.code).toBe('HANDLER_ERROR');
      expect(response.error!.retriable).toBe(false);
    });

    it('does not reject responses within the size limit', async () => {
      const handler = makeHandler(async () => ({
        ok: true,
        result: { message: 'small response' },
      }));

      const response = await executeHandler(handler, 'test_tool', {}, makeContext(), {
        maxResponseBytes: 1_048_576,
      });

      expect(response.error).toBeNull();
      expect(response.result).toEqual({ message: 'small response' });
    });

    it('uses default maxResponseBytes from DEFAULT_HANDLER_OPTIONS', () => {
      expect(DEFAULT_HANDLER_OPTIONS.maxResponseBytes).toBe(1_048_576);
    });
  });

  // ---------------------------------------------------------------------------
  // All 10 error codes produce correct envelopes
  // ---------------------------------------------------------------------------

  describe('all 10 error codes produce correct envelopes', () => {
    const handlerCodes = [
      ErrorCode.HANDLER_ERROR,
      ErrorCode.PLUGIN_ERROR,
      ErrorCode.PLUGIN_TIMEOUT,
      ErrorCode.PLUGIN_UNAVAILABLE,
    ] as const;

    for (const code of handlerCodes) {
      it(`ToolError with ${code} produces correct error payload`, async () => {
        const handler = makeHandler(async () => {
          throw new ToolError({
            code,
            message: `test ${code}`,
          });
        });

        const response = await executeHandler(handler, 'test_tool', {}, makeContext());

        expect(response.error!.code).toBe(code);
        expect(response.error!.message).toBe(`test ${code}`);
      });
    }

    const pipelineCodes = [
      ErrorCode.UNKNOWN_TOOL,
      ErrorCode.VALIDATION_FAILED,
      ErrorCode.UNAUTHORIZED,
      ErrorCode.RATE_LIMITED,
      ErrorCode.CONFIRMATION_TIMEOUT,
      ErrorCode.CONFIRMATION_DENIED,
    ] as const;

    for (const code of pipelineCodes) {
      it(`ToolError with reserved ${code} normalizes to HANDLER_ERROR`, async () => {
        const handler = makeHandler(async () => {
          throw new ToolError({
            code,
            message: `test ${code}`,
          });
        });

        const response = await executeHandler(handler, 'test_tool', {}, makeContext());

        expect(response.error!.code).toBe('HANDLER_ERROR');
        expect(response.error!.message).toBe(`test ${code}`);
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Error metadata
  // ---------------------------------------------------------------------------

  describe('error metadata correctness', () => {
    it('PLUGIN_TIMEOUT is retriable', async () => {
      const handler = makeHandler(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { ok: true, result: {} };
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext(), {
        timeoutMs: 50,
      });

      expect(response.error!.retriable).toBe(true);
    });

    it('PLUGIN_ERROR from generic throw is not retriable', async () => {
      const handler = makeHandler(async () => {
        throw new Error('crash');
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.error!.retriable).toBe(false);
    });

    it('HANDLER_ERROR can be retriable when handler says so', async () => {
      const handler = makeHandler(async () => {
        throw new ToolError({
          code: ErrorCode.HANDLER_ERROR,
          message: 'transient failure',
          retriable: true,
        });
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.error!.retriable).toBe(true);
    });

    it('ToolError with field produces error with field metadata', async () => {
      const handler = makeHandler(async () => {
        throw new ToolError({
          code: ErrorCode.HANDLER_ERROR,
          message: 'invalid format',
          field: 'due_date',
        });
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.error!.field).toBe('due_date');
    });

    it('ToolError with retry_after produces error with retry_after metadata', async () => {
      const handler = makeHandler(async () => {
        throw new ToolError({
          code: ErrorCode.HANDLER_ERROR,
          message: 'rate limited',
          retriable: true,
          retry_after: 45,
        });
      });

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.error!.retry_after).toBe(45);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handler returning null result produces success with null', async () => {
      const handler = makeHandler(async () => ({
        ok: true,
        result: {},
      }));

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.error).toBeNull();
    });

    it('handler returning empty object result produces success', async () => {
      const handler = makeHandler(async () => ({
        ok: true,
        result: {},
      }));

      const response = await executeHandler(handler, 'test_tool', {}, makeContext());

      expect(response.result).toEqual({});
      expect(response.error).toBeNull();
    });
  });
});
