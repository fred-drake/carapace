import { describe, it, expect } from 'vitest';
import { stage3Payload } from './stage-3-payload.js';
import { ErrorCode } from '../../types/errors.js';
import { createWireMessage, createToolDeclaration } from '../../testing/factories.js';
import type { PipelineContext, PipelineResult } from './types.js';
import type { SessionContext } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(): SessionContext {
  return {
    sessionId: 'sess-001',
    group: 'test-group',
    source: 'agent-test',
    startedAt: '2026-02-18T10:00:00Z',
  };
}

function makeContext(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    wire: createWireMessage({ arguments: { input: 'hello' } }),
    session: makeSession(),
    tool: createToolDeclaration({
      arguments_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          input: { type: 'string' },
        },
      },
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Stage 3: Payload validation', () => {
  it('passes when arguments match schema', () => {
    const ctx = makeContext();
    const result = stage3Payload.execute(ctx);

    // Should return the context unchanged (no `ok` property)
    expect(result).not.toHaveProperty('ok');
    expect(result).toBe(ctx);
  });

  it('fails on extra properties (additionalProperties: false)', () => {
    const ctx = makeContext({
      wire: createWireMessage({ arguments: { input: 'hello', extra: 'bad' } }),
    });

    const result = stage3Payload.execute(ctx);

    expect(result).toHaveProperty('ok', false);
    const errorResult = result as PipelineResult & { ok: false };
    expect(errorResult.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(errorResult.error.message).toContain('additional');
  });

  it('fails on missing required properties', () => {
    const tool = createToolDeclaration({
      arguments_schema: {
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
        },
      },
    });

    const ctx = makeContext({
      wire: createWireMessage({ arguments: {} }),
      tool,
    });

    const result = stage3Payload.execute(ctx);

    expect(result).toHaveProperty('ok', false);
    const errorResult = result as PipelineResult & { ok: false };
    expect(errorResult.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(errorResult.error.message).toContain('required');
  });

  it('fails on wrong type', () => {
    const ctx = makeContext({
      wire: createWireMessage({ arguments: { input: 12345 } }),
    });

    const result = stage3Payload.execute(ctx);

    expect(result).toHaveProperty('ok', false);
    const errorResult = result as PipelineResult & { ok: false };
    expect(errorResult.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(errorResult.error.message).toContain('string');
  });

  it('returns VALIDATION_FAILED with details', () => {
    const ctx = makeContext({
      wire: createWireMessage({ arguments: { input: 42, extra: 'bad' } }),
    });

    const result = stage3Payload.execute(ctx);

    expect(result).toHaveProperty('ok', false);
    const errorResult = result as PipelineResult & { ok: false };
    expect(errorResult.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(errorResult.error.message).toContain('Argument validation failed');
    expect(errorResult.error.stage).toBe(3);
    expect(errorResult.error.retriable).toBe(false);
  });

  it('includes field name for property-level errors', () => {
    const ctx = makeContext({
      wire: createWireMessage({ arguments: { input: 12345 } }),
    });

    const result = stage3Payload.execute(ctx);

    const errorResult = result as PipelineResult & { ok: false };
    expect(errorResult.error.field).toBe('input');
  });

  it('passes with valid arguments including optional properties', () => {
    const tool = createToolDeclaration({
      arguments_schema: {
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
        },
      },
    });

    const ctx = makeContext({
      wire: createWireMessage({ arguments: { title: 'Hello' } }),
      tool,
    });

    const result = stage3Payload.execute(ctx);
    expect(result).not.toHaveProperty('ok');
  });

  it('has stage name "payload"', () => {
    expect(stage3Payload.name).toBe('payload');
  });
});
