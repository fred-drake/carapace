/**
 * Carapace socket abstraction interfaces.
 *
 * These interfaces decouple the messaging layer from the concrete ZeroMQ
 * implementation so that tests can swap in fake (in-memory) sockets without
 * touching real network I/O.
 *
 * Four socket roles mirror the two ZeroMQ channels described in
 * docs/ARCHITECTURE.md:
 *
 *   PUB/SUB   — Event Bus (external triggers that start sessions)
 *   ROUTER/DEALER — Request Channel (tool invocations during sessions)
 *
 * Every I/O method returns Promise<void>. Message delivery uses a callback
 * registration pattern rather than Node EventEmitter so that implementations
 * stay framework-agnostic.
 */

// ---------------------------------------------------------------------------
// Message handler types
// ---------------------------------------------------------------------------

/** Handler for SUB socket incoming messages (topic + payload frames). */
export type SubMessageHandler = (topic: Buffer, payload: Buffer) => void;

/** Handler for ROUTER socket incoming messages (identity + delimiter + payload). */
export type RouterMessageHandler = (identity: Buffer, delimiter: Buffer, payload: Buffer) => void;

/** Handler for DEALER socket incoming messages (payload frame only). */
export type DealerMessageHandler = (payload: Buffer) => void;

// ---------------------------------------------------------------------------
// PUB socket
// ---------------------------------------------------------------------------

/**
 * Publisher side of the PUB/SUB event bus.
 *
 * Binds to an address and broadcasts topic-prefixed messages to all
 * connected subscribers.
 */
export interface PublisherSocket {
  /** Bind to a transport address (e.g. "ipc:///tmp/carapace-events.sock"). */
  bind(address: string): Promise<void>;

  /** Send a two-frame message: topic prefix + payload. */
  send(topic: Buffer, payload: Buffer): Promise<void>;

  /** Close the socket and release resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SUB socket
// ---------------------------------------------------------------------------

/**
 * Subscriber side of the PUB/SUB event bus.
 *
 * Connects to a publisher and receives messages matching subscribed topic
 * prefixes.
 */
export interface SubscriberSocket {
  /** Connect to a publisher address. */
  connect(address: string): Promise<void>;

  /** Subscribe to messages whose topic starts with the given prefix. */
  subscribe(topic: string): Promise<void>;

  /** Register a handler invoked for every matching incoming message. */
  on(event: 'message', handler: SubMessageHandler): void;

  /** Close the socket and release resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// ROUTER socket
// ---------------------------------------------------------------------------

/**
 * Router side of the ROUTER/DEALER request channel.
 *
 * Binds to an address and multiplexes messages to/from multiple dealer
 * connections. Each dealer is identified by a unique identity frame.
 */
export interface RouterSocket {
  /** Bind to a transport address. */
  bind(address: string): Promise<void>;

  /**
   * Register a handler for incoming messages.
   * Messages arrive as [identity, delimiter (empty), payload].
   */
  on(event: 'message', handler: RouterMessageHandler): void;

  /**
   * Send a message to a specific dealer.
   * Frames: [identity, delimiter (empty), payload].
   */
  send(identity: Buffer, delimiter: Buffer, payload: Buffer): Promise<void>;

  /** Close the socket and release resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// DEALER socket
// ---------------------------------------------------------------------------

/**
 * Dealer side of the ROUTER/DEALER request channel.
 *
 * Connects to a router and exchanges single-frame payloads. The router
 * prepends/strips the identity frame transparently.
 */
export interface DealerSocket {
  /** Connect to a router address. */
  connect(address: string): Promise<void>;

  /** Send a single payload frame to the router. */
  send(payload: Buffer): Promise<void>;

  /** Register a handler for incoming messages from the router. */
  on(event: 'message', handler: DealerMessageHandler): void;

  /** Close the socket and release resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Socket factory
// ---------------------------------------------------------------------------

/**
 * Abstract factory for creating socket instances.
 *
 * Production code injects a factory backed by real ZeroMQ sockets; tests
 * inject a FakeSocketFactory that creates in-memory fakes.
 */
export interface SocketFactory {
  /** Create a new PUB socket. */
  createPublisher(): PublisherSocket;

  /** Create a new SUB socket. */
  createSubscriber(): SubscriberSocket;

  /** Create a new ROUTER socket. */
  createRouter(): RouterSocket;

  /** Create a new DEALER socket. */
  createDealer(): DealerSocket;
}
