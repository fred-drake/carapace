/**
 * ZeroMQ PUB/SUB event bus for Carapace.
 *
 * The event bus carries external triggers that **start** sessions (e.g.
 * "email arrived", "cron fired"). It uses the PUB/SUB pattern over Unix
 * domain sockets.
 *
 * Wire format: 2-frame message
 *   Frame 1: topic string as UTF-8 Buffer
 *   Frame 2: full envelope JSON-serialized as UTF-8 Buffer
 *
 * See docs/ARCHITECTURE.md § "Messaging (ZeroMQ)" for the full spec.
 */

import type { PublisherSocket, SubscriberSocket, SocketFactory } from '../types/socket.js';
import type { Envelope, EventEnvelope } from '../types/protocol.js';

// ---------------------------------------------------------------------------
// SubscriptionHandle
// ---------------------------------------------------------------------------

/**
 * Handle returned by `EventBus.subscribe()`. Allows the caller to register
 * message handlers and to unsubscribe (closing the SUB socket).
 */
export interface SubscriptionHandle {
  /** Register a handler invoked for every matching incoming message. */
  onMessage(handler: (envelope: Envelope) => void): void;

  /** Unsubscribe and close the underlying SUB socket. */
  unsubscribe(): Promise<void>;
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

export class EventBus {
  private readonly socketFactory: SocketFactory;
  private publisher: PublisherSocket | null = null;
  private readonly subscriptions: Set<SubscriberSocket> = new Set();

  constructor(socketFactory: SocketFactory) {
    this.socketFactory = socketFactory;
  }

  // -------------------------------------------------------------------------
  // Publisher
  // -------------------------------------------------------------------------

  /**
   * Create a PUB socket and bind to the given address.
   *
   * @param address - Transport address, typically a Unix domain socket
   *   path like `"ipc:///tmp/carapace-events.sock"`.
   */
  async bind(address: string): Promise<void> {
    if (this.publisher) {
      throw new Error('EventBus is already bound');
    }
    this.publisher = this.socketFactory.createPublisher();
    await this.publisher.bind(address);
  }

  /**
   * Publish an event envelope to all subscribers whose topic subscription
   * matches the envelope's topic.
   *
   * Wire format:
   *   Frame 1 — topic string as UTF-8 Buffer
   *   Frame 2 — full envelope JSON as UTF-8 Buffer
   */
  async publish(envelope: EventEnvelope): Promise<void> {
    if (!this.publisher) {
      throw new Error('EventBus is not bound; call bind() first');
    }

    const topicBuffer = Buffer.from(envelope.topic, 'utf-8');
    const payloadBuffer = Buffer.from(JSON.stringify(envelope), 'utf-8');

    await this.publisher.send(topicBuffer, payloadBuffer);
  }

  // -------------------------------------------------------------------------
  // Subscriber
  // -------------------------------------------------------------------------

  /**
   * Create a SUB socket, connect to the publisher address, and subscribe
   * to the given topic prefixes.
   *
   * @param address - Transport address to connect to.
   * @param topics  - Topic prefixes to subscribe to. ZeroMQ SUB does
   *   prefix matching, so subscribing to `"tool.invoke"` receives
   *   `"tool.invoke.create_reminder"`, etc.
   * @returns A handle for registering message handlers and unsubscribing.
   */
  async subscribe(address: string, topics: string[]): Promise<SubscriptionHandle> {
    const socket = this.socketFactory.createSubscriber();
    await socket.connect(address);

    for (const topic of topics) {
      await socket.subscribe(topic);
    }

    this.subscriptions.add(socket);

    const handle: SubscriptionHandle = {
      onMessage(handler: (envelope: Envelope) => void): void {
        socket.on('message', (_topic: Buffer, payload: Buffer) => {
          const envelope = JSON.parse(payload.toString('utf-8')) as Envelope;
          handler(envelope);
        });
      },

      async unsubscribe(): Promise<void> {
        await socket.close();
      },
    };

    return handle;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Close the PUB socket and all SUB sockets, releasing all resources.
   */
  async close(): Promise<void> {
    const closeTasks: Promise<void>[] = [];

    if (this.publisher) {
      closeTasks.push(this.publisher.close());
      this.publisher = null;
    }

    for (const sub of this.subscriptions) {
      closeTasks.push(sub.close());
    }
    this.subscriptions.clear();

    await Promise.all(closeTasks);
  }
}
