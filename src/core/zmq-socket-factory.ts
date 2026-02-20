/**
 * Production SocketFactory backed by real ZeroMQ sockets.
 *
 * Wraps the zeromq v6 API into the Carapace socket abstractions defined
 * in src/types/socket.ts. Each wrapper class adapts the zmq class-based
 * API (async iterators, multipart arrays) into the callback-based
 * interfaces that the core messaging layer expects.
 *
 * @see src/types/socket.ts for the interfaces
 * @see src/testing/fake-socket-factory.ts for the test double
 */

import * as zmq from 'zeromq';

import type {
  SocketFactory,
  PublisherSocket,
  SubscriberSocket,
  RouterSocket,
  DealerSocket,
  SubMessageHandler,
  RouterMessageHandler,
  DealerMessageHandler,
} from '../types/socket.js';

// ---------------------------------------------------------------------------
// ZMQ Publisher adapter
// ---------------------------------------------------------------------------

class ZmqPublisherSocket implements PublisherSocket {
  private readonly socket: zmq.Publisher;

  constructor() {
    this.socket = new zmq.Publisher();
    this.socket.linger = 0;
  }

  async bind(address: string): Promise<void> {
    await this.socket.bind(address);
  }

  async send(topic: Buffer, payload: Buffer): Promise<void> {
    await this.socket.send([topic, payload]);
  }

  async close(): Promise<void> {
    this.socket.close();
  }
}

// ---------------------------------------------------------------------------
// ZMQ Subscriber adapter
// ---------------------------------------------------------------------------

class ZmqSubscriberSocket implements SubscriberSocket {
  private readonly socket: zmq.Subscriber;
  private readonly handlers: SubMessageHandler[] = [];
  private receiving = false;

  constructor() {
    this.socket = new zmq.Subscriber();
    this.socket.linger = 0;
  }

  async connect(address: string): Promise<void> {
    this.socket.connect(address);
  }

  async subscribe(topic: string): Promise<void> {
    this.socket.subscribe(topic);
  }

  on(_event: 'message', handler: SubMessageHandler): void {
    this.handlers.push(handler);
    this.startReceiving();
  }

  async close(): Promise<void> {
    this.receiving = false;
    this.socket.close();
  }

  private startReceiving(): void {
    if (this.receiving) return;
    this.receiving = true;

    void (async () => {
      try {
        for await (const [topic, payload] of this.socket) {
          for (const handler of this.handlers) {
            handler(topic, payload);
          }
        }
      } catch {
        // Socket closed — stop receiving
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// ZMQ Router adapter
// ---------------------------------------------------------------------------

class ZmqRouterSocket implements RouterSocket {
  private readonly socket: zmq.Router;
  private readonly handlers: RouterMessageHandler[] = [];
  private receiving = false;

  constructor() {
    this.socket = new zmq.Router();
    this.socket.linger = 0;
  }

  async bind(address: string): Promise<void> {
    await this.socket.bind(address);
  }

  on(_event: 'message', handler: RouterMessageHandler): void {
    this.handlers.push(handler);
    this.startReceiving();
  }

  async send(identity: Buffer, delimiter: Buffer, payload: Buffer): Promise<void> {
    await this.socket.send([identity, delimiter, payload]);
  }

  async close(): Promise<void> {
    this.receiving = false;
    this.socket.close();
  }

  private startReceiving(): void {
    if (this.receiving) return;
    this.receiving = true;

    void (async () => {
      try {
        for await (const [identity, delimiter, payload] of this.socket) {
          for (const handler of this.handlers) {
            handler(identity, delimiter, payload);
          }
        }
      } catch {
        // Socket closed — stop receiving
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// ZMQ Dealer adapter
// ---------------------------------------------------------------------------

class ZmqDealerSocket implements DealerSocket {
  private readonly socket: zmq.Dealer;
  private readonly handlers: DealerMessageHandler[] = [];
  private receiving = false;

  constructor() {
    this.socket = new zmq.Dealer();
    this.socket.linger = 0;
  }

  async connect(address: string): Promise<void> {
    this.socket.connect(address);
  }

  async send(payload: Buffer): Promise<void> {
    await this.socket.send([payload]);
  }

  on(_event: 'message', handler: DealerMessageHandler): void {
    this.handlers.push(handler);
    this.startReceiving();
  }

  async close(): Promise<void> {
    this.receiving = false;
    this.socket.close();
  }

  private startReceiving(): void {
    if (this.receiving) return;
    this.receiving = true;

    void (async () => {
      try {
        for await (const [payload] of this.socket) {
          for (const handler of this.handlers) {
            handler(payload);
          }
        }
      } catch {
        // Socket closed — stop receiving
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Production SocketFactory that creates real ZeroMQ sockets.
 *
 * Each socket is created with `linger = 0` so close() doesn't block
 * waiting for unsent messages — appropriate for IPC-based local sockets
 * where the peer is always on the same machine.
 */
export class ZmqSocketFactory implements SocketFactory {
  createPublisher(): PublisherSocket {
    return new ZmqPublisherSocket();
  }

  createSubscriber(): SubscriberSocket {
    return new ZmqSubscriberSocket();
  }

  createRouter(): RouterSocket {
    return new ZmqRouterSocket();
  }

  createDealer(): DealerSocket {
    return new ZmqDealerSocket();
  }
}
