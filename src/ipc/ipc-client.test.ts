/**
 * Tests for the IPC client — the container-side communication layer.
 *
 * The IpcClient is the core logic behind the `ipc` binary. It handles:
 *   - Wire message construction (topic, correlation, arguments)
 *   - Sending via a DEALER socket
 *   - Waiting for a correlated response with timeout
 *   - Structured output formatting
 *
 * Uses fake sockets from QA-03 to test without real ZeroMQ.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { IpcClient } from './ipc-client.js';
import {
  wireFakeRouterDealer,
  type FakeRouterSocket,
  type FakeDealerSocket,
} from '../testing/fake-sockets.js';
import { createResponseEnvelope } from '../testing/factories.js';
import type { IpcLogEntry } from './ipc-logger.js';
import { createIpcLogger } from './ipc-logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up a ROUTER/DEALER pair and create an IpcClient using the DEALER. */
async function createTestPair(options?: { timeoutMs?: number }) {
  const { router, dealer } = await wireFakeRouterDealer();
  const client = new IpcClient(dealer, {
    timeoutMs: options?.timeoutMs ?? 5000,
  });
  return { router, dealer, client };
}

/**
 * Auto-respond from the ROUTER to any incoming message with a given
 * response envelope (matched by correlation from the wire message).
 */
function autoRespond(router: FakeRouterSocket, makeResponse: (correlation: string) => object) {
  router.on('message', (identity, _delimiter, payload) => {
    const wire = JSON.parse(payload.toString());
    const response = makeResponse(wire.correlation);
    void router.send(identity, Buffer.alloc(0), Buffer.from(JSON.stringify(response)));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IpcClient', () => {
  let router: FakeRouterSocket;
  let dealer: FakeDealerSocket;
  let client: IpcClient;

  beforeEach(async () => {
    ({ router, dealer, client } = await createTestPair());
  });

  afterEach(async () => {
    await client.close();
    await router.close();
  });

  // -------------------------------------------------------------------------
  // Wire message construction
  // -------------------------------------------------------------------------

  describe('wire message construction', () => {
    it('sends a wire message with the given topic and arguments', async () => {
      autoRespond(router, (corr) => createResponseEnvelope({ correlation: corr }));

      await client.invoke('tool.invoke.create_reminder', {
        title: 'test',
      });

      const sent = router.received;
      expect(sent).toHaveLength(1);

      const wire = JSON.parse(sent[0].payload.toString());
      expect(wire.topic).toBe('tool.invoke.create_reminder');
      expect(wire.arguments).toEqual({ title: 'test' });
    });

    it('generates a correlation ID as a non-empty string', async () => {
      autoRespond(router, (corr) => createResponseEnvelope({ correlation: corr }));

      await client.invoke('tool.invoke.test_tool', { input: 'hello' });

      const sent = router.received;
      const wire = JSON.parse(sent[0].payload.toString());
      expect(typeof wire.correlation).toBe('string');
      expect(wire.correlation.length).toBeGreaterThan(0);
    });

    it('generates unique correlation IDs per invocation', async () => {
      autoRespond(router, (corr) => createResponseEnvelope({ correlation: corr }));

      await client.invoke('tool.invoke.test_tool', { a: 1 });
      await client.invoke('tool.invoke.test_tool', { b: 2 });

      const sent = router.received;
      const corr1 = JSON.parse(sent[0].payload.toString()).correlation;
      const corr2 = JSON.parse(sent[1].payload.toString()).correlation;
      expect(corr1).not.toBe(corr2);
    });

    it('sends only wire fields (topic, correlation, arguments) — no envelope fields', async () => {
      autoRespond(router, (corr) => createResponseEnvelope({ correlation: corr }));

      await client.invoke('tool.invoke.test_tool', {});

      const sent = router.received;
      const wire = JSON.parse(sent[0].payload.toString());
      const keys = Object.keys(wire);
      expect(keys).toContain('topic');
      expect(keys).toContain('correlation');
      expect(keys).toContain('arguments');
      // Must NOT contain envelope identity fields.
      expect(keys).not.toContain('id');
      expect(keys).not.toContain('version');
      expect(keys).not.toContain('type');
      expect(keys).not.toContain('source');
      expect(keys).not.toContain('group');
      expect(keys).not.toContain('timestamp');
    });

    it('sends empty arguments as an empty object', async () => {
      autoRespond(router, (corr) => createResponseEnvelope({ correlation: corr }));

      await client.invoke('tool.invoke.test_tool', {});

      const sent = router.received;
      const wire = JSON.parse(sent[0].payload.toString());
      expect(wire.arguments).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Response handling
  // -------------------------------------------------------------------------

  describe('response handling', () => {
    it('returns the response payload on success', async () => {
      autoRespond(router, (corr) =>
        createResponseEnvelope({
          correlation: corr,
          payload: { result: { reminder_id: 'R-123' }, error: null },
        }),
      );

      const result = await client.invoke('tool.invoke.create_reminder', {
        title: 'test',
      });

      expect(result.payload.result).toMatchObject({ reminder_id: 'R-123' });
      expect(result.payload.error).toBeNull();
    });

    it('returns the error payload when the response has an error', async () => {
      autoRespond(router, (corr) =>
        createResponseEnvelope({
          correlation: corr,
          payload: {
            result: null,
            error: {
              code: 'UNKNOWN_TOOL',
              message: 'No such tool',
              retriable: false,
            },
          },
        }),
      );

      const result = await client.invoke('tool.invoke.nonexistent', {});

      expect(result.payload.error).not.toBeNull();
      expect(result.payload.error!.code).toBe('UNKNOWN_TOOL');
    });

    it('matches response to the correct correlation ID', async () => {
      // Set up router to respond with the correlation from the request.
      autoRespond(router, (corr) =>
        createResponseEnvelope({
          correlation: corr,
          payload: { result: { matched: true }, error: null },
        }),
      );

      const result = await client.invoke('tool.invoke.test_tool', {});
      expect(result.payload.result).toMatchObject({ matched: true });
    });
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe('timeout', () => {
    it('throws on timeout when no response arrives', async () => {
      const pair = await createTestPair({ timeoutMs: 50 });
      // No auto-respond — the router will never reply.

      let error: Error | undefined;
      try {
        await pair.client.invoke('tool.invoke.test_tool', {});
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      expect(error!.message).toMatch(/timeout/i);

      await pair.client.close();
      await pair.router.close();
    });

    it('includes the timeout duration in the error', async () => {
      const pair = await createTestPair({ timeoutMs: 100 });

      let error: Error | undefined;
      try {
        await pair.client.invoke('tool.invoke.test_tool', {});
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      expect(error!.message).toContain('100');

      await pair.client.close();
      await pair.router.close();
    });
  });

  // -------------------------------------------------------------------------
  // Payload size limit
  // -------------------------------------------------------------------------

  describe('payload size limit', () => {
    it('rejects arguments exceeding the maximum payload size', async () => {
      // Default max is 1MB. Create arguments larger than that.
      const largeValue = 'x'.repeat(1_100_000);

      await expect(client.invoke('tool.invoke.test_tool', { data: largeValue })).rejects.toThrow(
        /size|limit|exceed/i,
      );
    });

    it('does not send the message when payload is too large', async () => {
      const largeValue = 'x'.repeat(1_100_000);

      try {
        await client.invoke('tool.invoke.test_tool', { data: largeValue });
      } catch {
        // Expected to throw.
      }

      expect(router.received).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Socket error handling
  // -------------------------------------------------------------------------

  describe('socket errors', () => {
    it('propagates socket send errors', async () => {
      dealer.injectError('refused');

      await expect(client.invoke('tool.invoke.test_tool', {})).rejects.toThrow(/refused/i);
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('closes the dealer socket', async () => {
      await client.close();
      expect(dealer.closed).toBe(true);
    });

    it('rejects invoke after close', async () => {
      await client.close();

      await expect(client.invoke('tool.invoke.test_tool', {})).rejects.toThrow(/closed/i);
    });
  });

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  describe('logging', () => {
    let logEntries: IpcLogEntry[];

    function createLoggedClient(dealerSocket: FakeDealerSocket): IpcClient {
      logEntries = [];
      const testLogger = createIpcLogger('ipc-client', {
        debugEnabled: true,
        sink: (entry) => logEntries.push(entry),
      });
      return new IpcClient(dealerSocket, { timeoutMs: 5000, logger: testLogger });
    }

    it('logs invocation with topic and argument keys (not values)', async () => {
      const pair = await wireFakeRouterDealer();
      const loggedClient = createLoggedClient(pair.dealer);

      autoRespond(pair.router, (corr) => createResponseEnvelope({ correlation: corr }));
      await loggedClient.invoke('tool.invoke.test', { secret: 'password123', name: 'fred' });

      const invokeLog = logEntries.find((e) => e.msg === 'invoking');
      expect(invokeLog).toBeDefined();
      expect(invokeLog!.topic).toBe('tool.invoke.test');
      expect(invokeLog!.arg_keys).toEqual(['secret', 'name']);
      // Verify no argument values are logged
      const allJson = JSON.stringify(logEntries);
      expect(allJson).not.toContain('password123');

      await loggedClient.close();
      await pair.router.close();
    });

    it('logs response received with duration', async () => {
      const pair = await wireFakeRouterDealer();
      const loggedClient = createLoggedClient(pair.dealer);

      autoRespond(pair.router, (corr) => createResponseEnvelope({ correlation: corr }));
      await loggedClient.invoke('tool.invoke.test', { input: 'test' });

      const responseLog = logEntries.find((e) => e.msg === 'response received');
      expect(responseLog).toBeDefined();
      expect(responseLog!.duration_ms).toBeDefined();
      expect(typeof responseLog!.duration_ms).toBe('number');

      await loggedClient.close();
      await pair.router.close();
    });

    it('logs wire message sent with byte length', async () => {
      const pair = await wireFakeRouterDealer();
      const loggedClient = createLoggedClient(pair.dealer);

      autoRespond(pair.router, (corr) => createResponseEnvelope({ correlation: corr }));
      await loggedClient.invoke('tool.invoke.test', {});

      const sentLog = logEntries.find((e) => e.msg === 'wire message sent');
      expect(sentLog).toBeDefined();
      expect(sentLog!.byteLength).toBeDefined();
      expect(typeof sentLog!.byteLength).toBe('number');

      await loggedClient.close();
      await pair.router.close();
    });

    it('logs client close with pending rejection count', async () => {
      const pair = await wireFakeRouterDealer();
      const loggedClient = createLoggedClient(pair.dealer);

      await loggedClient.close();

      const closeLog = logEntries.find((e) => e.msg === 'client closed');
      expect(closeLog).toBeDefined();
      expect(closeLog!.pending_rejected).toBe(0);

      await pair.router.close();
    });

    it('logs timeout warning when request times out', async () => {
      const pair = await wireFakeRouterDealer();
      logEntries = [];
      const testLogger = createIpcLogger('ipc-client', {
        debugEnabled: true,
        sink: (entry) => logEntries.push(entry),
      });
      const shortClient = new IpcClient(pair.dealer, { timeoutMs: 50, logger: testLogger });

      // No auto-respond — will timeout
      try {
        await shortClient.invoke('tool.invoke.slow', {});
      } catch {
        // Expected timeout
      }

      const timeoutLog = logEntries.find((e) => e.msg === 'request timed out');
      expect(timeoutLog).toBeDefined();
      expect(timeoutLog!.level).toBe('warn');
      expect(timeoutLog!.timeout_ms).toBe(50);

      await shortClient.close();
      await pair.router.close();
    });
  });
});
