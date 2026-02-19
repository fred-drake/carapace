import { describe, it, expect } from 'vitest';
import {
  deepMerge,
  createWireMessage,
  createEventEnvelope,
  createRequestEnvelope,
  createResponseEnvelope,
  createToolDeclaration,
  createManifest,
  createErrorPayload,
} from './factories.js';
import { ErrorCode } from '../types/index.js';

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

describe('deepMerge', () => {
  it('returns a shallow copy when source is empty', () => {
    const target = { a: 1, b: { c: 2 } };
    const result = deepMerge(target, {});
    expect(result).toEqual(target);
    expect(result).not.toBe(target);
  });

  it('merges nested objects recursively', () => {
    const target = { a: { b: 1, c: 2 }, d: 3 };
    const result = deepMerge(target, { a: { b: 99 } });
    expect(result).toEqual({ a: { b: 99, c: 2 }, d: 3 });
  });

  it('replaces arrays outright instead of merging', () => {
    const target = { tags: ['a', 'b'] } as Record<string, unknown>;
    const result = deepMerge(target, { tags: ['c'] });
    expect(result.tags).toEqual(['c']);
  });

  it('does not mutate the original target', () => {
    const target = { a: { b: 1 } };
    deepMerge(target, { a: { b: 99 } });
    expect(target.a.b).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createWireMessage
// ---------------------------------------------------------------------------

describe('createWireMessage', () => {
  it('produces valid defaults', () => {
    const msg = createWireMessage();
    expect(msg.topic).toBe('tool.invoke.test_tool');
    expect(msg.correlation).toBe('corr-001');
    expect(msg.arguments).toEqual({ input: 'test' });
  });

  it('applies shallow overrides', () => {
    const msg = createWireMessage({ topic: 'tool.invoke.custom' });
    expect(msg.topic).toBe('tool.invoke.custom');
    expect(msg.correlation).toBe('corr-001');
  });

  it('applies deep overrides to arguments', () => {
    const msg = createWireMessage({ arguments: { input: 'override', extra: true } });
    expect(msg.arguments).toEqual({ input: 'override', extra: true });
  });

  it('produces independently mutable objects', () => {
    const a = createWireMessage();
    const b = createWireMessage();
    a.arguments.input = 'mutated';
    expect(b.arguments.input).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// createEventEnvelope
// ---------------------------------------------------------------------------

describe('createEventEnvelope', () => {
  it('produces valid defaults with type "event"', () => {
    const env = createEventEnvelope();
    expect(env.id).toBe('evt-001');
    expect(env.version).toBe(1);
    expect(env.type).toBe('event');
    expect(env.topic).toBe('message.inbound');
    expect(env.source).toBe('test');
    expect(env.correlation).toBeNull();
    expect(env.group).toBe('test-group');
    expect(env.payload).toEqual({ channel: 'test', body: 'hello' });
    expect(typeof env.timestamp).toBe('string');
  });

  it('applies overrides including nested payload', () => {
    const env = createEventEnvelope({
      id: 'evt-custom',
      payload: { channel: 'email' },
    });
    expect(env.id).toBe('evt-custom');
    expect(env.payload.channel).toBe('email');
  });

  it('produces independently mutable objects', () => {
    const a = createEventEnvelope();
    const b = createEventEnvelope();
    (a.payload as Record<string, unknown>).channel = 'mutated';
    expect((b.payload as Record<string, unknown>).channel).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// createRequestEnvelope
// ---------------------------------------------------------------------------

describe('createRequestEnvelope', () => {
  it('produces valid defaults with type "request"', () => {
    const env = createRequestEnvelope();
    expect(env.id).toBe('req-001');
    expect(env.version).toBe(1);
    expect(env.type).toBe('request');
    expect(env.topic).toBe('tool.invoke.test_tool');
    expect(env.source).toBe('agent-test');
    expect(env.correlation).toBe('corr-001');
    expect(env.group).toBe('test-group');
    expect(env.payload).toEqual({ arguments: { input: 'test' } });
  });

  it('correlation is always a string (non-null)', () => {
    const env = createRequestEnvelope();
    // Compile-time proof: correlation is string, not string | null
    const _corr: string = env.correlation;
    expect(typeof _corr).toBe('string');
  });

  it('applies deep overrides to payload.arguments', () => {
    const env = createRequestEnvelope({
      payload: { arguments: { input: 'custom', flag: true } },
    });
    expect(env.payload.arguments).toEqual({ input: 'custom', flag: true });
  });

  it('produces independently mutable objects', () => {
    const a = createRequestEnvelope();
    const b = createRequestEnvelope();
    a.payload.arguments.input = 'mutated';
    expect(b.payload.arguments.input).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// createResponseEnvelope
// ---------------------------------------------------------------------------

describe('createResponseEnvelope', () => {
  it('produces valid defaults with type "response"', () => {
    const env = createResponseEnvelope();
    expect(env.id).toBe('res-001');
    expect(env.version).toBe(1);
    expect(env.type).toBe('response');
    expect(env.topic).toBe('tool.invoke.test_tool');
    expect(env.source).toBe('test-plugin');
    expect(env.correlation).toBe('corr-001');
    expect(env.group).toBe('test-group');
    expect(env.payload.result).toEqual({ ok: true });
    expect(env.payload.error).toBeNull();
  });

  it('correlation is always a string (non-null)', () => {
    const env = createResponseEnvelope();
    const _corr: string = env.correlation;
    expect(typeof _corr).toBe('string');
  });

  it('applies overrides to payload', () => {
    const env = createResponseEnvelope({
      payload: { result: { data: [1, 2, 3] } },
    });
    // Deep merge: default result { ok: true } is merged with { data: [1, 2, 3] }
    expect(env.payload.result).toEqual({ ok: true, data: [1, 2, 3] });
    // error should still be null from defaults (deep merge preserves unset keys)
    expect(env.payload.error).toBeNull();
  });

  it('replaces result entirely when override provides a non-object', () => {
    const env = createResponseEnvelope({
      payload: { result: 'simple-string' as unknown as Record<string, unknown> },
    });
    expect(env.payload.result).toBe('simple-string');
  });

  it('produces independently mutable objects', () => {
    const a = createResponseEnvelope();
    const b = createResponseEnvelope();
    (a.payload.result as Record<string, unknown>).ok = false;
    expect((b.payload.result as Record<string, unknown>).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createToolDeclaration
// ---------------------------------------------------------------------------

describe('createToolDeclaration', () => {
  it('produces valid defaults', () => {
    const tool = createToolDeclaration();
    expect(tool.name).toBe('test_tool');
    expect(tool.description).toBe('A test tool');
    expect(tool.risk_level).toBe('low');
    expect(tool.arguments_schema.type).toBe('object');
    expect(tool.arguments_schema.additionalProperties).toBe(false);
    expect(tool.arguments_schema.properties).toEqual({
      input: { type: 'string' },
    });
  });

  it('applies overrides including nested schema properties', () => {
    const tool = createToolDeclaration({
      name: 'custom_tool',
      risk_level: 'high',
      arguments_schema: {
        properties: {
          query: { type: 'string' },
        },
      },
    });
    expect(tool.name).toBe('custom_tool');
    expect(tool.risk_level).toBe('high');
    // Deep merge: the properties object is merged
    expect(tool.arguments_schema.properties.query).toEqual({ type: 'string' });
    expect(tool.arguments_schema.additionalProperties).toBe(false);
  });

  it('produces independently mutable objects', () => {
    const a = createToolDeclaration();
    const b = createToolDeclaration();
    a.arguments_schema.properties.input = { type: 'number' };
    expect(b.arguments_schema.properties.input).toEqual({ type: 'string' });
  });
});

// ---------------------------------------------------------------------------
// createManifest
// ---------------------------------------------------------------------------

describe('createManifest', () => {
  it('produces valid defaults', () => {
    const manifest = createManifest();
    expect(manifest.description).toBe('Test plugin');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.app_compat).toBe('>=0.1.0');
    expect(manifest.author).toEqual({ name: 'Test' });
    expect(manifest.provides.channels).toEqual([]);
    expect(manifest.provides.tools).toHaveLength(1);
    expect(manifest.provides.tools[0].name).toBe('test_tool');
    expect(manifest.subscribes).toEqual([]);
  });

  it('applies overrides to nested author', () => {
    const manifest = createManifest({
      author: { name: 'Custom Author', url: 'https://example.com' },
    });
    expect(manifest.author.name).toBe('Custom Author');
    expect(manifest.author.url).toBe('https://example.com');
  });

  it('applies overrides to tool declarations via provides', () => {
    const manifest = createManifest({
      provides: {
        tools: [
          {
            name: 'send_email',
            description: 'Send an email',
            risk_level: 'high',
            arguments_schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                to: { type: 'string' },
                body: { type: 'string' },
              },
            },
          },
        ],
      },
    });
    expect(manifest.provides.tools).toHaveLength(1);
    expect(manifest.provides.tools[0].name).toBe('send_email');
    expect(manifest.provides.tools[0].risk_level).toBe('high');
  });

  it('applies subscribes override', () => {
    const manifest = createManifest({
      subscribes: ['message.inbound', 'task.created'],
    });
    expect(manifest.subscribes).toEqual(['message.inbound', 'task.created']);
  });

  it('produces independently mutable objects', () => {
    const a = createManifest();
    const b = createManifest();
    a.provides.tools[0].name = 'mutated';
    a.author.name = 'mutated';
    expect(b.provides.tools[0].name).toBe('test_tool');
    expect(b.author.name).toBe('Test');
  });
});

// ---------------------------------------------------------------------------
// createErrorPayload
// ---------------------------------------------------------------------------

describe('createErrorPayload', () => {
  it('produces valid defaults', () => {
    const err = createErrorPayload();
    expect(err.code).toBe(ErrorCode.PLUGIN_ERROR);
    expect(err.message).toBe('An error occurred');
    expect(err.retriable).toBe(false);
  });

  it('has no optional fields by default', () => {
    const err = createErrorPayload();
    expect(err.stage).toBeUndefined();
    expect(err.field).toBeUndefined();
    expect(err.retry_after).toBeUndefined();
  });

  it('applies overrides including optional fields', () => {
    const err = createErrorPayload({
      code: ErrorCode.RATE_LIMITED,
      message: 'Too many requests',
      retriable: true,
      retry_after: 30,
    });
    expect(err.code).toBe(ErrorCode.RATE_LIMITED);
    expect(err.message).toBe('Too many requests');
    expect(err.retriable).toBe(true);
    expect(err.retry_after).toBe(30);
  });

  it('produces independently mutable objects', () => {
    const a = createErrorPayload();
    const b = createErrorPayload();
    a.message = 'mutated';
    expect(b.message).toBe('An error occurred');
  });
});

// ---------------------------------------------------------------------------
// Type safety (compile-time checks documented as comments)
// ---------------------------------------------------------------------------

describe('type safety', () => {
  it('factories return correctly typed objects', () => {
    // These assignments would fail at compile time if the factories
    // returned the wrong types:
    const _wire: import('../types/index.js').WireMessage = createWireMessage();
    const _evt: import('../types/index.js').EventEnvelope = createEventEnvelope();
    const _req: import('../types/index.js').RequestEnvelope = createRequestEnvelope();
    const _res: import('../types/index.js').ResponseEnvelope = createResponseEnvelope();
    const _tool: import('../types/index.js').ToolDeclaration = createToolDeclaration();
    const _manifest: import('../types/index.js').PluginManifest = createManifest();
    const _err: import('../types/index.js').ErrorPayload = createErrorPayload();

    // If this compiles and runs, all types check out.
    expect(_wire).toBeDefined();
    expect(_evt).toBeDefined();
    expect(_req).toBeDefined();
    expect(_res).toBeDefined();
    expect(_tool).toBeDefined();
    expect(_manifest).toBeDefined();
    expect(_err).toBeDefined();
  });

  // Compile-time: the following would be a type error if uncommented:
  // createWireMessage({ nonExistentField: 'oops' });
  //   TS error: Object literal may only specify known properties
  //
  // createErrorPayload({ code: 'NOT_A_REAL_CODE' });
  //   TS error: Type '"NOT_A_REAL_CODE"' is not assignable to type 'ErrorCodeValue'
  //
  // createToolDeclaration({ risk_level: 'medium' });
  //   TS error: Type '"medium"' is not assignable to type '"low" | "high"'
});
