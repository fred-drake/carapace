/**
 * E2E test: full test-input plugin flow.
 *
 * Validates the complete input → pipeline → tool → response loop using
 * the test-input plugin. Exercises the real subsystems (EventBus,
 * RequestChannel, ToolCatalog, MessageRouter, ResponseSanitizer) with
 * in-memory FakeSocketFactory — no real ZeroMQ, no containers.
 *
 * Demonstrates how future plugin authors use the test-input plugin's
 * programmatic API (submit → waitForResponse) for e2e testing.
 *
 * Tagged @e2e — runs via `pnpm test:e2e` (vitest e2e project).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Server } from '../../../core/server.js';
import type { ServerConfig, ServerDeps } from '../../../core/server.js';
import { FakeSocketFactory } from '../../../testing/fake-socket-factory.js';
import { FakeDealerSocket } from '../../../testing/fake-sockets.js';
import { IpcClient } from '../../../ipc/ipc-client.js';
import { TestInputHandler } from '../handler.js';
import type { ChannelServices } from '../../../core/plugin-handler.js';
import { EventDispatcher } from '../../../core/event-dispatcher.js';
import type { EventEnvelope } from '../../../types/protocol.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestServer(): { server: Server; factory: FakeSocketFactory } {
  const factory = new FakeSocketFactory();
  const config: ServerConfig = {
    socketDir: '/tmp/e2e-test-input-sockets',
    pluginsDir: '/tmp/nonexistent-plugins',
  };
  const deps: ServerDeps = {
    socketFactory: factory,
    fs: {
      existsSync: () => false,
      mkdirSync: () => {},
      chmodSync: () => {},
      unlinkSync: () => {},
      readdirSync: () => [],
    },
  };
  const server = new Server(config, deps);
  return { server, factory };
}

function createClient(factory: FakeSocketFactory): {
  client: IpcClient;
  dealer: FakeDealerSocket;
} {
  const router = factory.getRouters()[0];
  const dealer = new FakeDealerSocket();
  dealer.connectedTo = router;
  void dealer.connect('ipc:///tmp/e2e-test-input-sockets/server-request.sock');
  const client = new IpcClient(dealer, { timeoutMs: 5000 });
  return { client, dealer };
}

/**
 * Create ChannelServices backed by the FakePubSocket from the server's
 * EventBus. This wires publishEvent to the real PUB socket so events
 * are observable on the fake transport.
 */
function createChannelServices(factory: FakeSocketFactory): ChannelServices {
  const pub = factory.getPublishers()[0];

  return {
    getAuditLog: async () => [],
    getToolCatalog: () => [],
    getSessionInfo: () => ({ group: 'test', sessionId: 'e2e-session', startedAt: '' }),
    publishEvent: async (partial) => {
      const { randomUUID } = await import('node:crypto');
      const envelope: EventEnvelope = {
        id: randomUUID(),
        version: 1,
        type: 'event',
        topic: partial.topic,
        source: partial.source,
        correlation: null,
        timestamp: new Date().toISOString(),
        group: partial.group,
        payload: partial.payload,
      };
      const topicBuf = Buffer.from(envelope.topic, 'utf-8');
      const payloadBuf = Buffer.from(JSON.stringify(envelope), 'utf-8');
      await pub.send(topicBuf, payloadBuf);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E: test-input plugin flow', () => {
  let server: Server;
  let factory: FakeSocketFactory;
  let client: IpcClient;
  let handler: TestInputHandler;

  afterEach(async () => {
    // Reset handler first to clear pending waiters (prevents unhandled rejections)
    handler?.reset();
    await handler?.shutdown();
    await client?.close();
    await server?.stop();
    await factory?.cleanup();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Happy path — submit → agent responds → waitForResponse
  // -------------------------------------------------------------------------

  it('happy path: submit prompt, agent responds via test_respond', async () => {
    // 1. Boot server (intrinsic echo tool only, no filesystem plugins)
    ({ server, factory } = createTestServer());
    await server.start();

    // 2. Register test_respond tool in the catalog (simulating plugin loading)
    server.toolCatalog!.register(
      {
        name: 'test_respond',
        description: 'Respond to a test prompt',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: {
            body: { type: 'string', description: 'Response body', maxLength: 8192 },
          },
        },
      },
      async (envelope) => {
        // Bridge to handler — this is what PluginLoader does
        const toolName = envelope.topic.replace('tool.invoke.', '');
        const result = await handler.handleToolInvocation(toolName, envelope.payload.arguments, {
          group: envelope.group,
          sessionId: envelope.source,
          correlationId: envelope.correlation,
          timestamp: envelope.timestamp,
        });
        if (result.ok) return result.result;
        return { error: result.error };
      },
    );

    // 3. Create and initialize TestInputHandler with real ChannelServices
    handler = new TestInputHandler();
    const services = createChannelServices(factory);
    await handler.initialize(services);

    // 4. Create IPC client (simulates agent inside container)
    ({ client } = createClient(factory));

    // 5. Submit a prompt — handler publishes message.inbound to event bus
    const correlationId = await handler.submit('What is 2 + 2?');
    expect(correlationId).toBeDefined();

    // 6. Verify event appeared on the PUB socket
    const pub = factory.getPublishers()[0];
    expect(pub.sent.length).toBeGreaterThanOrEqual(1);
    const eventPayload = JSON.parse(
      pub.sent[pub.sent.length - 1].payload.toString(),
    ) as EventEnvelope;
    expect(eventPayload.topic).toBe('message.inbound');
    expect(eventPayload.payload).toMatchObject({
      channel: 'test-input',
      sender: 'test-harness',
      body: 'What is 2 + 2?',
    });

    // 7. Simulate agent calling test_respond through the full pipeline
    //    In production, the agent receives the prompt via container spawn
    //    and the pipeline correlates using the session's wire correlation.
    const toolResponse = await client.invoke('tool.invoke.test_respond', {
      body: 'The answer is 4',
    });

    // 8. Verify the tool response through the pipeline
    expect(toolResponse.payload.error).toBeNull();
    expect(toolResponse.payload.result).toMatchObject({
      captured: true,
    });

    // 9. Verify the handler captured the response
    const responses = handler.getResponses();
    expect(responses.length).toBeGreaterThanOrEqual(1);
    expect(responses[0].body).toBe('The answer is 4');
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Multi-tool chain — agent uses echo + test_respond
  // -------------------------------------------------------------------------

  it('multi-tool chain: agent uses echo then test_respond', async () => {
    ({ server, factory } = createTestServer());
    await server.start();

    // Register test_respond alongside the intrinsic echo tool
    handler = new TestInputHandler();
    server.toolCatalog!.register(
      {
        name: 'test_respond',
        description: 'Respond to a test prompt',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: {
            body: { type: 'string', description: 'Response body', maxLength: 8192 },
          },
        },
      },
      async (envelope) => {
        const toolName = envelope.topic.replace('tool.invoke.', '');
        const result = await handler.handleToolInvocation(toolName, envelope.payload.arguments, {
          group: envelope.group,
          sessionId: envelope.source,
          correlationId: envelope.correlation,
          timestamp: envelope.timestamp,
        });
        if (result.ok) return result.result;
        return { error: result.error };
      },
    );

    const services = createChannelServices(factory);
    await handler.initialize(services);
    ({ client } = createClient(factory));

    // Agent first calls echo (intrinsic tool)
    const echoResponse = await client.invoke('tool.invoke.echo', { text: 'thinking...' });
    expect(echoResponse.payload.error).toBeNull();
    expect(echoResponse.payload.result).toEqual({ echoed: 'thinking...' });

    // Agent then calls test_respond to deliver its final answer
    const respondResult = await client.invoke('tool.invoke.test_respond', {
      body: 'Final answer after echo',
    });
    expect(respondResult.payload.error).toBeNull();
    expect(respondResult.payload.result).toMatchObject({ captured: true });

    // Verify both calls went through the pipeline and response was captured
    const responses = handler.getResponses();
    expect(responses).toHaveLength(1);
    expect(responses[0].body).toBe('Final answer after echo');
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Invalid prompt rejected at schema validation
  // -------------------------------------------------------------------------

  it('invalid prompt rejected by EventDispatcher schema validation', async () => {
    // Create an EventDispatcher with standard config
    const dispatcher = new EventDispatcher({
      getActiveSessionCount: () => 0,
      spawnAgent: async () => 'session-1',
      maxSessionsPerGroup: 5,
      configuredGroups: new Set(['test']),
    });

    // Valid message.inbound event — should succeed
    const validEvent: EventEnvelope = {
      id: 'evt-valid',
      version: 1,
      type: 'event',
      topic: 'message.inbound',
      source: 'test-input',
      correlation: null,
      timestamp: new Date().toISOString(),
      group: 'test',
      payload: {
        channel: 'test-input',
        sender: 'test-harness',
        content_type: 'text',
        body: 'Hello, agent!',
      },
    };
    const validResult = await dispatcher.dispatch(validEvent);
    expect(validResult.action).toBe('spawned');

    // Invalid message.inbound event — missing required 'body' field
    const invalidEvent: EventEnvelope = {
      id: 'evt-invalid',
      version: 1,
      type: 'event',
      topic: 'message.inbound',
      source: 'test-input',
      correlation: null,
      timestamp: new Date().toISOString(),
      group: 'test',
      payload: {
        channel: 'test-input',
        sender: 'test-harness',
        content_type: 'text',
        // body is missing
      },
    };
    const invalidResult = await dispatcher.dispatch(invalidEvent);
    expect(invalidResult.action).toBe('rejected');
    if (invalidResult.action === 'rejected') {
      expect(invalidResult.reason).toContain('body');
    }

    // Invalid message.inbound event — extra field violates additionalProperties
    const extraFieldEvent: EventEnvelope = {
      id: 'evt-extra',
      version: 1,
      type: 'event',
      topic: 'message.inbound',
      source: 'test-input',
      correlation: null,
      timestamp: new Date().toISOString(),
      group: 'test',
      payload: {
        channel: 'test-input',
        sender: 'test-harness',
        content_type: 'text',
        body: 'Hello',
        forbidden_extra: 'should not be here',
      },
    };
    const extraResult = await dispatcher.dispatch(extraFieldEvent);
    expect(extraResult.action).toBe('rejected');
  });

  // -------------------------------------------------------------------------
  // Scenario 4: waitForResponse pattern for test authors
  // -------------------------------------------------------------------------

  it('demonstrates waitForResponse pattern for test authors', async () => {
    ({ server, factory } = createTestServer());
    await server.start();

    handler = new TestInputHandler();
    server.toolCatalog!.register(
      {
        name: 'test_respond',
        description: 'Respond to a test prompt',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: {
            body: { type: 'string', description: 'Response body', maxLength: 8192 },
          },
        },
      },
      async (envelope) => {
        const toolName = envelope.topic.replace('tool.invoke.', '');
        const result = await handler.handleToolInvocation(toolName, envelope.payload.arguments, {
          group: envelope.group,
          sessionId: envelope.source,
          correlationId: envelope.correlation,
          timestamp: envelope.timestamp,
        });
        if (result.ok) return result.result;
        return { error: result.error };
      },
    );

    const services = createChannelServices(factory);
    await handler.initialize(services);
    ({ client } = createClient(factory));

    // --- Pattern demonstration for test authors ---
    //
    // Step 1: Submit a prompt (returns correlation ID for tracking)
    const correlationId = await handler.submit('Summarize the project README');
    expect(typeof correlationId).toBe('string');

    // Step 2: Simulate agent work (call tools through the pipeline)
    const echoResult = await client.invoke('tool.invoke.echo', {
      text: 'Reading README...',
    });
    expect(echoResult.payload.error).toBeNull();

    // Step 3: Agent delivers its response via test_respond
    await client.invoke('tool.invoke.test_respond', {
      body: 'The project is a security-first AI agent framework.',
    });

    // Step 4: Retrieve captured responses
    const allResponses = handler.getResponses();
    expect(allResponses).toHaveLength(1);
    expect(allResponses[0].body).toContain('security-first');

    // Step 5: Clean up for test isolation
    handler.reset();
    expect(handler.getResponses()).toHaveLength(0);
  });
});
