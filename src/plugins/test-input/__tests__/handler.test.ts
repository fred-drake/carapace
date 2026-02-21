import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestInputHandler } from '../handler.js';
import type { ChannelServices } from '../../../core/plugin-handler.js';
import type { EventEnvelope } from '../../../types/protocol.js';
import { ErrorCode } from '../../../types/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockChannelServices(): ChannelServices & {
  publishEvent: ReturnType<typeof vi.fn>;
} {
  return {
    getAuditLog: vi.fn(async () => []),
    getToolCatalog: vi.fn(() => []),
    getSessionInfo: vi.fn(() => ({ group: 'test', sessionId: 'sess-1', startedAt: '' })),
    publishEvent: vi.fn(async () => {}),
  };
}

function makeContext(overrides?: Partial<import('../../../core/plugin-handler.js').PluginContext>) {
  return {
    group: 'test',
    sessionId: 'sess-1',
    correlationId: 'corr-001',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeEventEnvelope(
  topic: string,
  correlation: string | null,
  payload: Record<string, unknown> = {},
): EventEnvelope {
  return {
    id: 'evt-1',
    version: 1,
    type: 'event',
    topic,
    source: 'core',
    correlation,
    timestamp: new Date().toISOString(),
    group: 'test',
    payload,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TestInputHandler', () => {
  let handler: TestInputHandler;
  let services: ReturnType<typeof createMockChannelServices>;

  beforeEach(async () => {
    handler = new TestInputHandler();
    services = createMockChannelServices();
    await handler.initialize(services);
  });

  // -----------------------------------------------------------------------
  // 1. Handler initializes with ChannelServices
  // -----------------------------------------------------------------------

  it('initializes with ChannelServices', async () => {
    const h = new TestInputHandler();
    const svc = createMockChannelServices();
    await h.initialize(svc);
    // Should not throw — initialization stores services reference
    expect(svc).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 2. submit() calls publishEvent with correct message.inbound shape
  // -----------------------------------------------------------------------

  it('submit() calls publishEvent with correct message.inbound shape', async () => {
    await handler.submit('Hello, agent!');

    expect(services.publishEvent).toHaveBeenCalledTimes(1);
    const call = services.publishEvent.mock.calls[0][0];
    expect(call.topic).toBe('message.inbound');
    expect(call.source).toBe('test-input');
    expect(call.payload.channel).toBe('test-input');
    expect(call.payload.sender).toBe('test-harness');
    expect(call.payload.content_type).toBe('text');
    expect(call.payload.body).toBe('Hello, agent!');
  });

  // -----------------------------------------------------------------------
  // 3. submit() returns a correlation ID (UUID)
  // -----------------------------------------------------------------------

  it('submit() returns a correlation ID (UUID)', async () => {
    const correlationId = await handler.submit('test prompt');
    expect(correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  // -----------------------------------------------------------------------
  // 4. submit() uses default group "test" when not specified
  // -----------------------------------------------------------------------

  it('submit() uses default group "test" when not specified', async () => {
    await handler.submit('prompt');

    const call = services.publishEvent.mock.calls[0][0];
    expect(call.group).toBe('test');
  });

  // -----------------------------------------------------------------------
  // 5. submit() uses custom group when provided
  // -----------------------------------------------------------------------

  it('submit() uses custom group when provided', async () => {
    await handler.submit('prompt', { group: 'custom-group' });

    const call = services.publishEvent.mock.calls[0][0];
    expect(call.group).toBe('custom-group');
  });

  // -----------------------------------------------------------------------
  // 6. handleToolInvocation('test_respond') captures response
  // -----------------------------------------------------------------------

  it('handleToolInvocation(test_respond) captures response', async () => {
    const result = await handler.handleToolInvocation(
      'test_respond',
      { body: 'Hello back!' },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.captured).toBe(true);
    }

    const responses = handler.getResponses();
    expect(responses).toHaveLength(1);
    expect(responses[0].body).toBe('Hello back!');
  });

  // -----------------------------------------------------------------------
  // 7. handleToolInvocation('test_respond') correlates to submission
  // -----------------------------------------------------------------------

  it('handleToolInvocation(test_respond) correlates to submission', async () => {
    const corrId = await handler.submit('prompt');

    await handler.handleToolInvocation(
      'test_respond',
      { body: 'response' },
      makeContext({ correlationId: corrId }),
    );

    const responses = handler.getResponses(corrId);
    expect(responses).toHaveLength(1);
    expect(responses[0].correlationId).toBe(corrId);
  });

  // -----------------------------------------------------------------------
  // 8. handleToolInvocation returns error for unknown tool
  // -----------------------------------------------------------------------

  it('handleToolInvocation returns error for unknown tool', async () => {
    const result = await handler.handleToolInvocation('nonexistent_tool', {}, makeContext());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.HANDLER_ERROR);
      expect(result.error.message).toContain('Unknown tool');
      expect(result.error.message).toContain('nonexistent_tool');
    }
  });

  // -----------------------------------------------------------------------
  // 9. waitForResponse resolves when test_respond is called
  // -----------------------------------------------------------------------

  it('waitForResponse resolves when test_respond is called', async () => {
    const corrId = 'corr-wait-1';

    // Start waiting (don't await yet)
    const responsePromise = handler.waitForResponse(corrId, 5000);

    // Simulate agent calling test_respond
    await handler.handleToolInvocation(
      'test_respond',
      { body: 'delayed response' },
      makeContext({ correlationId: corrId }),
    );

    const response = await responsePromise;
    expect(response.correlationId).toBe(corrId);
    expect(response.body).toBe('delayed response');
  });

  // -----------------------------------------------------------------------
  // 10. waitForResponse rejects on timeout
  // -----------------------------------------------------------------------

  it('waitForResponse rejects on timeout', async () => {
    vi.useFakeTimers();
    try {
      const responsePromise = handler.waitForResponse('corr-timeout', 100);
      vi.advanceTimersByTime(200);
      await expect(responsePromise).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 11. getResponses() returns all captured responses
  // -----------------------------------------------------------------------

  it('getResponses() returns all captured responses', async () => {
    await handler.handleToolInvocation(
      'test_respond',
      { body: 'resp-1' },
      makeContext({ correlationId: 'c1' }),
    );
    await handler.handleToolInvocation(
      'test_respond',
      { body: 'resp-2' },
      makeContext({ correlationId: 'c2' }),
    );

    const all = handler.getResponses();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.body)).toEqual(['resp-1', 'resp-2']);
  });

  // -----------------------------------------------------------------------
  // 12. getResponses(correlationId) filters by correlation
  // -----------------------------------------------------------------------

  it('getResponses(correlationId) filters by correlation', async () => {
    await handler.handleToolInvocation(
      'test_respond',
      { body: 'resp-a' },
      makeContext({ correlationId: 'c-a' }),
    );
    await handler.handleToolInvocation(
      'test_respond',
      { body: 'resp-b' },
      makeContext({ correlationId: 'c-b' }),
    );

    const filtered = handler.getResponses('c-a');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].body).toBe('resp-a');
    expect(filtered[0].correlationId).toBe('c-a');
  });

  // -----------------------------------------------------------------------
  // 13. reset() clears all state
  // -----------------------------------------------------------------------

  it('reset() clears all state', async () => {
    await handler.handleToolInvocation('test_respond', { body: 'will be cleared' }, makeContext());
    expect(handler.getResponses()).toHaveLength(1);

    handler.reset();

    expect(handler.getResponses()).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 14. shutdown() cleans up resources
  // -----------------------------------------------------------------------

  it('shutdown() cleans up resources', async () => {
    // Start a waiter that will be rejected on shutdown
    const waitPromise = handler.waitForResponse('corr-shutdown', 60_000);

    await handler.shutdown();

    await expect(waitPromise).rejects.toThrow(/shutting down/i);
  });

  // -----------------------------------------------------------------------
  // 15. handleEvent('agent.completed') resolves pending waiters
  // -----------------------------------------------------------------------

  it('handleEvent(agent.completed) resolves pending waiters', async () => {
    const corrId = 'corr-complete';
    const waitPromise = handler.waitForResponse(corrId, 5000);

    await handler.handleEvent!(makeEventEnvelope('agent.completed', corrId));

    const response = await waitPromise;
    expect(response.correlationId).toBe(corrId);
    // agent.completed without test_respond gives empty body
    expect(response.body).toBe('');
  });

  // -----------------------------------------------------------------------
  // 16. handleEvent('agent.error') rejects pending waiters
  // -----------------------------------------------------------------------

  it('handleEvent(agent.error) rejects pending waiters', async () => {
    const corrId = 'corr-error';
    const waitPromise = handler.waitForResponse(corrId, 5000);

    await handler.handleEvent!(
      makeEventEnvelope('agent.error', corrId, { error: 'Something went wrong' }),
    );

    await expect(waitPromise).rejects.toThrow('Something went wrong');
  });

  // -----------------------------------------------------------------------
  // Additional edge cases
  // -----------------------------------------------------------------------

  it('submit() throws if handler not initialized', async () => {
    const uninitialized = new TestInputHandler();
    await expect(uninitialized.submit('test')).rejects.toThrow(/not initialized/i);
  });

  it('waitForResponse resolves immediately if response already exists', async () => {
    const corrId = 'corr-already';

    // Response arrives first
    await handler.handleToolInvocation(
      'test_respond',
      { body: 'early response' },
      makeContext({ correlationId: corrId }),
    );

    // Then waitForResponse should resolve immediately
    const response = await handler.waitForResponse(corrId);
    expect(response.body).toBe('early response');
  });

  it('submit() includes correlationId in payload metadata', async () => {
    const corrId = await handler.submit('prompt');

    const call = services.publishEvent.mock.calls[0][0];
    expect(call.payload.metadata).toBeDefined();
    expect(call.payload.metadata.correlationId).toBe(corrId);
  });

  it('handleEvent ignores events without correlation', async () => {
    // Should not throw
    await handler.handleEvent!(makeEventEnvelope('agent.completed', null));
  });

  it('reset() rejects pending waiters', async () => {
    const waitPromise = handler.waitForResponse('corr-reset', 60_000);

    handler.reset();

    await expect(waitPromise).rejects.toThrow(/reset/i);
  });
});
