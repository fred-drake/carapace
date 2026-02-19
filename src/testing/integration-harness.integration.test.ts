/**
 * Integration test harness tests.
 *
 * Validates the IntegrationHarness by exercising it against the real
 * MessageRouter, RequestChannel, EventBus, and pipeline stages using
 * fake (in-memory) ZeroMQ sockets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IntegrationHarness } from './integration-harness.js';
import { ErrorCode } from '../types/errors.js';
import type { EventEnvelope } from '../types/protocol.js';

describe('IntegrationHarness', () => {
  let harness: IntegrationHarness;

  beforeEach(async () => {
    harness = await IntegrationHarness.create();
  });

  afterEach(async () => {
    await harness.close();
  });

  // -------------------------------------------------------------------------
  // Setup & teardown
  // -------------------------------------------------------------------------

  describe('setup and teardown', () => {
    it('creates without error', () => {
      expect(harness).toBeDefined();
    });

    it('close() is idempotent', async () => {
      await harness.close();
      await expect(harness.close()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Plugin registration
  // -------------------------------------------------------------------------

  describe('plugin registration', () => {
    it('registers a tool with a handler', () => {
      harness.registerTool(
        {
          name: 'echo',
          description: 'Echo tool',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string' } },
          },
        },
        async (envelope) => {
          const args = envelope.payload.arguments as Record<string, unknown>;
          return { echoed: args['text'] };
        },
      );

      expect(harness.getRegisteredTools()).toContain('echo');
    });

    it('registers multiple tools', () => {
      harness.registerTool(
        {
          name: 'tool_a',
          description: 'Tool A',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
        async () => ({ result: 'a' }),
      );

      harness.registerTool(
        {
          name: 'tool_b',
          description: 'Tool B',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
        async () => ({ result: 'b' }),
      );

      expect(harness.getRegisteredTools()).toEqual(['tool_a', 'tool_b']);
    });
  });

  // -------------------------------------------------------------------------
  // Session simulation
  // -------------------------------------------------------------------------

  describe('session simulation', () => {
    it('creates a session with group and container ID', () => {
      const session = harness.createSession({ group: 'email' });

      expect(session.sessionId).toBeTruthy();
      expect(session.group).toBe('email');
      expect(session.containerId).toBeTruthy();
      expect(session.connectionIdentity).toBeTruthy();
    });

    it('creates sessions with unique IDs', () => {
      const s1 = harness.createSession({ group: 'email' });
      const s2 = harness.createSession({ group: 'slack' });

      expect(s1.sessionId).not.toBe(s2.sessionId);
      expect(s1.containerId).not.toBe(s2.containerId);
    });
  });

  // -------------------------------------------------------------------------
  // Full 6-stage pipeline (request → response)
  // -------------------------------------------------------------------------

  describe('full pipeline traversal', () => {
    beforeEach(() => {
      harness.registerTool(
        {
          name: 'greet',
          description: 'Greet tool',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
          },
        },
        async (envelope) => {
          const args = envelope.payload.arguments as Record<string, unknown>;
          return { greeting: `Hello, ${args['name']}!` };
        },
      );
    });

    it('routes a valid request through all 6 stages and returns success', async () => {
      const session = harness.createSession({ group: 'test' });
      const response = await harness.sendRequest(session, 'greet', { name: 'World' });

      expect(response.type).toBe('response');
      expect(response.payload.error).toBeNull();
      expect(response.payload.result).toEqual({ greeting: 'Hello, World!' });
    });

    it('preserves correlation ID through the pipeline', async () => {
      const session = harness.createSession({ group: 'test' });
      const response = await harness.sendRequest(
        session,
        'greet',
        { name: 'A' },
        {
          correlationId: 'my-corr-123',
        },
      );

      expect(response.correlation).toBe('my-corr-123');
    });

    it('sets correct envelope identity fields from session', async () => {
      const session = harness.createSession({ group: 'email' });
      const response = await harness.sendRequest(session, 'greet', { name: 'Test' });

      expect(response.group).toBe('email');
      expect(response.version).toBe(1);
      expect(response.type).toBe('response');
    });
  });

  // -------------------------------------------------------------------------
  // Pipeline rejection (stages 2-5)
  // -------------------------------------------------------------------------

  describe('pipeline rejection', () => {
    beforeEach(() => {
      harness.registerTool(
        {
          name: 'greet',
          description: 'Greet tool',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
          },
        },
        async (envelope) => {
          const args = envelope.payload.arguments as Record<string, unknown>;
          return { greeting: `Hello, ${args['name']}!` };
        },
      );
    });

    it('rejects unknown tool with UNKNOWN_TOOL', async () => {
      const session = harness.createSession({ group: 'test' });
      const response = await harness.sendRequest(session, 'nonexistent', {});

      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.UNKNOWN_TOOL);
    });

    it('rejects invalid arguments with VALIDATION_FAILED', async () => {
      const session = harness.createSession({ group: 'test' });
      // Missing required 'name' field
      const response = await harness.sendRequest(session, 'greet', {});

      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('rejects extra properties with VALIDATION_FAILED', async () => {
      const session = harness.createSession({ group: 'test' });
      const response = await harness.sendRequest(session, 'greet', {
        name: 'Test',
        extra: 'not-allowed',
      });

      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.VALIDATION_FAILED);
    });
  });

  // -------------------------------------------------------------------------
  // Stage 4: Authorization
  // -------------------------------------------------------------------------

  describe('group authorization', () => {
    beforeEach(() => {
      harness.registerTool(
        {
          name: 'private_tool',
          description: 'Private tool',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
        async () => ({ result: 'ok' }),
      );

      harness.setToolGroupRestriction('private_tool', ['email']);
    });

    it('allows authorized group', async () => {
      const session = harness.createSession({ group: 'email' });
      const response = await harness.sendRequest(session, 'private_tool', {});

      expect(response.payload.error).toBeNull();
      expect(response.payload.result).toEqual({ result: 'ok' });
    });

    it('rejects unauthorized group with UNAUTHORIZED', async () => {
      const session = harness.createSession({ group: 'slack' });
      const response = await harness.sendRequest(session, 'private_tool', {});

      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.UNAUTHORIZED);
    });
  });

  // -------------------------------------------------------------------------
  // Stage 4: Rate limiting
  // -------------------------------------------------------------------------

  describe('rate limiting', () => {
    beforeEach(() => {
      harness.registerTool(
        {
          name: 'limited_tool',
          description: 'Limited tool',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
        async () => ({ result: 'ok' }),
      );
    });

    it('allows requests within rate limit', async () => {
      const session = harness.createSession({ group: 'test' });
      const response = await harness.sendRequest(session, 'limited_tool', {});

      expect(response.payload.error).toBeNull();
    });

    it('throttles requests exceeding rate limit', async () => {
      harness.setRateLimit({ requestsPerMinute: 2, burstSize: 2 });
      const session = harness.createSession({ group: 'test' });

      // Use up the burst
      await harness.sendRequest(session, 'limited_tool', {});
      await harness.sendRequest(session, 'limited_tool', {});

      // Third request should be throttled
      const response = await harness.sendRequest(session, 'limited_tool', {});

      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.RATE_LIMITED);
      expect(response.payload.error!.retry_after).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Stage 5: High-risk confirmation
  // -------------------------------------------------------------------------

  describe('high-risk tool confirmation', () => {
    beforeEach(() => {
      harness.registerTool(
        {
          name: 'dangerous_tool',
          description: 'A dangerous tool',
          risk_level: 'high',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
        async () => ({ result: 'executed' }),
      );
    });

    it('rejects high-risk tool without pre-approval', async () => {
      const session = harness.createSession({ group: 'test' });
      const response = await harness.sendRequest(session, 'dangerous_tool', {});

      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.CONFIRMATION_TIMEOUT);
    });

    it('allows high-risk tool with pre-approval', async () => {
      const session = harness.createSession({ group: 'test' });
      const correlationId = 'approved-corr-1';

      harness.preApproveCorrelation(correlationId);
      const response = await harness.sendRequest(
        session,
        'dangerous_tool',
        {},
        {
          correlationId,
        },
      );

      expect(response.payload.error).toBeNull();
      expect(response.payload.result).toEqual({ result: 'executed' });
    });
  });

  // -------------------------------------------------------------------------
  // Handler errors
  // -------------------------------------------------------------------------

  describe('handler errors', () => {
    it('wraps handler exceptions in PLUGIN_ERROR', async () => {
      harness.registerTool(
        {
          name: 'failing_tool',
          description: 'A failing tool',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
        async () => {
          throw new Error('kaboom');
        },
      );

      const session = harness.createSession({ group: 'test' });
      const response = await harness.sendRequest(session, 'failing_tool', {});

      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.PLUGIN_ERROR);
    });
  });

  // -------------------------------------------------------------------------
  // Request channel (ROUTER/DEALER) integration
  // -------------------------------------------------------------------------

  describe('request channel integration', () => {
    beforeEach(() => {
      harness.registerTool(
        {
          name: 'echo',
          description: 'Echo tool',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
        async (envelope) => {
          const args = envelope.payload.arguments as Record<string, unknown>;
          return { echoed: args['text'] };
        },
      );
    });

    it('sends wire message through DEALER and receives response through ROUTER', async () => {
      const session = harness.createSession({ group: 'test' });
      const response = await harness.sendWireRequest(session, {
        topic: 'tool.invoke.echo',
        correlation: 'wire-corr-1',
        arguments: { text: 'hello' },
      });

      expect(response).not.toBeNull();
      expect(response!.payload.result).toEqual({ echoed: 'hello' });
      expect(response!.correlation).toBe('wire-corr-1');
    });
  });

  // -------------------------------------------------------------------------
  // Event bus integration
  // -------------------------------------------------------------------------

  describe('event bus integration', () => {
    it('publishes and receives events through PUB/SUB', async () => {
      const received: EventEnvelope[] = [];

      const sub = await harness.subscribeEvents(['message.inbound'], (envelope) => {
        received.push(envelope as EventEnvelope);
      });

      await harness.publishEvent({
        id: 'evt-1',
        version: 1,
        type: 'event',
        topic: 'message.inbound',
        source: 'test',
        correlation: null,
        timestamp: new Date().toISOString(),
        group: 'test',
        payload: { channel: 'email', body: 'hello' },
      });

      expect(received).toHaveLength(1);
      expect(received[0].topic).toBe('message.inbound');
      expect(received[0].payload).toEqual({ channel: 'email', body: 'hello' });

      await sub.unsubscribe();
    });

    it('filters events by topic prefix', async () => {
      const received: EventEnvelope[] = [];

      const sub = await harness.subscribeEvents(['agent.'], (envelope) => {
        received.push(envelope as EventEnvelope);
      });

      await harness.publishEvent({
        id: 'evt-2',
        version: 1,
        type: 'event',
        topic: 'agent.started',
        source: 'test',
        correlation: null,
        timestamp: new Date().toISOString(),
        group: 'test',
        payload: {},
      });

      await harness.publishEvent({
        id: 'evt-3',
        version: 1,
        type: 'event',
        topic: 'message.inbound',
        source: 'test',
        correlation: null,
        timestamp: new Date().toISOString(),
        group: 'test',
        payload: {},
      });

      expect(received).toHaveLength(1);
      expect(received[0].topic).toBe('agent.started');

      await sub.unsubscribe();
    });
  });

  // -------------------------------------------------------------------------
  // Plugin failure degradation
  // -------------------------------------------------------------------------

  describe('plugin failure degradation', () => {
    it('returns PLUGIN_UNAVAILABLE when no handler is registered for a known tool', async () => {
      // Register tool in catalog without a handler by using registerToolDeclarationOnly
      harness.registerToolDeclarationOnly({
        name: 'orphan_tool',
        description: 'Tool without handler',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      });

      const session = harness.createSession({ group: 'test' });
      const response = await harness.sendRequest(session, 'orphan_tool', {});

      expect(response.payload.error).not.toBeNull();
      expect(response.payload.error!.code).toBe(ErrorCode.PLUGIN_UNAVAILABLE);
    });
  });

  // -------------------------------------------------------------------------
  // Shutdown sequence
  // -------------------------------------------------------------------------

  describe('shutdown sequence', () => {
    it('drains pending requests before shutting down', async () => {
      harness.registerTool(
        {
          name: 'slow_tool',
          description: 'Slow tool',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
        async () => {
          // Simulate some work
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { result: 'done' };
        },
      );

      const session = harness.createSession({ group: 'test' });
      const responsePromise = harness.sendRequest(session, 'slow_tool', {});

      // Close while request is in-flight — should still resolve
      const [response] = await Promise.all([responsePromise, harness.close()]);

      expect(response.payload.result).toEqual({ result: 'done' });
    });

    it('cleans up all sockets on close', async () => {
      harness.registerTool(
        {
          name: 'test_tool',
          description: 'Test',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
        async () => ({ ok: true }),
      );

      const session = harness.createSession({ group: 'test' });
      await harness.sendRequest(session, 'test_tool', {});
      await harness.close();

      // Verify socket factory reports all sockets are closed
      expect(
        harness
          .getSocketFactory()
          .getRouters()
          .every((r) => r.closed),
      ).toBe(true);
      expect(
        harness
          .getSocketFactory()
          .getPublishers()
          .every((p) => p.closed),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple sessions
  // -------------------------------------------------------------------------

  describe('multiple concurrent sessions', () => {
    beforeEach(() => {
      harness.registerTool(
        {
          name: 'identify',
          description: 'Identify session',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
        async (envelope) => {
          return { group: envelope.group, source: envelope.source };
        },
      );
    });

    it('routes requests to correct sessions', async () => {
      const s1 = harness.createSession({ group: 'email' });
      const s2 = harness.createSession({ group: 'slack' });

      const r1 = await harness.sendRequest(s1, 'identify', {});
      const r2 = await harness.sendRequest(s2, 'identify', {});

      expect((r1.payload.result as Record<string, unknown>)['group']).toBe('email');
      expect((r2.payload.result as Record<string, unknown>)['group']).toBe('slack');
    });

    it('isolates rate limiting between sessions', async () => {
      harness.setRateLimit({ requestsPerMinute: 1, burstSize: 1 });

      const s1 = harness.createSession({ group: 'test' });
      const s2 = harness.createSession({ group: 'test' });

      // s1 uses up its token
      const r1 = await harness.sendRequest(s1, 'identify', {});
      expect(r1.payload.error).toBeNull();

      // s2 should still have its own token
      const r2 = await harness.sendRequest(s2, 'identify', {});
      expect(r2.payload.error).toBeNull();

      // s1 should now be rate-limited
      const r3 = await harness.sendRequest(s1, 'identify', {});
      expect(r3.payload.error).not.toBeNull();
      expect(r3.payload.error!.code).toBe(ErrorCode.RATE_LIMITED);
    });
  });
});
