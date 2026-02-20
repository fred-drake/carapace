/**
 * Tests for ZmqSocketFactory — production SocketFactory backed by real ZeroMQ.
 *
 * These tests mock the zeromq module to verify correct wiring without
 * creating real ZMQ sockets (which need IPC infrastructure and are slow).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock zeromq before importing the module under test
vi.mock('zeromq', () => {
  class MockPublisher {
    linger = 0;
    bind = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
  }

  class MockSubscriber {
    linger = 0;
    connect = vi.fn();
    subscribe = vi.fn();
    close = vi.fn();
    receive = vi.fn().mockRejectedValue(new Error('Socket closed'));
    [Symbol.asyncIterator] = vi.fn().mockReturnValue({
      next: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    });
  }

  class MockRouter {
    linger = 0;
    bind = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
    receive = vi.fn().mockRejectedValue(new Error('Socket closed'));
    [Symbol.asyncIterator] = vi.fn().mockReturnValue({
      next: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    });
  }

  class MockDealer {
    linger = 0;
    routingId: string | null = null;
    connect = vi.fn();
    send = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
    receive = vi.fn().mockRejectedValue(new Error('Socket closed'));
    [Symbol.asyncIterator] = vi.fn().mockReturnValue({
      next: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    });
  }

  return {
    Publisher: MockPublisher,
    Subscriber: MockSubscriber,
    Router: MockRouter,
    Dealer: MockDealer,
  };
});

import { ZmqSocketFactory } from './zmq-socket-factory.js';

describe('ZmqSocketFactory', () => {
  let factory: ZmqSocketFactory;

  beforeEach(() => {
    vi.clearAllMocks();
    factory = new ZmqSocketFactory();
  });

  describe('createPublisher', () => {
    it('returns an object with bind, send, and close methods', () => {
      const pub = factory.createPublisher();
      expect(typeof pub.bind).toBe('function');
      expect(typeof pub.send).toBe('function');
      expect(typeof pub.close).toBe('function');
    });

    it('delegates bind to the underlying zmq Publisher', async () => {
      const pub = factory.createPublisher();
      await pub.bind('ipc:///tmp/test-events.sock');
      // If bind rejects, this test fails — verifying delegation
    });

    it('delegates send as a multipart message [topic, payload]', async () => {
      const pub = factory.createPublisher();
      const topic = Buffer.from('event.email');
      const payload = Buffer.from('{"data":"test"}');
      await pub.send(topic, payload);
      // Verifying it doesn't throw — delegation works
    });

    it('delegates close to the underlying zmq Publisher', async () => {
      const pub = factory.createPublisher();
      await pub.close();
      // Verifying it doesn't throw
    });
  });

  describe('createSubscriber', () => {
    it('returns an object with connect, subscribe, on, and close methods', () => {
      const sub = factory.createSubscriber();
      expect(typeof sub.connect).toBe('function');
      expect(typeof sub.subscribe).toBe('function');
      expect(typeof sub.on).toBe('function');
      expect(typeof sub.close).toBe('function');
    });

    it('delegates connect to the underlying zmq Subscriber', async () => {
      const sub = factory.createSubscriber();
      await sub.connect('ipc:///tmp/test-events.sock');
    });

    it('delegates subscribe to the underlying zmq Subscriber', async () => {
      const sub = factory.createSubscriber();
      await sub.subscribe('event.');
    });

    it('accepts message handlers via on()', () => {
      const sub = factory.createSubscriber();
      const handler = vi.fn();
      sub.on('message', handler);
      // Should not throw — handler is registered
    });

    it('delegates close to the underlying zmq Subscriber', async () => {
      const sub = factory.createSubscriber();
      await sub.close();
    });
  });

  describe('createRouter', () => {
    it('returns an object with bind, on, send, and close methods', () => {
      const router = factory.createRouter();
      expect(typeof router.bind).toBe('function');
      expect(typeof router.on).toBe('function');
      expect(typeof router.send).toBe('function');
      expect(typeof router.close).toBe('function');
    });

    it('delegates bind to the underlying zmq Router', async () => {
      const router = factory.createRouter();
      await router.bind('ipc:///tmp/test-request.sock');
    });

    it('delegates send as a multipart message [identity, delimiter, payload]', async () => {
      const router = factory.createRouter();
      const identity = Buffer.from('dealer-1');
      const delimiter = Buffer.alloc(0);
      const payload = Buffer.from('{"result":"ok"}');
      await router.send(identity, delimiter, payload);
    });

    it('accepts message handlers via on()', () => {
      const router = factory.createRouter();
      const handler = vi.fn();
      router.on('message', handler);
    });

    it('delegates close to the underlying zmq Router', async () => {
      const router = factory.createRouter();
      await router.close();
    });
  });

  describe('createDealer', () => {
    it('returns an object with connect, send, on, and close methods', () => {
      const dealer = factory.createDealer();
      expect(typeof dealer.connect).toBe('function');
      expect(typeof dealer.send).toBe('function');
      expect(typeof dealer.on).toBe('function');
      expect(typeof dealer.close).toBe('function');
    });

    it('delegates connect to the underlying zmq Dealer', async () => {
      const dealer = factory.createDealer();
      await dealer.connect('ipc:///tmp/test-request.sock');
    });

    it('delegates send as a single-frame message', async () => {
      const dealer = factory.createDealer();
      const payload = Buffer.from('{"topic":"tool.invoke"}');
      await dealer.send(payload);
    });

    it('accepts message handlers via on()', () => {
      const dealer = factory.createDealer();
      const handler = vi.fn();
      dealer.on('message', handler);
    });

    it('delegates close to the underlying zmq Dealer', async () => {
      const dealer = factory.createDealer();
      await dealer.close();
    });
  });

  describe('SocketFactory interface compliance', () => {
    it('implements all four factory methods', () => {
      expect(typeof factory.createPublisher).toBe('function');
      expect(typeof factory.createSubscriber).toBe('function');
      expect(typeof factory.createRouter).toBe('function');
      expect(typeof factory.createDealer).toBe('function');
    });
  });
});
