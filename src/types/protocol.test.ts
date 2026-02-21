import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  WIRE_FIELDS,
  ENVELOPE_IDENTITY_FIELDS,
  type Topic,
  type MessageType,
  type WireMessage,
  type BaseEnvelope,
  type EventEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope,
  type Envelope,
  type EventPayload,
  type RequestPayload,
  type ResponsePayload,
  type ResponseEventBase,
  type SystemEventPayload,
  type ChunkEventPayload,
  type ToolCallEventPayload,
  type ToolResultEventPayload,
  type EndEventPayload,
  type ErrorEventPayload,
} from './protocol.js';

// ---------------------------------------------------------------------------
// Helpers: compile-time type assertions
// ---------------------------------------------------------------------------

function assertType<_T>() {}
function assertAssignable<_A extends _B, _B>() {}

// ---------------------------------------------------------------------------
// PROTOCOL_VERSION
// ---------------------------------------------------------------------------

describe('PROTOCOL_VERSION', () => {
  it('equals 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// WIRE_FIELDS / ENVELOPE_IDENTITY_FIELDS
// ---------------------------------------------------------------------------

describe('WIRE_FIELDS and ENVELOPE_IDENTITY_FIELDS', () => {
  it('have zero overlap', () => {
    const wireSet = new Set<string>(WIRE_FIELDS);
    const envelopeSet = new Set<string>(ENVELOPE_IDENTITY_FIELDS);

    for (const field of wireSet) {
      expect(envelopeSet.has(field)).toBe(false);
    }
    for (const field of envelopeSet) {
      expect(wireSet.has(field)).toBe(false);
    }
  });

  it('WIRE_FIELDS contains exactly 3 fields', () => {
    expect(WIRE_FIELDS).toHaveLength(3);
    expect([...WIRE_FIELDS]).toEqual(['topic', 'correlation', 'arguments']);
  });

  it('ENVELOPE_IDENTITY_FIELDS contains exactly 6 fields', () => {
    expect(ENVELOPE_IDENTITY_FIELDS).toHaveLength(6);
    expect([...ENVELOPE_IDENTITY_FIELDS]).toEqual([
      'id',
      'version',
      'type',
      'source',
      'group',
      'timestamp',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Topic type
// ---------------------------------------------------------------------------

describe('Topic type', () => {
  it('accepts all fixed topic string literals', () => {
    const topics: Topic[] = [
      'message.inbound',
      'agent.started',
      'agent.completed',
      'agent.error',
      'task.created',
      'task.triggered',
      'plugin.ready',
      'plugin.stopping',
    ];
    expect(topics).toHaveLength(8);
  });

  it('accepts response.* topic string literals', () => {
    const topics: Topic[] = [
      'response.system',
      'response.chunk',
      'response.tool_call',
      'response.tool_result',
      'response.end',
      'response.error',
    ];
    expect(topics).toHaveLength(6);
  });

  it('accepts tool.invoke.* template literal topics', () => {
    const topics: Topic[] = [
      'tool.invoke.create_reminder',
      'tool.invoke.send_telegram',
      'tool.invoke.send_email',
    ];
    expect(topics).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// WireMessage
// ---------------------------------------------------------------------------

describe('WireMessage', () => {
  it('has exactly the 3 expected fields', () => {
    const wire: WireMessage = {
      topic: 'tool.invoke.create_reminder',
      correlation: 'abc-123',
      arguments: { title: 'Test' },
    };

    const keys = Object.keys(wire);
    expect(keys).toHaveLength(3);
    expect(keys.sort()).toEqual(['arguments', 'correlation', 'topic']);
  });
});

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

describe('Envelope types', () => {
  it('EventEnvelope has type "event" and EventPayload', () => {
    const envelope: EventEnvelope = {
      id: 'evt-1',
      version: 1,
      type: 'event',
      topic: 'message.inbound',
      source: 'telegram',
      correlation: null,
      timestamp: '2026-02-17T10:30:00Z',
      group: 'family-chat',
      payload: { channel: 'telegram', body: 'Hello' },
    };

    expect(envelope.type).toBe('event');
    expect(envelope.correlation).toBeNull();
  });

  it('RequestEnvelope has type "request" and non-null correlation', () => {
    const envelope: RequestEnvelope = {
      id: 'req-1',
      version: 1,
      type: 'request',
      topic: 'tool.invoke.create_reminder',
      source: 'agent-session-abc',
      correlation: 'corr-123',
      timestamp: '2026-02-17T10:30:05Z',
      group: 'family-chat',
      payload: {
        arguments: { title: 'Test', due: '2026-02-17T17:00:00Z' },
      },
    };

    expect(envelope.type).toBe('request');
    expect(envelope.correlation).toBe('corr-123');
    // Compile-time proof that correlation is string (not string | null):
    const _corrStr: string = envelope.correlation;
    expect(_corrStr).toBeDefined();
  });

  it('ResponseEnvelope has type "response" and non-null correlation', () => {
    const envelope: ResponseEnvelope = {
      id: 'res-1',
      version: 1,
      type: 'response',
      topic: 'tool.invoke.create_reminder',
      source: 'reminders',
      correlation: 'corr-123',
      timestamp: '2026-02-17T10:30:06Z',
      group: 'family-chat',
      payload: {
        result: { reminder_id: 'R-12345', status: 'created' },
        error: null,
      },
    };

    expect(envelope.type).toBe('response');
    expect(envelope.correlation).toBe('corr-123');
    // Compile-time proof that correlation is string (not string | null):
    const _corrStr: string = envelope.correlation;
    expect(_corrStr).toBeDefined();
  });

  it('Envelope is a discriminated union of all three types', () => {
    assertAssignable<EventEnvelope, Envelope>();
    assertAssignable<RequestEnvelope, Envelope>();
    assertAssignable<ResponseEnvelope, Envelope>();
  });

  it('MessageType covers event, request, and response', () => {
    const types: MessageType[] = ['event', 'request', 'response'];
    expect(types).toHaveLength(3);
  });

  it('BaseEnvelope is generic over MessageType and payload', () => {
    type Custom = BaseEnvelope<'event', { custom: true }>;
    const msg: Custom = {
      id: 'c-1',
      version: 1,
      type: 'event',
      topic: 'agent.started',
      source: 'core',
      correlation: null,
      timestamp: '2026-02-17T10:00:00Z',
      group: 'main',
      payload: { custom: true },
    };
    expect(msg.payload.custom).toBe(true);
  });

  it('payload types are correctly shaped', () => {
    const ep: EventPayload = { anything: 'goes' };
    expect(ep).toBeDefined();

    const rp: RequestPayload = { arguments: { key: 'value' } };
    expect(rp.arguments).toBeDefined();

    const sp: ResponsePayload = { result: { ok: true }, error: null };
    expect(sp.result).toBeDefined();
    expect(sp.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Response stream event payloads
// ---------------------------------------------------------------------------

describe('Response stream event payloads', () => {
  it('ResponseEventBase requires raw and seq', () => {
    const base: ResponseEventBase = {
      raw: { type: 'system', session_id: 'sess-1' },
      seq: 0,
    };
    expect(base.raw).toEqual({ type: 'system', session_id: 'sess-1' });
    expect(base.seq).toBe(0);
  });

  it('SystemEventPayload has claudeSessionId and optional model', () => {
    const withModel: SystemEventPayload = {
      raw: { type: 'system' },
      seq: 1,
      claudeSessionId: 'sess-abc',
      model: 'claude-sonnet-4-6',
    };
    expect(withModel.claudeSessionId).toBe('sess-abc');
    expect(withModel.model).toBe('claude-sonnet-4-6');

    const withoutModel: SystemEventPayload = {
      raw: { type: 'system' },
      seq: 1,
      claudeSessionId: 'sess-abc',
    };
    expect(withoutModel.model).toBeUndefined();
  });

  it('ChunkEventPayload has text', () => {
    const chunk: ChunkEventPayload = {
      raw: { type: 'assistant', content: 'hello' },
      seq: 2,
      text: 'hello',
    };
    expect(chunk.text).toBe('hello');
  });

  it('ToolCallEventPayload has toolName and toolInput', () => {
    const call: ToolCallEventPayload = {
      raw: { type: 'tool_use', name: 'create_reminder' },
      seq: 3,
      toolName: 'create_reminder',
      toolInput: { title: 'Test', due: '2026-03-01' },
    };
    expect(call.toolName).toBe('create_reminder');
    expect(call.toolInput).toEqual({ title: 'Test', due: '2026-03-01' });
  });

  it('ToolResultEventPayload has metadata only (no payload content)', () => {
    const resultWithDuration: ToolResultEventPayload = {
      raw: { type: 'tool_result' },
      seq: 4,
      toolName: 'create_reminder',
      success: true,
      durationMs: 150,
    };
    expect(resultWithDuration.toolName).toBe('create_reminder');
    expect(resultWithDuration.success).toBe(true);
    expect(resultWithDuration.durationMs).toBe(150);

    const resultWithoutDuration: ToolResultEventPayload = {
      raw: { type: 'tool_result' },
      seq: 5,
      toolName: 'send_email',
      success: false,
    };
    expect(resultWithoutDuration.durationMs).toBeUndefined();
  });

  it('EndEventPayload has exitCode and optional usage/cost', () => {
    const full: EndEventPayload = {
      raw: { type: 'result' },
      seq: 10,
      claudeSessionId: 'sess-abc',
      exitCode: 0,
      usage: { inputTokens: 1500, outputTokens: 800 },
      cost: { totalUsd: 0.012 },
    };
    expect(full.claudeSessionId).toBe('sess-abc');
    expect(full.exitCode).toBe(0);
    expect(full.usage?.inputTokens).toBe(1500);
    expect(full.cost?.totalUsd).toBe(0.012);

    const minimal: EndEventPayload = {
      raw: { type: 'result' },
      seq: 11,
      claudeSessionId: 'sess-def',
      exitCode: 1,
    };
    expect(minimal.usage).toBeUndefined();
    expect(minimal.cost).toBeUndefined();
  });

  it('ErrorEventPayload has reason', () => {
    const err: ErrorEventPayload = {
      raw: { type: 'error', message: 'rate limited' },
      seq: 6,
      reason: 'rate limited',
    };
    expect(err.reason).toBe('rate limited');
  });

  it('all payload types extend ResponseEventBase', () => {
    assertAssignable<SystemEventPayload, ResponseEventBase>();
    assertAssignable<ChunkEventPayload, ResponseEventBase>();
    assertAssignable<ToolCallEventPayload, ResponseEventBase>();
    assertAssignable<ToolResultEventPayload, ResponseEventBase>();
    assertAssignable<EndEventPayload, ResponseEventBase>();
    assertAssignable<ErrorEventPayload, ResponseEventBase>();
  });
});
