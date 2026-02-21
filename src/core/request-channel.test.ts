import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestChannel } from './request-channel.js';
import type { WireMessage, ResponseEnvelope } from '../types/protocol.js';
import type {
  RouterSocket,
  RouterMessageHandler,
  SocketFactory,
  PublisherSocket,
  SubscriberSocket,
  DealerSocket,
} from '../types/socket.js';
import { configureLogging, resetLogging, type LogEntry, type LogSink } from './logger.js';

// ---------------------------------------------------------------------------
// Fake RouterSocket
// ---------------------------------------------------------------------------

/**
 * In-memory fake ROUTER socket for testing.
 *
 * Captures all `send()` calls and exposes a `simulateMessage()` method to
 * inject incoming frames as if a DEALER had sent them.
 */
class FakeRouterSocket implements RouterSocket {
  public boundAddress: string | null = null;
  public closed = false;
  public sentFrames: Array<{ identity: Buffer; delimiter: Buffer; payload: Buffer }> = [];

  private messageHandler: RouterMessageHandler | null = null;

  async bind(address: string): Promise<void> {
    this.boundAddress = address;
  }

  on(_event: 'message', handler: RouterMessageHandler): void {
    this.messageHandler = handler;
  }

  async send(identity: Buffer, delimiter: Buffer, payload: Buffer): Promise<void> {
    this.sentFrames.push({ identity, delimiter, payload });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Simulate an incoming message from a DEALER. */
  simulateMessage(identity: Buffer, delimiter: Buffer, payload: Buffer): void {
    if (this.messageHandler) {
      this.messageHandler(identity, delimiter, payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Fake SocketFactory
// ---------------------------------------------------------------------------

/**
 * Minimal SocketFactory that only creates FakeRouterSocket instances.
 * The other factory methods throw because RequestChannel never calls them.
 */
class FakeSocketFactory implements SocketFactory {
  public lastRouter: FakeRouterSocket | null = null;

  createRouter(): RouterSocket {
    this.lastRouter = new FakeRouterSocket();
    return this.lastRouter;
  }

  createPublisher(): PublisherSocket {
    throw new Error('Not implemented');
  }

  createSubscriber(): SubscriberSocket {
    throw new Error('Not implemented');
  }

  createDealer(): DealerSocket {
    throw new Error('Not implemented');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a hex-encoded identity string from a human-readable label. */
function makeIdentity(label: string): string {
  return Buffer.from(label).toString('hex');
}

/** Create a Buffer containing the hex-encoded identity (what ROUTER prepends). */
function makeIdentityBuffer(label: string): Buffer {
  return Buffer.from(label);
}

/** Create a WireMessage. */
function makeWireMessage(
  topic: string,
  correlation: string,
  args: Record<string, unknown> = {},
): WireMessage {
  return { topic, correlation, arguments: args };
}

/** Create a minimal ResponseEnvelope. */
function makeResponse(correlation: string, result: unknown = { ok: true }): ResponseEnvelope {
  return {
    id: `res-${correlation}`,
    version: 1,
    type: 'response',
    topic: 'tool.invoke.test',
    source: 'test-plugin',
    correlation,
    timestamp: new Date().toISOString(),
    group: 'test-group',
    payload: { result, error: null },
  };
}

/** Simulate a DEALER sending a WireMessage through the fake ROUTER socket. */
function simulateDealerMessage(
  fakeRouter: FakeRouterSocket,
  dealerLabel: string,
  wireMessage: WireMessage,
): void {
  const identity = makeIdentityBuffer(dealerLabel);
  const delimiter = Buffer.alloc(0);
  const payload = Buffer.from(JSON.stringify(wireMessage));
  fakeRouter.simulateMessage(identity, delimiter, payload);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RequestChannel', () => {
  let factory: FakeSocketFactory;
  let channel: RequestChannel;

  beforeEach(() => {
    vi.useFakeTimers();
    factory = new FakeSocketFactory();
    channel = new RequestChannel(factory);
  });

  afterEach(async () => {
    await channel.close();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // bind
  // -------------------------------------------------------------------------

  describe('bind', () => {
    it('creates and binds a ROUTER socket', async () => {
      await channel.bind('ipc:///tmp/test-req.sock');

      expect(factory.lastRouter).not.toBeNull();
      expect(factory.lastRouter!.boundAddress).toBe('ipc:///tmp/test-req.sock');
    });

    it('throws if already bound', async () => {
      await channel.bind('ipc:///tmp/test-req.sock');

      await expect(channel.bind('ipc:///tmp/other.sock')).rejects.toThrow(
        'RequestChannel is already bound',
      );
    });
  });

  // -------------------------------------------------------------------------
  // receive request
  // -------------------------------------------------------------------------

  describe('receive request', () => {
    it('invokes handler with connection identity and parsed WireMessage', async () => {
      const handler = vi.fn();
      channel.onRequest(handler);
      await channel.bind('ipc:///tmp/test-req.sock');

      const wire = makeWireMessage('tool.invoke.reminder', 'corr-1', { title: 'Buy milk' });
      simulateDealerMessage(factory.lastRouter!, 'dealer-A', wire);

      expect(handler).toHaveBeenCalledOnce();

      const [identity, received] = handler.mock.calls[0] as [string, WireMessage];
      expect(identity).toBe(makeIdentity('dealer-A'));
      expect(received.topic).toBe('tool.invoke.reminder');
      expect(received.correlation).toBe('corr-1');
      expect(received.arguments).toEqual({ title: 'Buy milk' });
    });

    it('tracks the request as pending', async () => {
      channel.onRequest(vi.fn());
      await channel.bind('ipc:///tmp/test-req.sock');

      const wire = makeWireMessage('tool.invoke.test', 'corr-2');
      simulateDealerMessage(factory.lastRouter!, 'dealer-B', wire);

      expect(channel.pendingCount).toBe(1);
    });

    it('silently drops messages with malformed JSON', async () => {
      const handler = vi.fn();
      channel.onRequest(handler);
      await channel.bind('ipc:///tmp/test-req.sock');

      const identity = makeIdentityBuffer('dealer-bad');
      const delimiter = Buffer.alloc(0);
      const badPayload = Buffer.from('not-valid-json{{{');
      factory.lastRouter!.simulateMessage(identity, delimiter, badPayload);

      expect(handler).not.toHaveBeenCalled();
      expect(channel.pendingCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // send response
  // -------------------------------------------------------------------------

  describe('sendResponse', () => {
    it('sends response to the correct dealer by identity', async () => {
      channel.onRequest(vi.fn());
      await channel.bind('ipc:///tmp/test-req.sock');

      const wire = makeWireMessage('tool.invoke.test', 'corr-3');
      simulateDealerMessage(factory.lastRouter!, 'dealer-C', wire);

      const response = makeResponse('corr-3', { reminder_id: 'R-1' });
      await channel.sendResponse(makeIdentity('dealer-C'), response);

      const sent = factory.lastRouter!.sentFrames;
      expect(sent).toHaveLength(1);

      // Verify identity frame routes to the correct dealer
      expect(sent[0].identity.toString()).toBe('dealer-C');

      // Verify delimiter is empty
      expect(sent[0].delimiter.length).toBe(0);

      // Verify payload is the serialized response
      const parsed = JSON.parse(sent[0].payload.toString());
      expect(parsed.correlation).toBe('corr-3');
      expect(parsed.payload.result).toEqual({ reminder_id: 'R-1' });
    });

    it('removes the pending entry after sending', async () => {
      channel.onRequest(vi.fn());
      await channel.bind('ipc:///tmp/test-req.sock');

      const wire = makeWireMessage('tool.invoke.test', 'corr-4');
      simulateDealerMessage(factory.lastRouter!, 'dealer-D', wire);
      expect(channel.pendingCount).toBe(1);

      await channel.sendResponse(makeIdentity('dealer-D'), makeResponse('corr-4'));
      expect(channel.pendingCount).toBe(0);
    });

    it('throws if channel is not bound', async () => {
      await expect(channel.sendResponse('abcd', makeResponse('corr-x'))).rejects.toThrow(
        'RequestChannel is not bound',
      );
    });

    it('throws if correlation is not pending', async () => {
      channel.onRequest(vi.fn());
      await channel.bind('ipc:///tmp/test-req.sock');

      await expect(channel.sendResponse('abcd', makeResponse('no-such-corr'))).rejects.toThrow(
        'No pending request for correlation: no-such-corr',
      );
    });

    it('throws if identity does not match the pending correlation', async () => {
      channel.onRequest(vi.fn());
      await channel.bind('ipc:///tmp/test-req.sock');

      const wire = makeWireMessage('tool.invoke.test', 'corr-5');
      simulateDealerMessage(factory.lastRouter!, 'dealer-E', wire);

      const wrongIdentity = makeIdentity('dealer-wrong');
      await expect(channel.sendResponse(wrongIdentity, makeResponse('corr-5'))).rejects.toThrow(
        /belongs to identity/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // correlation matching
  // -------------------------------------------------------------------------

  describe('correlation matching', () => {
    it('routes responses to the correct dealer among multiple pending', async () => {
      channel.onRequest(vi.fn());
      await channel.bind('ipc:///tmp/test-req.sock');

      // Two dealers send requests
      simulateDealerMessage(
        factory.lastRouter!,
        'dealer-1',
        makeWireMessage('tool.invoke.a', 'corr-A'),
      );
      simulateDealerMessage(
        factory.lastRouter!,
        'dealer-2',
        makeWireMessage('tool.invoke.b', 'corr-B'),
      );
      expect(channel.pendingCount).toBe(2);

      // Respond to corr-B first (out of order)
      await channel.sendResponse(makeIdentity('dealer-2'), makeResponse('corr-B'));

      const sent = factory.lastRouter!.sentFrames;
      expect(sent).toHaveLength(1);
      expect(sent[0].identity.toString()).toBe('dealer-2');

      const parsed = JSON.parse(sent[0].payload.toString());
      expect(parsed.correlation).toBe('corr-B');

      // corr-A is still pending
      expect(channel.pendingCount).toBe(1);

      // Now respond to corr-A
      await channel.sendResponse(makeIdentity('dealer-1'), makeResponse('corr-A'));
      expect(channel.pendingCount).toBe(0);
      expect(factory.lastRouter!.sentFrames).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // concurrent requests from different dealers
  // -------------------------------------------------------------------------

  describe('concurrent requests from different dealers', () => {
    it('handles multiple dealers with interleaved requests', async () => {
      const handler = vi.fn();
      channel.onRequest(handler);
      await channel.bind('ipc:///tmp/test-req.sock');

      // Three dealers, each sending a request
      simulateDealerMessage(
        factory.lastRouter!,
        'alpha',
        makeWireMessage('tool.invoke.x', 'corr-alpha'),
      );
      simulateDealerMessage(
        factory.lastRouter!,
        'beta',
        makeWireMessage('tool.invoke.y', 'corr-beta'),
      );
      simulateDealerMessage(
        factory.lastRouter!,
        'gamma',
        makeWireMessage('tool.invoke.z', 'corr-gamma'),
      );

      expect(handler).toHaveBeenCalledTimes(3);
      expect(channel.pendingCount).toBe(3);

      // Respond in reverse order
      await channel.sendResponse(makeIdentity('gamma'), makeResponse('corr-gamma'));
      await channel.sendResponse(makeIdentity('alpha'), makeResponse('corr-alpha'));
      await channel.sendResponse(makeIdentity('beta'), makeResponse('corr-beta'));

      expect(channel.pendingCount).toBe(0);

      const sent = factory.lastRouter!.sentFrames;
      expect(sent).toHaveLength(3);

      // Verify each response went to the right dealer
      expect(sent[0].identity.toString()).toBe('gamma');
      expect(sent[1].identity.toString()).toBe('alpha');
      expect(sent[2].identity.toString()).toBe('beta');
    });
  });

  // -------------------------------------------------------------------------
  // timeout for unanswered requests
  // -------------------------------------------------------------------------

  describe('timeout', () => {
    it('removes pending entry after timeout expires', async () => {
      channel = new RequestChannel(factory, { timeoutMs: 5000 });
      channel.onRequest(vi.fn());
      await channel.bind('ipc:///tmp/test-req.sock');

      simulateDealerMessage(
        factory.lastRouter!,
        'dealer-slow',
        makeWireMessage('tool.invoke.slow', 'corr-timeout'),
      );
      expect(channel.pendingCount).toBe(1);

      // Advance time past timeout
      vi.advanceTimersByTime(5001);

      expect(channel.pendingCount).toBe(0);
    });

    it('invokes timeout handler when a request times out', async () => {
      const timeoutHandler = vi.fn();
      channel = new RequestChannel(factory, { timeoutMs: 2000 });
      channel.onRequest(vi.fn());
      channel.onTimeout(timeoutHandler);
      await channel.bind('ipc:///tmp/test-req.sock');

      simulateDealerMessage(
        factory.lastRouter!,
        'dealer-late',
        makeWireMessage('tool.invoke.late', 'corr-late'),
      );

      vi.advanceTimersByTime(2001);

      expect(timeoutHandler).toHaveBeenCalledOnce();
      expect(timeoutHandler).toHaveBeenCalledWith('corr-late', makeIdentity('dealer-late'));
    });

    it('does not timeout if response arrives in time', async () => {
      const timeoutHandler = vi.fn();
      channel = new RequestChannel(factory, { timeoutMs: 5000 });
      channel.onRequest(vi.fn());
      channel.onTimeout(timeoutHandler);
      await channel.bind('ipc:///tmp/test-req.sock');

      simulateDealerMessage(
        factory.lastRouter!,
        'dealer-fast',
        makeWireMessage('tool.invoke.fast', 'corr-fast'),
      );

      // Respond before timeout
      await channel.sendResponse(makeIdentity('dealer-fast'), makeResponse('corr-fast'));

      // Advance past what would have been the timeout
      vi.advanceTimersByTime(6000);

      expect(timeoutHandler).not.toHaveBeenCalled();
      expect(channel.pendingCount).toBe(0);
    });

    it('uses default 30s timeout when not configured', async () => {
      const timeoutHandler = vi.fn();
      channel = new RequestChannel(factory);
      channel.onRequest(vi.fn());
      channel.onTimeout(timeoutHandler);
      await channel.bind('ipc:///tmp/test-req.sock');

      simulateDealerMessage(
        factory.lastRouter!,
        'dealer-default',
        makeWireMessage('tool.invoke.default', 'corr-default'),
      );

      // Just before 30s — should still be pending
      vi.advanceTimersByTime(29_999);
      expect(channel.pendingCount).toBe(1);
      expect(timeoutHandler).not.toHaveBeenCalled();

      // Cross the 30s boundary
      vi.advanceTimersByTime(2);
      expect(channel.pendingCount).toBe(0);
      expect(timeoutHandler).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('closes the ROUTER socket', async () => {
      await channel.bind('ipc:///tmp/test-req.sock');
      const router = factory.lastRouter!;

      await channel.close();

      expect(router.closed).toBe(true);
    });

    it('cancels all pending timeouts', async () => {
      const timeoutHandler = vi.fn();
      channel = new RequestChannel(factory, { timeoutMs: 5000 });
      channel.onRequest(vi.fn());
      channel.onTimeout(timeoutHandler);
      await channel.bind('ipc:///tmp/test-req.sock');

      simulateDealerMessage(
        factory.lastRouter!,
        'dealer-X',
        makeWireMessage('tool.invoke.x', 'corr-X'),
      );
      simulateDealerMessage(
        factory.lastRouter!,
        'dealer-Y',
        makeWireMessage('tool.invoke.y', 'corr-Y'),
      );
      expect(channel.pendingCount).toBe(2);

      await channel.close();

      expect(channel.pendingCount).toBe(0);

      // Timeouts should not fire after close
      vi.advanceTimersByTime(10_000);
      expect(timeoutHandler).not.toHaveBeenCalled();
    });

    it('is safe to call multiple times', async () => {
      await channel.bind('ipc:///tmp/test-req.sock');

      await channel.close();
      await channel.close();

      // No errors thrown
    });

    it('allows rebinding after close', async () => {
      await channel.bind('ipc:///tmp/test-req.sock');
      await channel.close();

      // Should be able to bind again after close
      channel = new RequestChannel(factory);
      await channel.bind('ipc:///tmp/test-new.sock');

      expect(factory.lastRouter!.boundAddress).toBe('ipc:///tmp/test-new.sock');
    });
  });

  // -------------------------------------------------------------------------
  // logging
  // -------------------------------------------------------------------------

  describe('logging', () => {
    let logEntries: LogEntry[];

    beforeEach(() => {
      logEntries = [];
      const logSink: LogSink = (entry) => logEntries.push(entry);
      configureLogging({ level: 'debug', sink: logSink });
    });

    afterEach(() => {
      resetLogging();
    });

    it('logs ROUTER socket bound on bind()', async () => {
      channel = new RequestChannel(factory);
      await channel.bind('ipc:///tmp/test-log.sock');

      const bindLog = logEntries.find((e) => e.msg === 'ROUTER socket bound');
      expect(bindLog).toBeDefined();
      expect(bindLog!.meta).toEqual({ address: 'ipc:///tmp/test-log.sock' });
    });

    it('logs frame received on incoming request', async () => {
      channel = new RequestChannel(factory);
      channel.onRequest(vi.fn());
      await channel.bind('ipc:///tmp/test-log2.sock');

      const wire = makeWireMessage('tool.invoke.test', 'corr-log-1');
      simulateDealerMessage(factory.lastRouter!, 'dealer-log', wire);

      const frameLog = logEntries.find((e) => e.msg === 'frame received');
      expect(frameLog).toBeDefined();
      expect(frameLog!.correlation).toBe('corr-log-1');
      expect(frameLog!.topic).toBe('tool.invoke.test');
    });

    it('logs malformed JSON dropped as warning', async () => {
      channel = new RequestChannel(factory);
      channel.onRequest(vi.fn());
      await channel.bind('ipc:///tmp/test-log3.sock');

      const identity = makeIdentityBuffer('dealer-bad');
      const delimiter = Buffer.alloc(0);
      const badPayload = Buffer.from('not-valid-json');
      factory.lastRouter!.simulateMessage(identity, delimiter, badPayload);

      const dropLog = logEntries.find((e) => e.msg === 'malformed JSON dropped');
      expect(dropLog).toBeDefined();
      expect(dropLog!.level).toBe('warn');
    });

    it('logs response sent on sendResponse()', async () => {
      channel = new RequestChannel(factory);
      channel.onRequest(vi.fn());
      await channel.bind('ipc:///tmp/test-log4.sock');

      const wire = makeWireMessage('tool.invoke.test', 'corr-log-resp');
      simulateDealerMessage(factory.lastRouter!, 'dealer-resp', wire);

      await channel.sendResponse(makeIdentity('dealer-resp'), makeResponse('corr-log-resp'));

      const sentLog = logEntries.find((e) => e.msg === 'response sent');
      expect(sentLog).toBeDefined();
      expect(sentLog!.correlation).toBe('corr-log-resp');
    });

    it('logs request timed out as warning', async () => {
      channel = new RequestChannel(factory, { timeoutMs: 1000 });
      channel.onRequest(vi.fn());
      await channel.bind('ipc:///tmp/test-log5.sock');

      simulateDealerMessage(
        factory.lastRouter!,
        'dealer-timeout',
        makeWireMessage('tool.invoke.slow', 'corr-timeout-log'),
      );

      vi.advanceTimersByTime(1001);

      const timeoutLog = logEntries.find((e) => e.msg === 'request timed out');
      expect(timeoutLog).toBeDefined();
      expect(timeoutLog!.level).toBe('warn');
      expect(timeoutLog!.correlation).toBe('corr-timeout-log');
    });
  });
});
