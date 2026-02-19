import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from './event-bus.js';
import type {
  PublisherSocket,
  SubscriberSocket,
  SocketFactory,
  SubMessageHandler,
} from '../types/socket.js';
import type { EventEnvelope, Envelope } from '../types/protocol.js';

// ---------------------------------------------------------------------------
// Fake sockets — in-memory test doubles
// ---------------------------------------------------------------------------

/**
 * In-memory PUB socket fake. Records sent frames and exposes them via
 * `sentMessages` for assertions.
 */
class FakePublisherSocket implements PublisherSocket {
  readonly sentMessages: Array<{ topic: Buffer; payload: Buffer }> = [];
  bound = false;
  closed = false;

  /** All connected FakeSubscriberSockets (simulates PUB → SUB delivery). */
  readonly subscribers: Set<FakeSubscriberSocket> = new Set();

  async bind(_address: string): Promise<void> {
    this.bound = true;
  }

  async send(topic: Buffer, payload: Buffer): Promise<void> {
    this.sentMessages.push({ topic, payload });

    // Deliver to all connected subscribers whose subscriptions match.
    for (const sub of this.subscribers) {
      sub.deliver(topic, payload);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * In-memory SUB socket fake. Receives messages from the paired
 * FakePublisherSocket and dispatches to registered handlers when the
 * topic prefix matches a subscription.
 */
class FakeSubscriberSocket implements SubscriberSocket {
  private readonly topics: Set<string> = new Set();
  private readonly handlers: SubMessageHandler[] = [];
  connected = false;
  closed = false;

  /** The publisher this socket is connected to. Set externally by the factory. */
  publisher: FakePublisherSocket | null = null;

  async connect(_address: string): Promise<void> {
    this.connected = true;
    // Register with the publisher so it can push messages to us.
    if (this.publisher) {
      this.publisher.subscribers.add(this);
    }
  }

  async subscribe(topic: string): Promise<void> {
    this.topics.add(topic);
  }

  on(_event: 'message', handler: SubMessageHandler): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.publisher) {
      this.publisher.subscribers.delete(this);
    }
  }

  /**
   * Called by FakePublisherSocket to deliver a message. Checks topic
   * prefix matching (mimics ZeroMQ SUB filtering) and dispatches to
   * all registered handlers.
   */
  deliver(topicBuffer: Buffer, payloadBuffer: Buffer): void {
    if (this.closed) return;

    const topicStr = topicBuffer.toString('utf-8');

    // ZeroMQ SUB does prefix matching on the topic.
    const matches = [...this.topics].some((prefix) => topicStr.startsWith(prefix));
    if (!matches) return;

    for (const handler of this.handlers) {
      handler(topicBuffer, payloadBuffer);
    }
  }
}

/**
 * Factory that produces fake sockets wired together: every subscriber
 * created by this factory automatically connects to the publisher.
 */
class FakeSocketFactory implements SocketFactory {
  readonly publishers: FakePublisherSocket[] = [];
  readonly subscribers: FakeSubscriberSocket[] = [];

  /** The most-recently created publisher (used to wire up subscribers). */
  private currentPublisher: FakePublisherSocket | null = null;

  createPublisher(): PublisherSocket {
    const pub = new FakePublisherSocket();
    this.currentPublisher = pub;
    this.publishers.push(pub);
    return pub;
  }

  createSubscriber(): SubscriberSocket {
    const sub = new FakeSubscriberSocket();
    // Wire the subscriber to the current publisher so delivery works.
    sub.publisher = this.currentPublisher;
    this.subscribers.push(sub);
    return sub;
  }

  createRouter(): never {
    throw new Error('Not implemented in FakeSocketFactory');
  }

  createDealer(): never {
    throw new Error('Not implemented in FakeSocketFactory');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEventEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: 'evt-1',
    version: 1,
    type: 'event',
    topic: 'message.inbound',
    source: 'telegram',
    correlation: null,
    timestamp: '2026-02-18T10:00:00Z',
    group: 'family-chat',
    payload: { channel: 'telegram', body: 'Hello' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventBus', () => {
  let factory: FakeSocketFactory;
  let bus: EventBus;

  beforeEach(() => {
    factory = new FakeSocketFactory();
    bus = new EventBus(factory);
  });

  // -------------------------------------------------------------------------
  // publish
  // -------------------------------------------------------------------------

  describe('publish', () => {
    it('sends a 2-frame message: topic buffer + envelope JSON buffer', async () => {
      await bus.bind('ipc:///tmp/test-events.sock');

      const envelope = makeEventEnvelope();
      await bus.publish(envelope);

      const pub = factory.publishers[0]!;
      expect(pub.sentMessages).toHaveLength(1);

      const sent = pub.sentMessages[0]!;

      // Frame 1: topic as UTF-8 buffer
      expect(sent.topic.toString('utf-8')).toBe('message.inbound');

      // Frame 2: full envelope as JSON buffer
      const decoded = JSON.parse(sent.payload.toString('utf-8'));
      expect(decoded).toEqual(envelope);
    });

    it('throws if publish is called before bind', async () => {
      const envelope = makeEventEnvelope();
      await expect(bus.publish(envelope)).rejects.toThrow('EventBus is not bound');
    });
  });

  // -------------------------------------------------------------------------
  // bind
  // -------------------------------------------------------------------------

  describe('bind', () => {
    it('throws if called twice', async () => {
      await bus.bind('ipc:///tmp/test.sock');
      await expect(bus.bind('ipc:///tmp/test2.sock')).rejects.toThrow('EventBus is already bound');
    });
  });

  // -------------------------------------------------------------------------
  // subscribe + message delivery
  // -------------------------------------------------------------------------

  describe('subscribe', () => {
    it('receives published messages for matching topics', async () => {
      await bus.bind('ipc:///tmp/test.sock');

      const handle = await bus.subscribe('ipc:///tmp/test.sock', ['message.inbound']);

      const received: Envelope[] = [];
      handle.onMessage((env) => received.push(env));

      const envelope = makeEventEnvelope();
      await bus.publish(envelope);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(envelope);
    });

    it('topic prefix filtering works', async () => {
      await bus.bind('ipc:///tmp/test.sock');

      // Subscribe to 'tool.invoke' prefix — should match 'tool.invoke.create_reminder'
      const handle = await bus.subscribe('ipc:///tmp/test.sock', ['tool.invoke']);

      const received: Envelope[] = [];
      handle.onMessage((env) => received.push(env));

      const envelope = makeEventEnvelope({
        topic: 'tool.invoke.create_reminder',
        payload: { tool: 'create_reminder' },
      });
      await bus.publish(envelope);

      expect(received).toHaveLength(1);
      expect(received[0]!.topic).toBe('tool.invoke.create_reminder');
    });

    it('unsubscribed topics are not received', async () => {
      await bus.bind('ipc:///tmp/test.sock');

      // Subscribe only to 'agent.started'
      const handle = await bus.subscribe('ipc:///tmp/test.sock', ['agent.started']);

      const received: Envelope[] = [];
      handle.onMessage((env) => received.push(env));

      // Publish on a different topic
      const envelope = makeEventEnvelope({ topic: 'message.inbound' });
      await bus.publish(envelope);

      expect(received).toHaveLength(0);
    });

    it('multi-subscriber delivery — two subs on same topic both receive', async () => {
      await bus.bind('ipc:///tmp/test.sock');

      const handle1 = await bus.subscribe('ipc:///tmp/test.sock', ['message.inbound']);
      const handle2 = await bus.subscribe('ipc:///tmp/test.sock', ['message.inbound']);

      const received1: Envelope[] = [];
      const received2: Envelope[] = [];
      handle1.onMessage((env) => received1.push(env));
      handle2.onMessage((env) => received2.push(env));

      const envelope = makeEventEnvelope();
      await bus.publish(envelope);

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received1[0]).toEqual(envelope);
      expect(received2[0]).toEqual(envelope);
    });
  });

  // -------------------------------------------------------------------------
  // unsubscribe
  // -------------------------------------------------------------------------

  describe('unsubscribe', () => {
    it('stops delivery after unsubscribe', async () => {
      await bus.bind('ipc:///tmp/test.sock');

      const handle = await bus.subscribe('ipc:///tmp/test.sock', ['message.inbound']);

      const received: Envelope[] = [];
      handle.onMessage((env) => received.push(env));

      // First message — should be delivered
      await bus.publish(makeEventEnvelope());
      expect(received).toHaveLength(1);

      // Unsubscribe
      await handle.unsubscribe();

      // Second message — should NOT be delivered
      await bus.publish(makeEventEnvelope({ id: 'evt-2' }));
      expect(received).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('closes the PUB socket and all SUB sockets', async () => {
      await bus.bind('ipc:///tmp/test.sock');

      await bus.subscribe('ipc:///tmp/test.sock', ['message.inbound']);
      await bus.subscribe('ipc:///tmp/test.sock', ['agent.started']);

      await bus.close();

      const pub = factory.publishers[0] as FakePublisherSocket;
      expect(pub.closed).toBe(true);

      for (const sub of factory.subscribers) {
        expect((sub as FakeSubscriberSocket).closed).toBe(true);
      }
    });

    it('is safe to call close on an unbound bus', async () => {
      // Should not throw
      await bus.close();
    });

    it('publish throws after close', async () => {
      await bus.bind('ipc:///tmp/test.sock');
      await bus.close();

      await expect(bus.publish(makeEventEnvelope())).rejects.toThrow('EventBus is not bound');
    });
  });
});
