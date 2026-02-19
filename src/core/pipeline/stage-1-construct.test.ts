import { describe, it, expect } from 'vitest';
import { stage1Construct } from './stage-1-construct.js';
import { PROTOCOL_VERSION } from '../../types/protocol.js';
import { createWireMessage } from '../../testing/factories.js';
import type { PipelineContext } from './types.js';
import type { SessionContext } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeSession(overrides?: Partial<SessionContext>): SessionContext {
  return {
    sessionId: 'sess-001',
    group: 'test-group',
    source: 'agent-test',
    startedAt: '2026-02-18T10:00:00Z',
    ...overrides,
  };
}

function makeContext(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    wire: createWireMessage(),
    session: makeSession(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Stage 1: Construct envelope', () => {
  it('returns a PipelineContext with envelope set', () => {
    const ctx = makeContext();
    const result = stage1Construct.execute(ctx);

    // Should be a PipelineContext (not a PipelineResult)
    expect(result).not.toHaveProperty('ok');
    expect(result).toHaveProperty('envelope');
  });

  it('constructs envelope with correct fields from wire + session', () => {
    const wire = createWireMessage({
      topic: 'tool.invoke.create_reminder',
      correlation: 'corr-123',
      arguments: { title: 'Buy milk' },
    });
    const session = makeSession({
      source: 'telegram-agent',
      group: 'family-chat',
    });

    const result = stage1Construct.execute({ wire, session });

    // Should be a PipelineContext
    expect(result).toHaveProperty('envelope');
    const envelope = (result as PipelineContext).envelope!;

    expect(envelope.topic).toBe('tool.invoke.create_reminder');
    expect(envelope.correlation).toBe('corr-123');
    expect(envelope.source).toBe('telegram-agent');
    expect(envelope.group).toBe('family-chat');
    expect(envelope.payload.arguments).toEqual({ input: 'test', title: 'Buy milk' });
  });

  it('id is a UUID', () => {
    const result = stage1Construct.execute(makeContext());
    const envelope = (result as PipelineContext).envelope!;

    expect(envelope.id).toMatch(UUID_REGEX);
  });

  it('version matches PROTOCOL_VERSION', () => {
    const result = stage1Construct.execute(makeContext());
    const envelope = (result as PipelineContext).envelope!;

    expect(envelope.version).toBe(PROTOCOL_VERSION);
  });

  it('type is "request"', () => {
    const result = stage1Construct.execute(makeContext());
    const envelope = (result as PipelineContext).envelope!;

    expect(envelope.type).toBe('request');
  });

  it('source comes from session, not wire', () => {
    const wire = createWireMessage();
    const session = makeSession({ source: 'my-agent-source' });

    const result = stage1Construct.execute({ wire, session });
    const envelope = (result as PipelineContext).envelope!;

    expect(envelope.source).toBe('my-agent-source');
  });

  it('group comes from session', () => {
    const wire = createWireMessage();
    const session = makeSession({ group: 'my-group' });

    const result = stage1Construct.execute({ wire, session });
    const envelope = (result as PipelineContext).envelope!;

    expect(envelope.group).toBe('my-group');
  });

  it('correlation comes from wire', () => {
    const wire = createWireMessage({ correlation: 'wire-corr-42' });
    const session = makeSession();

    const result = stage1Construct.execute({ wire, session });
    const envelope = (result as PipelineContext).envelope!;

    expect(envelope.correlation).toBe('wire-corr-42');
  });

  it('topic comes from wire', () => {
    const wire = createWireMessage({ topic: 'tool.invoke.send_email' });
    const session = makeSession();

    const result = stage1Construct.execute({ wire, session });
    const envelope = (result as PipelineContext).envelope!;

    expect(envelope.topic).toBe('tool.invoke.send_email');
  });

  it('timestamp is a valid ISO string', () => {
    const result = stage1Construct.execute(makeContext());
    const envelope = (result as PipelineContext).envelope!;

    const parsed = Date.parse(envelope.timestamp);
    expect(Number.isNaN(parsed)).toBe(false);
  });

  it('has stage name "construct"', () => {
    expect(stage1Construct.name).toBe('construct');
  });
});
