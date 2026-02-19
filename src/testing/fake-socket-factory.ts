/**
 * Fake socket factory for testing.
 *
 * Implements SocketFactory using the in-memory fakes from fake-sockets.ts.
 * Tracks every created socket so tests can inspect them and cleanup()
 * closes them all at once.
 */

import type {
  SocketFactory,
  PublisherSocket,
  SubscriberSocket,
  RouterSocket,
  DealerSocket,
} from '../types/socket.js';

import {
  FakePubSocket,
  FakeSubSocket,
  FakeRouterSocket,
  FakeDealerSocket,
} from './fake-sockets.js';

/**
 * A SocketFactory that creates in-memory fake sockets.
 *
 * Usage in tests:
 *
 * ```ts
 * const factory = new FakeSocketFactory();
 * const router = factory.createRouter();
 * // ... use router ...
 * await factory.cleanup();
 * ```
 */
export class FakeSocketFactory implements SocketFactory {
  private readonly publishers: FakePubSocket[] = [];
  private readonly subscribers: FakeSubSocket[] = [];
  private readonly routers: FakeRouterSocket[] = [];
  private readonly dealers: FakeDealerSocket[] = [];

  createPublisher(): PublisherSocket {
    const socket = new FakePubSocket();
    this.publishers.push(socket);
    return socket;
  }

  createSubscriber(): SubscriberSocket {
    const socket = new FakeSubSocket();
    this.subscribers.push(socket);
    return socket;
  }

  createRouter(): RouterSocket {
    const socket = new FakeRouterSocket();
    this.routers.push(socket);
    return socket;
  }

  createDealer(): DealerSocket {
    const socket = new FakeDealerSocket();
    this.dealers.push(socket);
    return socket;
  }

  /** Get all publisher sockets created by this factory. */
  getPublishers(): readonly FakePubSocket[] {
    return this.publishers;
  }

  /** Get all subscriber sockets created by this factory. */
  getSubscribers(): readonly FakeSubSocket[] {
    return this.subscribers;
  }

  /** Get all router sockets created by this factory. */
  getRouters(): readonly FakeRouterSocket[] {
    return this.routers;
  }

  /** Get all dealer sockets created by this factory. */
  getDealers(): readonly FakeDealerSocket[] {
    return this.dealers;
  }

  /** Close all sockets created by this factory. */
  async cleanup(): Promise<void> {
    const all = [
      ...this.publishers.map((s) => s.close()),
      ...this.subscribers.map((s) => s.close()),
      ...this.routers.map((s) => s.close()),
      ...this.dealers.map((s) => s.close()),
    ];
    await Promise.all(all);
  }
}
