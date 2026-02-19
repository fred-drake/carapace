import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MessageTracer,
  formatTraceEvent,
  type TraceEvent,
  type TraceEventType,
  type TracerDeps,
  type TraceFilter,
} from './trace.js';
import type { WireMessage, RequestEnvelope, ResponseEnvelope } from './types/protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTracerDeps(overrides?: Partial<TracerDeps>): TracerDeps {
  return {
    output: vi.fn(),
    now: () => '2026-02-19T12:00:00.000Z',
    ...overrides,
  };
}

function createWire(overrides?: Partial<WireMessage>): WireMessage {
  return {
    topic: 'tool.invoke.weather.lookup',
    correlation: 'corr-001',
    arguments: { city: 'Portland' },
    ...overrides,
  };
}

function createEnvelope(overrides?: Partial<RequestEnvelope>): RequestEnvelope {
  return {
    id: 'env-001',
    version: 1,
    type: 'request',
    topic: 'tool.invoke.weather.lookup',
    source: 'session-abc',
    correlation: 'corr-001',
    timestamp: '2026-02-19T12:00:00.000Z',
    group: 'default',
    payload: { arguments: { city: 'Portland' } },
    ...overrides,
  };
}

function createResponse(overrides?: Partial<ResponseEnvelope>): ResponseEnvelope {
  return {
    id: 'resp-001',
    version: 1,
    type: 'response',
    topic: 'tool.invoke.weather.lookup',
    source: 'core',
    correlation: 'corr-001',
    timestamp: '2026-02-19T12:00:00.500Z',
    group: 'default',
    payload: { result: { temp: 72 }, error: null },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TraceEvent types
// ---------------------------------------------------------------------------

describe('TraceEventType', () => {
  it('includes wire_received', () => {
    const type: TraceEventType = 'wire_received';
    expect(type).toBe('wire_received');
  });

  it('includes envelope_constructed', () => {
    const type: TraceEventType = 'envelope_constructed';
    expect(type).toBe('envelope_constructed');
  });

  it('includes stage_passed', () => {
    const type: TraceEventType = 'stage_passed';
    expect(type).toBe('stage_passed');
  });

  it('includes stage_rejected', () => {
    const type: TraceEventType = 'stage_rejected';
    expect(type).toBe('stage_rejected');
  });

  it('includes dispatched', () => {
    const type: TraceEventType = 'dispatched';
    expect(type).toBe('dispatched');
  });

  it('includes response_sent', () => {
    const type: TraceEventType = 'response_sent';
    expect(type).toBe('response_sent');
  });
});

// ---------------------------------------------------------------------------
// MessageTracer — basic tracing
// ---------------------------------------------------------------------------

describe('MessageTracer', () => {
  let deps: TracerDeps;
  let tracer: MessageTracer;

  beforeEach(() => {
    deps = createTracerDeps();
    tracer = new MessageTracer(deps);
  });

  it('traces wire_received events', () => {
    const wire = createWire();
    tracer.traceWireReceived(wire);

    expect(deps.output).toHaveBeenCalledTimes(1);
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('wire_received');
    expect(output).toContain('tool.invoke.weather.lookup');
  });

  it('traces envelope_constructed events', () => {
    const envelope = createEnvelope();
    tracer.traceEnvelopeConstructed(envelope);

    expect(deps.output).toHaveBeenCalledTimes(1);
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('envelope_constructed');
    expect(output).toContain('env-001');
  });

  it('traces stage_passed events', () => {
    tracer.traceStagePassed('stage-2-topic', 'tool.invoke.weather.lookup');

    expect(deps.output).toHaveBeenCalledTimes(1);
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('stage_passed');
    expect(output).toContain('stage-2-topic');
  });

  it('traces stage_rejected events', () => {
    tracer.traceStageRejected('stage-4-authorize', 'UNAUTHORIZED', 'Group not allowed');

    expect(deps.output).toHaveBeenCalledTimes(1);
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('stage_rejected');
    expect(output).toContain('UNAUTHORIZED');
  });

  it('traces dispatched events', () => {
    tracer.traceDispatched('weather.lookup', 'corr-001');

    expect(deps.output).toHaveBeenCalledTimes(1);
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('dispatched');
    expect(output).toContain('weather.lookup');
  });

  it('traces response_sent events', () => {
    const response = createResponse();
    tracer.traceResponseSent(response);

    expect(deps.output).toHaveBeenCalledTimes(1);
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('response_sent');
    expect(output).toContain('corr-001');
  });

  it('includes timestamps from deps.now()', () => {
    const wire = createWire();
    tracer.traceWireReceived(wire);

    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('12:00:00.000');
  });

  it('does nothing when disabled', () => {
    tracer.setEnabled(false);
    tracer.traceWireReceived(createWire());

    expect(deps.output).not.toHaveBeenCalled();
  });

  it('resumes tracing when re-enabled', () => {
    tracer.setEnabled(false);
    tracer.traceWireReceived(createWire());
    tracer.setEnabled(true);
    tracer.traceWireReceived(createWire());

    expect(deps.output).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// MessageTracer — credential redaction
// ---------------------------------------------------------------------------

describe('MessageTracer — credential redaction', () => {
  let deps: TracerDeps;
  let tracer: MessageTracer;

  beforeEach(() => {
    deps = createTracerDeps();
    tracer = new MessageTracer(deps);
  });

  it('redacts Bearer tokens in wire arguments', () => {
    const wire = createWire({
      arguments: { auth: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123' },
    });
    tracer.traceWireReceived(wire);

    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('redacts GitHub tokens in wire arguments', () => {
    const wire = createWire({
      arguments: { token: 'ghp_ABCDEFghijklmnopqrstuvwxyz1234567890' },
    });
    tracer.traceWireReceived(wire);

    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('ghp_ABCDEFghijklmnopqrstuvwxyz1234567890');
  });

  it('redacts API keys (sk- prefix) in wire arguments', () => {
    const wire = createWire({
      arguments: { key: 'sk-ABCDEFghijklmnop' },
    });
    tracer.traceWireReceived(wire);

    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('sk-ABCDEFghijklmnop');
  });

  it('redacts connection strings in response payloads', () => {
    const response = createResponse({
      payload: {
        result: { dsn: 'postgres://user:pass@host:5432/db' },
        error: null,
      },
    });
    tracer.traceResponseSent(response);

    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('postgres://user:pass@host:5432/db');
  });

  it('redacts AWS access key IDs', () => {
    const wire = createWire({
      arguments: { aws_key: 'AKIAIOSFODNN7EXAMPLE' },
    });
    tracer.traceWireReceived(wire);

    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts private key blocks', () => {
    const wire = createWire({
      arguments: { key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...' },
    });
    tracer.traceWireReceived(wire);

    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('MIIEvQIBADANBg');
  });

  it('does not redact non-sensitive values', () => {
    const wire = createWire({ arguments: { city: 'Portland', count: '5' } });
    tracer.traceWireReceived(wire);

    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('Portland');
    expect(output).toContain('5');
  });
});

// ---------------------------------------------------------------------------
// MessageTracer — topic filtering
// ---------------------------------------------------------------------------

describe('MessageTracer — topic filtering', () => {
  let deps: TracerDeps;

  beforeEach(() => {
    deps = createTracerDeps();
  });

  it('shows all events when no filter is set', () => {
    const tracer = new MessageTracer(deps);
    tracer.traceWireReceived(createWire({ topic: 'tool.invoke.weather.lookup' }));
    tracer.traceWireReceived(createWire({ topic: 'agent.started' }));

    expect(deps.output).toHaveBeenCalledTimes(2);
  });

  it('filters by exact topic', () => {
    const filter: TraceFilter = { topics: ['agent.started'] };
    const tracer = new MessageTracer(deps, filter);

    tracer.traceWireReceived(createWire({ topic: 'tool.invoke.weather.lookup' }));
    tracer.traceWireReceived(createWire({ topic: 'agent.started' }));

    expect(deps.output).toHaveBeenCalledTimes(1);
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('agent.started');
  });

  it('filters by topic prefix (tool.invoke.*)', () => {
    const filter: TraceFilter = { topics: ['tool.invoke.*'] };
    const tracer = new MessageTracer(deps, filter);

    tracer.traceWireReceived(createWire({ topic: 'tool.invoke.weather.lookup' }));
    tracer.traceWireReceived(createWire({ topic: 'agent.started' }));

    expect(deps.output).toHaveBeenCalledTimes(1);
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('tool.invoke.weather.lookup');
  });

  it('accepts multiple topic filters (OR logic)', () => {
    const filter: TraceFilter = { topics: ['agent.started', 'agent.completed'] };
    const tracer = new MessageTracer(deps, filter);

    tracer.traceWireReceived(createWire({ topic: 'agent.started' }));
    tracer.traceWireReceived(createWire({ topic: 'agent.completed' }));
    tracer.traceWireReceived(createWire({ topic: 'tool.invoke.weather.lookup' }));

    expect(deps.output).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// MessageTracer — plugin filtering
// ---------------------------------------------------------------------------

describe('MessageTracer — plugin filtering', () => {
  let deps: TracerDeps;

  beforeEach(() => {
    deps = createTracerDeps();
  });

  it('filters by plugin name from tool topic', () => {
    const filter: TraceFilter = { plugins: ['weather'] };
    const tracer = new MessageTracer(deps, filter);

    tracer.traceDispatched('weather.lookup', 'corr-001');
    tracer.traceDispatched('calendar.create', 'corr-002');

    expect(deps.output).toHaveBeenCalledTimes(1);
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('weather.lookup');
  });

  it('accepts multiple plugin filters (OR logic)', () => {
    const filter: TraceFilter = { plugins: ['weather', 'calendar'] };
    const tracer = new MessageTracer(deps, filter);

    tracer.traceDispatched('weather.lookup', 'corr-001');
    tracer.traceDispatched('calendar.create', 'corr-002');
    tracer.traceDispatched('email.send', 'corr-003');

    expect(deps.output).toHaveBeenCalledTimes(2);
  });

  it('passes events without plugin context when no plugin filter', () => {
    const filter: TraceFilter = { topics: ['agent.started'] };
    const tracer = new MessageTracer(deps, filter);

    tracer.traceWireReceived(createWire({ topic: 'agent.started' }));

    expect(deps.output).toHaveBeenCalledTimes(1);
  });

  it('passes non-tool events through plugin filter (no plugin to filter on)', () => {
    const filter: TraceFilter = { plugins: ['weather'] };
    const tracer = new MessageTracer(deps, filter);

    // Stage events without an associated tool should pass through plugin filter
    tracer.traceStagePassed('stage-1-construct', 'tool.invoke.weather.lookup');

    expect(deps.output).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// MessageTracer — combined topic + plugin filtering
// ---------------------------------------------------------------------------

describe('MessageTracer — combined filtering', () => {
  let deps: TracerDeps;

  beforeEach(() => {
    deps = createTracerDeps();
  });

  it('requires both topic AND plugin filters to match when both are set', () => {
    const filter: TraceFilter = {
      topics: ['tool.invoke.*'],
      plugins: ['weather'],
    };
    const tracer = new MessageTracer(deps, filter);

    // Matches both: tool.invoke.* topic AND weather plugin
    tracer.traceWireReceived(createWire({ topic: 'tool.invoke.weather.lookup' }));
    // Matches topic but not plugin
    tracer.traceWireReceived(createWire({ topic: 'tool.invoke.calendar.create' }));
    // Matches neither
    tracer.traceWireReceived(createWire({ topic: 'agent.started' }));

    expect(deps.output).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// formatTraceEvent — pretty printing
// ---------------------------------------------------------------------------

describe('formatTraceEvent', () => {
  it('includes the timestamp', () => {
    const event: TraceEvent = {
      type: 'wire_received',
      timestamp: '2026-02-19T12:00:00.000Z',
      topic: 'tool.invoke.weather.lookup',
      data: { correlation: 'corr-001', arguments: { city: 'Portland' } },
    };

    const formatted = formatTraceEvent(event);
    expect(formatted).toContain('12:00:00.000');
  });

  it('includes the event type', () => {
    const event: TraceEvent = {
      type: 'dispatched',
      timestamp: '2026-02-19T12:00:00.000Z',
      topic: 'tool.invoke.weather.lookup',
      data: { tool: 'weather.lookup', correlation: 'corr-001' },
    };

    const formatted = formatTraceEvent(event);
    expect(formatted).toContain('dispatched');
  });

  it('includes the topic', () => {
    const event: TraceEvent = {
      type: 'wire_received',
      timestamp: '2026-02-19T12:00:00.000Z',
      topic: 'tool.invoke.weather.lookup',
      data: { correlation: 'corr-001', arguments: {} },
    };

    const formatted = formatTraceEvent(event);
    expect(formatted).toContain('tool.invoke.weather.lookup');
  });

  it('pretty-prints data as indented JSON', () => {
    const event: TraceEvent = {
      type: 'wire_received',
      timestamp: '2026-02-19T12:00:00.000Z',
      topic: 'tool.invoke.weather.lookup',
      data: { correlation: 'corr-001', arguments: { city: 'Portland' } },
    };

    const formatted = formatTraceEvent(event);
    // Should have indented JSON (multi-line)
    expect(formatted).toContain('Portland');
    expect(formatted.split('\n').length).toBeGreaterThan(1);
  });

  it('uses color-coded labels for different event types', () => {
    const wireEvent: TraceEvent = {
      type: 'wire_received',
      timestamp: '2026-02-19T12:00:00.000Z',
      topic: 'test',
      data: {},
    };
    const rejectEvent: TraceEvent = {
      type: 'stage_rejected',
      timestamp: '2026-02-19T12:00:00.000Z',
      topic: 'test',
      data: { stage: 'stage-4-authorize', code: 'UNAUTHORIZED' },
    };

    const wireFormatted = formatTraceEvent(wireEvent);
    const rejectFormatted = formatTraceEvent(rejectEvent);

    // Different event types should have different labels
    expect(wireFormatted).not.toBe(rejectFormatted);
  });

  it('shows error info for stage_rejected events', () => {
    const event: TraceEvent = {
      type: 'stage_rejected',
      timestamp: '2026-02-19T12:00:00.000Z',
      topic: 'tool.invoke.weather.lookup',
      data: {
        stage: 'stage-4-authorize',
        code: 'UNAUTHORIZED',
        message: 'Group not allowed',
      },
    };

    const formatted = formatTraceEvent(event);
    expect(formatted).toContain('UNAUTHORIZED');
    expect(formatted).toContain('Group not allowed');
  });

  it('shows response status (success vs error)', () => {
    const successEvent: TraceEvent = {
      type: 'response_sent',
      timestamp: '2026-02-19T12:00:00.000Z',
      topic: 'tool.invoke.weather.lookup',
      data: { correlation: 'corr-001', hasError: false },
    };
    const errorEvent: TraceEvent = {
      type: 'response_sent',
      timestamp: '2026-02-19T12:00:00.000Z',
      topic: 'tool.invoke.weather.lookup',
      data: { correlation: 'corr-001', hasError: true, errorCode: 'PLUGIN_ERROR' },
    };

    const successFormatted = formatTraceEvent(successEvent);
    const errorFormatted = formatTraceEvent(errorEvent);

    expect(successFormatted).toContain('OK');
    expect(errorFormatted).toContain('PLUGIN_ERROR');
  });
});
