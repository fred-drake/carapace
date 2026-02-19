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
