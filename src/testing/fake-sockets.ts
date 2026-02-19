/**
 * In-memory fake socket implementations for testing.
 *
 * These fakes implement the socket interfaces from types/socket.ts and
 * communicate entirely in-process — no real ZeroMQ, no network, no IPC.
 *
 * Key design decisions:
 *   - Messages are delivered synchronously inside send() so tests are
 *     deterministic without needing to await ticks.
 *   - Every fake records sent/received messages for assertion.
 *   - Error injection lets tests simulate connection refused, timeouts,
 *     and oversized payloads without touching real I/O.
 */

import type {
  PublisherSocket,
  SubscriberSocket,
  RouterSocket,
  DealerSocket,
  SubMessageHandler,
  RouterMessageHandler,
  DealerMessageHandler,
} from '../types/socket.js';

// ---------------------------------------------------------------------------
// Error injection
// ---------------------------------------------------------------------------

/** Error types that can be injected into fake sockets. */
export type InjectedErrorType = 'refused' | 'timeout' | 'oversized';

/**
 * Shared error injection state. When set, the next I/O operation
 * consumes the injected error and throws.
 */
interface ErrorInjection {
  pendingError: InjectedErrorType | null;
}

/** Consume a pending error if one is queued, throwing the appropriate Error. */
function consumeError(state: ErrorInjection): void {
  const err = state.pendingError;
  if (err === null) return;

  state.pendingError = null;

  switch (err) {
    case 'refused':
      throw new Error('Connection refused');
    case 'timeout':
      throw new Error('Operation timed out');
    case 'oversized':
      throw new Error('Message exceeds maximum size');
  }
}

// ---------------------------------------------------------------------------
// Recorded message types
// ---------------------------------------------------------------------------

/** A topic + payload pair stored by PUB and SUB sockets. */
export interface PubSubMessage {
  topic: Buffer;
  payload: Buffer;
}

/** A framed message stored by ROUTER sockets (identity + delimiter + payload). */
export interface RouterMessage {
  identity: Buffer;
  delimiter: Buffer;
  payload: Buffer;
}

/** A single payload stored by DEALER sockets. */
export interface DealerMessage {
  payload: Buffer;
}

// ---------------------------------------------------------------------------
// Fake PUB socket
// ---------------------------------------------------------------------------

/**
 * In-memory publisher. Maintains a set of connected FakeSubSockets and
 * delivers messages to subscribers whose topic subscription is a prefix
 * match of the sent topic.
 */
export class FakePubSocket implements PublisherSocket, ErrorInjection {
  /** All messages sent through this publisher. */
  readonly sent: PubSubMessage[] = [];

  /** Connected subscribers that will receive broadcasts. */
  readonly subscribers: Set<FakeSubSocket> = new Set();

  /** Address this socket is bound to (null until bind()). */
  boundAddress: string | null = null;

  /** Whether the socket has been closed. */
  closed = false;

  /** @internal Error injection state. */
  pendingError: InjectedErrorType | null = null;

  async bind(address: string): Promise<void> {
    this.assertOpen();
    consumeError(this);
    this.boundAddress = address;
  }

  async send(topic: Buffer, payload: Buffer): Promise<void> {
    this.assertOpen();
    consumeError(this);

    const msg: PubSubMessage = { topic, payload };
    this.sent.push(msg);

    // Deliver to all subscribers whose subscription is a prefix of the topic.
    const topicStr = topic.toString();
    for (const sub of this.subscribers) {
      for (const prefix of sub.subscriptions) {
        if (topicStr.startsWith(prefix)) {
          sub.received.push({ topic: Buffer.from(topic), payload: Buffer.from(payload) });
          for (const handler of sub.handlers) {
            handler(Buffer.from(topic), Buffer.from(payload));
          }
          // Only deliver once per subscriber even if multiple subscriptions match.
          break;
        }
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Queue an error that will be thrown on the next I/O operation. */
  injectError(type: InjectedErrorType): void {
    this.pendingError = type;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Socket is closed');
    }
  }
}

// ---------------------------------------------------------------------------
// Fake SUB socket
// ---------------------------------------------------------------------------

/**
 * In-memory subscriber. Connects to a FakePubSocket and receives messages
 * whose topic matches a subscribed prefix.
 */
export class FakeSubSocket implements SubscriberSocket, ErrorInjection {
  /** All messages received by this subscriber. */
  readonly received: PubSubMessage[] = [];

  /** Set of subscribed topic prefixes. */
  readonly subscriptions: Set<string> = new Set();

  /** Registered message handlers. */
  readonly handlers: SubMessageHandler[] = [];

  /** The publisher this subscriber is connected to (null until connect()). */
  connectedTo: FakePubSocket | null = null;

  /** Whether the socket has been closed. */
  closed = false;

  /** @internal Error injection state. */
  pendingError: InjectedErrorType | null = null;

  /**
   * Connect to a publisher.
   *
   * In production ZeroMQ, connect() takes an address string. In the fake
   * implementation the caller must wire the pair manually via
   * `wireFakePair()` or by setting `connectedTo` before calling connect().
   *
   * When `connectedTo` is already set (by wireFakePair), this registers
   * the subscriber with the publisher so it receives future messages.
   */
  async connect(_address: string): Promise<void> {
    this.assertOpen();
    consumeError(this);

    if (this.connectedTo) {
      this.connectedTo.subscribers.add(this);
    }
  }

  async subscribe(topic: string): Promise<void> {
    this.assertOpen();
    consumeError(this);
    this.subscriptions.add(topic);
  }

  on(_event: 'message', handler: SubMessageHandler): void {
    this.assertOpen();
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    if (this.connectedTo) {
      this.connectedTo.subscribers.delete(this);
    }
    this.closed = true;
  }

  /** Queue an error that will be thrown on the next I/O operation. */
  injectError(type: InjectedErrorType): void {
    this.pendingError = type;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Socket is closed');
    }
  }
}

// ---------------------------------------------------------------------------
// Fake ROUTER socket
// ---------------------------------------------------------------------------

/** Counter for generating unique dealer identities. */
let dealerIdCounter = 0;

/**
 * In-memory router. Tracks connected dealers by identity and routes
 * messages to the correct dealer based on the identity frame.
 */
export class FakeRouterSocket implements RouterSocket, ErrorInjection {
  /** All messages sent through this router. */
  readonly sent: RouterMessage[] = [];

  /** All messages received from connected dealers. */
  readonly received: RouterMessage[] = [];

  /** Connected dealers indexed by identity string. */
  readonly dealers: Map<string, FakeDealerSocket> = new Map();

  /** Registered message handlers. */
  readonly handlers: RouterMessageHandler[] = [];

  /** Address this socket is bound to (null until bind()). */
  boundAddress: string | null = null;

  /** Whether the socket has been closed. */
  closed = false;

  /** @internal Error injection state. */
  pendingError: InjectedErrorType | null = null;

  async bind(address: string): Promise<void> {
    this.assertOpen();
    consumeError(this);
    this.boundAddress = address;
  }

  on(_event: 'message', handler: RouterMessageHandler): void {
    this.assertOpen();
    this.handlers.push(handler);
  }

  async send(identity: Buffer, delimiter: Buffer, payload: Buffer): Promise<void> {
    this.assertOpen();
    consumeError(this);

    const msg: RouterMessage = { identity, delimiter, payload };
    this.sent.push(msg);

    // Route to the correct dealer.
    const identityStr = identity.toString();
    const dealer = this.dealers.get(identityStr);
    if (dealer) {
      const deliveredPayload = Buffer.from(payload);
      dealer.received.push({ payload: deliveredPayload });
      for (const handler of dealer.handlers) {
        handler(deliveredPayload);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Queue an error that will be thrown on the next I/O operation. */
  injectError(type: InjectedErrorType): void {
    this.pendingError = type;
  }

  /**
   * @internal Called by FakeDealerSocket.connect() to register itself
   * with this router under a given identity.
   */
  registerDealer(identity: string, dealer: FakeDealerSocket): void {
    this.dealers.set(identity, dealer);
  }

  /**
   * @internal Called by FakeDealerSocket when it sends a message.
   * The router receives [identity, empty delimiter, payload] just like
   * real ZeroMQ ROUTER sockets.
   */
  deliverFromDealer(identity: Buffer, payload: Buffer): void {
    const delimiter = Buffer.alloc(0);
    const msg: RouterMessage = {
      identity: Buffer.from(identity),
      delimiter,
      payload: Buffer.from(payload),
    };
    this.received.push(msg);

    for (const handler of this.handlers) {
      handler(Buffer.from(identity), Buffer.alloc(0), Buffer.from(payload));
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Socket is closed');
    }
  }
}

// ---------------------------------------------------------------------------
// Fake DEALER socket
// ---------------------------------------------------------------------------

/**
 * In-memory dealer. Connects to a FakeRouterSocket with a unique identity
 * and exchanges single-frame payloads.
 */
export class FakeDealerSocket implements DealerSocket, ErrorInjection {
  /** All messages sent by this dealer. */
  readonly sent: DealerMessage[] = [];

  /** All messages received from the router. */
  readonly received: DealerMessage[] = [];

  /** Registered message handlers. */
  readonly handlers: DealerMessageHandler[] = [];

  /** The unique identity assigned to this dealer. */
  readonly identity: Buffer;

  /** The router this dealer is connected to (null until connect()). */
  connectedTo: FakeRouterSocket | null = null;

  /** Whether the socket has been closed. */
  closed = false;

  /** @internal Error injection state. */
  pendingError: InjectedErrorType | null = null;

  constructor() {
    dealerIdCounter += 1;
    this.identity = Buffer.from(`dealer-${dealerIdCounter}`);
  }

  /**
   * Connect to a router.
   *
   * Like FakeSubSocket, the caller must wire the pair via wireFakePair()
   * or set `connectedTo` before calling connect().
   */
  async connect(_address: string): Promise<void> {
    this.assertOpen();
    consumeError(this);

    if (this.connectedTo) {
      this.connectedTo.registerDealer(this.identity.toString(), this);
    }
  }

  async send(payload: Buffer): Promise<void> {
    this.assertOpen();
    consumeError(this);

    const msg: DealerMessage = { payload };
    this.sent.push(msg);

    // Deliver to the connected router with the dealer's identity.
    if (this.connectedTo) {
      this.connectedTo.deliverFromDealer(this.identity, payload);
    }
  }

  on(_event: 'message', handler: DealerMessageHandler): void {
    this.assertOpen();
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Queue an error that will be thrown on the next I/O operation. */
  injectError(type: InjectedErrorType): void {
    this.pendingError = type;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Socket is closed');
    }
  }
}

// ---------------------------------------------------------------------------
// Wiring helpers
// ---------------------------------------------------------------------------

/** Result of wiring a PUB/SUB fake pair. */
export interface FakePubSubPair {
  pub: FakePubSocket;
  sub: FakeSubSocket;
}

/** Result of wiring a ROUTER/DEALER fake pair. */
export interface FakeRouterDealerPair {
  router: FakeRouterSocket;
  dealer: FakeDealerSocket;
}

/**
 * Create and connect a PUB + SUB fake pair.
 *
 * The subscriber is wired to the publisher so that calling `pub.send()`
 * delivers to the subscriber immediately. Both sockets are bound/connected
 * to a synthetic address.
 */
export async function wireFakePubSub(): Promise<FakePubSubPair> {
  const pub = new FakePubSocket();
  const sub = new FakeSubSocket();
  const address = `inproc://fake-pubsub-${Date.now()}`;

  await pub.bind(address);
  sub.connectedTo = pub;
  await sub.connect(address);

  return { pub, sub };
}

/**
 * Create and connect a ROUTER + DEALER fake pair.
 *
 * The dealer is wired to the router so that calling `dealer.send()`
 * delivers to the router, and `router.send()` with the dealer's identity
 * delivers back to the dealer.
 */
export async function wireFakeRouterDealer(): Promise<FakeRouterDealerPair> {
  const router = new FakeRouterSocket();
  const dealer = new FakeDealerSocket();
  const address = `inproc://fake-rd-${Date.now()}`;

  await router.bind(address);
  dealer.connectedTo = router;
  await dealer.connect(address);

  return { router, dealer };
}
