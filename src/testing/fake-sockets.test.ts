import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  FakePubSocket,
  FakeSubSocket,
  FakeRouterSocket,
  FakeDealerSocket,
  wireFakePubSub,
  wireFakeRouterDealer,
} from './fake-sockets.js';
import { FakeSocketFactory } from './fake-socket-factory.js';

// ---------------------------------------------------------------------------
// PUB/SUB
// ---------------------------------------------------------------------------

describe('FakePubSocket / FakeSubSocket', () => {
  describe('basic publish and subscribe', () => {
    it('delivers a message to a subscribed subscriber', async () => {
      const { pub, sub } = await wireFakePubSub();
      await sub.subscribe('event.');

      const topic = Buffer.from('event.created');
      const payload = Buffer.from('{"id":1}');
      await pub.send(topic, payload);

      expect(sub.received).toHaveLength(1);
      expect(sub.received[0].topic.toString()).toBe('event.created');
      expect(sub.received[0].payload.toString()).toBe('{"id":1}');
    });

    it('invokes the message handler on the subscriber', async () => {
      const { pub, sub } = await wireFakePubSub();
      await sub.subscribe('event.');

      const received: Array<{ topic: string; payload: string }> = [];
      sub.on('message', (topic, payload) => {
        received.push({ topic: topic.toString(), payload: payload.toString() });
      });

      await pub.send(Buffer.from('event.created'), Buffer.from('hello'));

      expect(received).toHaveLength(1);
      expect(received[0].topic).toBe('event.created');
      expect(received[0].payload).toBe('hello');
    });

    it('records sent messages on the publisher', async () => {
      const { pub, sub } = await wireFakePubSub();
      await sub.subscribe('');

      await pub.send(Buffer.from('a'), Buffer.from('1'));
      await pub.send(Buffer.from('b'), Buffer.from('2'));

      expect(pub.sent).toHaveLength(2);
      expect(pub.sent[0].topic.toString()).toBe('a');
      expect(pub.sent[1].topic.toString()).toBe('b');
    });
  });

  describe('topic prefix filtering', () => {
    it('delivers only messages matching the subscribed prefix', async () => {
      const { pub, sub } = await wireFakePubSub();
      await sub.subscribe('agent.');

      await pub.send(Buffer.from('agent.started'), Buffer.from('yes'));
      await pub.send(Buffer.from('plugin.ready'), Buffer.from('no'));
      await pub.send(Buffer.from('agent.error'), Buffer.from('also yes'));

      expect(sub.received).toHaveLength(2);
      expect(sub.received[0].topic.toString()).toBe('agent.started');
      expect(sub.received[1].topic.toString()).toBe('agent.error');
    });

    it('empty string subscription matches all topics', async () => {
      const { pub, sub } = await wireFakePubSub();
      await sub.subscribe('');

      await pub.send(Buffer.from('a'), Buffer.from('1'));
      await pub.send(Buffer.from('b'), Buffer.from('2'));
      await pub.send(Buffer.from('c'), Buffer.from('3'));

      expect(sub.received).toHaveLength(3);
    });

    it('does not deliver to unsubscribed topics', async () => {
      const { pub, sub } = await wireFakePubSub();
      await sub.subscribe('task.');

      await pub.send(Buffer.from('agent.started'), Buffer.from('nope'));

      expect(sub.received).toHaveLength(0);
    });

    it('supports multiple subscriptions on one subscriber', async () => {
      const { pub, sub } = await wireFakePubSub();
      await sub.subscribe('agent.');
      await sub.subscribe('task.');

      await pub.send(Buffer.from('agent.started'), Buffer.from('1'));
      await pub.send(Buffer.from('task.created'), Buffer.from('2'));
      await pub.send(Buffer.from('plugin.ready'), Buffer.from('3'));

      expect(sub.received).toHaveLength(2);
    });

    it('delivers only once per subscriber even if multiple subscriptions match', async () => {
      const { pub, sub } = await wireFakePubSub();
      await sub.subscribe('agent');
      await sub.subscribe('agent.started');

      await pub.send(Buffer.from('agent.started'), Buffer.from('data'));

      // Should receive exactly 1 message, not 2.
      expect(sub.received).toHaveLength(1);
    });
  });

  describe('multi-subscriber delivery', () => {
    it('delivers to all connected subscribers', async () => {
      const pub = new FakePubSocket();
      await pub.bind('inproc://multi-sub-test');

      const sub1 = new FakeSubSocket();
      sub1.connectedTo = pub;
      await sub1.connect('inproc://multi-sub-test');
      await sub1.subscribe('event.');

      const sub2 = new FakeSubSocket();
      sub2.connectedTo = pub;
      await sub2.connect('inproc://multi-sub-test');
      await sub2.subscribe('event.');

      await pub.send(Buffer.from('event.created'), Buffer.from('data'));

      expect(sub1.received).toHaveLength(1);
      expect(sub2.received).toHaveLength(1);
    });

    it('delivers based on each subscriber individual subscription', async () => {
      const pub = new FakePubSocket();
      await pub.bind('inproc://filter-test');

      const sub1 = new FakeSubSocket();
      sub1.connectedTo = pub;
      await sub1.connect('inproc://filter-test');
      await sub1.subscribe('agent.');

      const sub2 = new FakeSubSocket();
      sub2.connectedTo = pub;
      await sub2.connect('inproc://filter-test');
      await sub2.subscribe('task.');

      await pub.send(Buffer.from('agent.started'), Buffer.from('a'));
      await pub.send(Buffer.from('task.created'), Buffer.from('t'));

      expect(sub1.received).toHaveLength(1);
      expect(sub1.received[0].topic.toString()).toBe('agent.started');

      expect(sub2.received).toHaveLength(1);
      expect(sub2.received[0].topic.toString()).toBe('task.created');
    });
  });

  describe('bind address tracking', () => {
    it('records the bound address', async () => {
      const pub = new FakePubSocket();
      expect(pub.boundAddress).toBeNull();

      await pub.bind('ipc:///tmp/test.sock');
      expect(pub.boundAddress).toBe('ipc:///tmp/test.sock');
    });
  });
});

// ---------------------------------------------------------------------------
// ROUTER/DEALER
// ---------------------------------------------------------------------------

describe('FakeRouterSocket / FakeDealerSocket', () => {
  describe('dealer sends to router', () => {
    it('delivers a message from dealer to router', async () => {
      const { router, dealer } = await wireFakeRouterDealer();

      const received: Array<{ identity: string; payload: string }> = [];
      router.on('message', (identity, _delimiter, payload) => {
        received.push({
          identity: identity.toString(),
          payload: payload.toString(),
        });
      });

      await dealer.send(Buffer.from('hello'));

      expect(received).toHaveLength(1);
      expect(received[0].identity).toBe(dealer.identity.toString());
      expect(received[0].payload).toBe('hello');
    });

    it('records sent messages on the dealer', async () => {
      const { dealer } = await wireFakeRouterDealer();

      await dealer.send(Buffer.from('msg1'));
      await dealer.send(Buffer.from('msg2'));

      expect(dealer.sent).toHaveLength(2);
      expect(dealer.sent[0].payload.toString()).toBe('msg1');
      expect(dealer.sent[1].payload.toString()).toBe('msg2');
    });

    it('records received messages on the router', async () => {
      const { router, dealer } = await wireFakeRouterDealer();

      await dealer.send(Buffer.from('test-payload'));

      expect(router.received).toHaveLength(1);
      expect(router.received[0].payload.toString()).toBe('test-payload');
      expect(router.received[0].identity.toString()).toBe(dealer.identity.toString());
      expect(router.received[0].delimiter).toHaveLength(0);
    });
  });

  describe('router sends to dealer', () => {
    it('routes a message back to the correct dealer', async () => {
      const { router, dealer } = await wireFakeRouterDealer();

      const received: string[] = [];
      dealer.on('message', (payload) => {
        received.push(payload.toString());
      });

      await router.send(dealer.identity, Buffer.alloc(0), Buffer.from('response'));

      expect(received).toHaveLength(1);
      expect(received[0]).toBe('response');
    });

    it('records sent messages on the router', async () => {
      const { router, dealer } = await wireFakeRouterDealer();

      await router.send(dealer.identity, Buffer.alloc(0), Buffer.from('data'));

      expect(router.sent).toHaveLength(1);
      expect(router.sent[0].payload.toString()).toBe('data');
    });

    it('records received messages on the dealer', async () => {
      const { router, dealer } = await wireFakeRouterDealer();

      await router.send(dealer.identity, Buffer.alloc(0), Buffer.from('reply'));

      expect(dealer.received).toHaveLength(1);
      expect(dealer.received[0].payload.toString()).toBe('reply');
    });
  });

  describe('multiple dealers', () => {
    it('routes messages to the correct dealer by identity', async () => {
      const router = new FakeRouterSocket();
      await router.bind('inproc://multi-dealer');

      const dealer1 = new FakeDealerSocket();
      dealer1.connectedTo = router;
      await dealer1.connect('inproc://multi-dealer');

      const dealer2 = new FakeDealerSocket();
      dealer2.connectedTo = router;
      await dealer2.connect('inproc://multi-dealer');

      // Route a message to dealer1 only.
      await router.send(dealer1.identity, Buffer.alloc(0), Buffer.from('for-dealer-1'));

      expect(dealer1.received).toHaveLength(1);
      expect(dealer1.received[0].payload.toString()).toBe('for-dealer-1');
      expect(dealer2.received).toHaveLength(0);

      // Route a message to dealer2 only.
      await router.send(dealer2.identity, Buffer.alloc(0), Buffer.from('for-dealer-2'));

      expect(dealer2.received).toHaveLength(1);
      expect(dealer2.received[0].payload.toString()).toBe('for-dealer-2');
      // dealer1 still has only 1.
      expect(dealer1.received).toHaveLength(1);
    });

    it('tracks all dealer identities independently', async () => {
      const router = new FakeRouterSocket();
      await router.bind('inproc://identity-test');

      const dealer1 = new FakeDealerSocket();
      dealer1.connectedTo = router;
      await dealer1.connect('inproc://identity-test');

      const dealer2 = new FakeDealerSocket();
      dealer2.connectedTo = router;
      await dealer2.connect('inproc://identity-test');

      expect(dealer1.identity.toString()).not.toBe(dealer2.identity.toString());
      expect(router.dealers.size).toBe(2);
      expect(router.dealers.has(dealer1.identity.toString())).toBe(true);
      expect(router.dealers.has(dealer2.identity.toString())).toBe(true);
    });

    it('receives messages from multiple dealers with correct identities', async () => {
      const router = new FakeRouterSocket();
      await router.bind('inproc://multi-send');

      const dealer1 = new FakeDealerSocket();
      dealer1.connectedTo = router;
      await dealer1.connect('inproc://multi-send');

      const dealer2 = new FakeDealerSocket();
      dealer2.connectedTo = router;
      await dealer2.connect('inproc://multi-send');

      const received: Array<{ identity: string; payload: string }> = [];
      router.on('message', (identity, _delimiter, payload) => {
        received.push({
          identity: identity.toString(),
          payload: payload.toString(),
        });
      });

      await dealer1.send(Buffer.from('from-1'));
      await dealer2.send(Buffer.from('from-2'));

      expect(received).toHaveLength(2);
      expect(received[0].identity).toBe(dealer1.identity.toString());
      expect(received[0].payload).toBe('from-1');
      expect(received[1].identity).toBe(dealer2.identity.toString());
      expect(received[1].payload).toBe('from-2');
    });
  });

  describe('round trip', () => {
    it('dealer sends request, router replies with response', async () => {
      const { router, dealer } = await wireFakeRouterDealer();

      // Router echoes back the payload in uppercase.
      router.on('message', async (identity, _delimiter, payload) => {
        const response = payload.toString().toUpperCase();
        await router.send(identity, Buffer.alloc(0), Buffer.from(response));
      });

      const responses: string[] = [];
      dealer.on('message', (payload) => {
        responses.push(payload.toString());
      });

      await dealer.send(Buffer.from('hello'));

      expect(responses).toHaveLength(1);
      expect(responses[0]).toBe('HELLO');
    });
  });

  describe('bind address tracking', () => {
    it('records the bound address', async () => {
      const router = new FakeRouterSocket();
      expect(router.boundAddress).toBeNull();

      await router.bind('ipc:///tmp/router.sock');
      expect(router.boundAddress).toBe('ipc:///tmp/router.sock');
    });
  });

  describe('unconnected dealer', () => {
    it('send succeeds but does not deliver if dealer has no router', async () => {
      const dealer = new FakeDealerSocket();
      // No connectedTo set, no connect() called.

      await dealer.send(Buffer.from('orphan'));

      expect(dealer.sent).toHaveLength(1);
      // No router to receive it, but no error either.
    });
  });

  describe('unknown identity on router send', () => {
    it('send succeeds but does not deliver if identity is not registered', async () => {
      const router = new FakeRouterSocket();
      await router.bind('inproc://unknown-id');

      await router.send(Buffer.from('nonexistent-dealer'), Buffer.alloc(0), Buffer.from('data'));

      // Message is recorded as sent but not delivered.
      expect(router.sent).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Error injection
// ---------------------------------------------------------------------------

describe('Error injection', () => {
  describe('FakePubSocket error injection', () => {
    it('throws "Connection refused" on next send after injectError("refused")', async () => {
      const pub = new FakePubSocket();
      await pub.bind('inproc://err-pub');

      pub.injectError('refused');

      await expect(pub.send(Buffer.from('t'), Buffer.from('p'))).rejects.toThrow(
        'Connection refused',
      );

      // Subsequent sends work normally (error consumed).
      await pub.send(Buffer.from('t2'), Buffer.from('p2'));
      expect(pub.sent).toHaveLength(1);
    });

    it('throws "Operation timed out" on next send after injectError("timeout")', async () => {
      const pub = new FakePubSocket();
      await pub.bind('inproc://err-pub-timeout');

      pub.injectError('timeout');

      await expect(pub.send(Buffer.from('t'), Buffer.from('p'))).rejects.toThrow(
        'Operation timed out',
      );
    });

    it('throws "Message exceeds maximum size" on next send after injectError("oversized")', async () => {
      const pub = new FakePubSocket();
      await pub.bind('inproc://err-pub-oversized');

      pub.injectError('oversized');

      await expect(pub.send(Buffer.from('t'), Buffer.from('p'))).rejects.toThrow(
        'Message exceeds maximum size',
      );
    });

    it('throws on bind if error is injected before bind', async () => {
      const pub = new FakePubSocket();
      pub.injectError('refused');

      await expect(pub.bind('inproc://err-bind')).rejects.toThrow('Connection refused');
    });
  });

  describe('FakeSubSocket error injection', () => {
    it('throws on connect after injectError', async () => {
      const sub = new FakeSubSocket();
      sub.injectError('refused');

      await expect(sub.connect('inproc://err-sub')).rejects.toThrow('Connection refused');
    });

    it('throws on subscribe after injectError', async () => {
      const sub = new FakeSubSocket();
      sub.injectError('timeout');

      await expect(sub.subscribe('topic')).rejects.toThrow('Operation timed out');
    });
  });

  describe('FakeRouterSocket error injection', () => {
    it('throws on send after injectError', async () => {
      const router = new FakeRouterSocket();
      await router.bind('inproc://err-router');

      router.injectError('refused');

      await expect(
        router.send(Buffer.from('id'), Buffer.alloc(0), Buffer.from('data')),
      ).rejects.toThrow('Connection refused');
    });

    it('throws on bind after injectError', async () => {
      const router = new FakeRouterSocket();
      router.injectError('timeout');

      await expect(router.bind('inproc://err-router-bind')).rejects.toThrow('Operation timed out');
    });
  });

  describe('FakeDealerSocket error injection', () => {
    it('throws on send after injectError', async () => {
      const dealer = new FakeDealerSocket();
      dealer.injectError('oversized');

      await expect(dealer.send(Buffer.from('data'))).rejects.toThrow(
        'Message exceeds maximum size',
      );
    });

    it('throws on connect after injectError', async () => {
      const dealer = new FakeDealerSocket();
      dealer.injectError('refused');

      await expect(dealer.connect('inproc://err-dealer')).rejects.toThrow('Connection refused');
    });
  });

  describe('error is consumed after one operation', () => {
    it('only affects the next operation, not subsequent ones', async () => {
      const pub = new FakePubSocket();
      await pub.bind('inproc://err-consume');

      pub.injectError('refused');

      // First send throws.
      await expect(pub.send(Buffer.from('t'), Buffer.from('p'))).rejects.toThrow(
        'Connection refused',
      );

      // Second send succeeds.
      await pub.send(Buffer.from('t2'), Buffer.from('p2'));
      expect(pub.sent).toHaveLength(1);
      expect(pub.sent[0].topic.toString()).toBe('t2');
    });
  });
});

// ---------------------------------------------------------------------------
// Close / cleanup
// ---------------------------------------------------------------------------

describe('Socket close behavior', () => {
  describe('FakePubSocket close', () => {
    it('marks the socket as closed', async () => {
      const pub = new FakePubSocket();
      expect(pub.closed).toBe(false);

      await pub.close();
      expect(pub.closed).toBe(true);
    });

    it('throws on bind after close', async () => {
      const pub = new FakePubSocket();
      await pub.close();

      await expect(pub.bind('inproc://closed')).rejects.toThrow('Socket is closed');
    });

    it('throws on send after close', async () => {
      const pub = new FakePubSocket();
      await pub.close();

      await expect(pub.send(Buffer.from('t'), Buffer.from('p'))).rejects.toThrow(
        'Socket is closed',
      );
    });
  });

  describe('FakeSubSocket close', () => {
    it('marks the socket as closed', async () => {
      const sub = new FakeSubSocket();
      expect(sub.closed).toBe(false);

      await sub.close();
      expect(sub.closed).toBe(true);
    });

    it('throws on connect after close', async () => {
      const sub = new FakeSubSocket();
      await sub.close();

      await expect(sub.connect('inproc://closed')).rejects.toThrow('Socket is closed');
    });

    it('throws on subscribe after close', async () => {
      const sub = new FakeSubSocket();
      await sub.close();

      await expect(sub.subscribe('topic')).rejects.toThrow('Socket is closed');
    });

    it('throws on on() after close', () => {
      const sub = new FakeSubSocket();
      sub.closed = true;

      expect(() => sub.on('message', () => {})).toThrow('Socket is closed');
    });

    it('unregisters from publisher on close', async () => {
      const { pub, sub } = await wireFakePubSub();
      await sub.subscribe('event.');

      expect(pub.subscribers.size).toBe(1);

      await sub.close();
      expect(pub.subscribers.size).toBe(0);

      // Publisher should not deliver to the closed subscriber.
      await pub.send(Buffer.from('event.test'), Buffer.from('data'));
      expect(sub.received).toHaveLength(0);
    });
  });

  describe('FakeRouterSocket close', () => {
    it('marks the socket as closed', async () => {
      const router = new FakeRouterSocket();
      expect(router.closed).toBe(false);

      await router.close();
      expect(router.closed).toBe(true);
    });

    it('throws on bind after close', async () => {
      const router = new FakeRouterSocket();
      await router.close();

      await expect(router.bind('inproc://closed')).rejects.toThrow('Socket is closed');
    });

    it('throws on send after close', async () => {
      const router = new FakeRouterSocket();
      await router.close();

      await expect(
        router.send(Buffer.from('id'), Buffer.alloc(0), Buffer.from('data')),
      ).rejects.toThrow('Socket is closed');
    });

    it('throws on on() after close', () => {
      const router = new FakeRouterSocket();
      router.closed = true;

      expect(() => router.on('message', () => {})).toThrow('Socket is closed');
    });
  });

  describe('FakeDealerSocket close', () => {
    it('marks the socket as closed', async () => {
      const dealer = new FakeDealerSocket();
      expect(dealer.closed).toBe(false);

      await dealer.close();
      expect(dealer.closed).toBe(true);
    });

    it('throws on connect after close', async () => {
      const dealer = new FakeDealerSocket();
      await dealer.close();

      await expect(dealer.connect('inproc://closed')).rejects.toThrow('Socket is closed');
    });

    it('throws on send after close', async () => {
      const dealer = new FakeDealerSocket();
      await dealer.close();

      await expect(dealer.send(Buffer.from('data'))).rejects.toThrow('Socket is closed');
    });

    it('throws on on() after close', () => {
      const dealer = new FakeDealerSocket();
      dealer.closed = true;

      expect(() => dealer.on('message', () => {})).toThrow('Socket is closed');
    });
  });
});

// ---------------------------------------------------------------------------
// FakeSocketFactory
// ---------------------------------------------------------------------------

describe('FakeSocketFactory', () => {
  let factory: FakeSocketFactory;

  beforeEach(() => {
    factory = new FakeSocketFactory();
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  it('creates publisher sockets', () => {
    const pub = factory.createPublisher();
    expect(pub).toBeDefined();
    expect(factory.getPublishers()).toHaveLength(1);
  });

  it('creates subscriber sockets', () => {
    const sub = factory.createSubscriber();
    expect(sub).toBeDefined();
    expect(factory.getSubscribers()).toHaveLength(1);
  });

  it('creates router sockets', () => {
    const router = factory.createRouter();
    expect(router).toBeDefined();
    expect(factory.getRouters()).toHaveLength(1);
  });

  it('creates dealer sockets', () => {
    const dealer = factory.createDealer();
    expect(dealer).toBeDefined();
    expect(factory.getDealers()).toHaveLength(1);
  });

  it('tracks multiple sockets of the same type', () => {
    factory.createPublisher();
    factory.createPublisher();
    factory.createPublisher();

    expect(factory.getPublishers()).toHaveLength(3);
  });

  it('tracks sockets of different types independently', () => {
    factory.createPublisher();
    factory.createSubscriber();
    factory.createRouter();
    factory.createDealer();

    expect(factory.getPublishers()).toHaveLength(1);
    expect(factory.getSubscribers()).toHaveLength(1);
    expect(factory.getRouters()).toHaveLength(1);
    expect(factory.getDealers()).toHaveLength(1);
  });

  it('cleanup closes all created sockets', async () => {
    const pub = factory.createPublisher() as FakePubSocket;
    const sub = factory.createSubscriber() as FakeSubSocket;
    const router = factory.createRouter() as FakeRouterSocket;
    const dealer = factory.createDealer() as FakeDealerSocket;

    expect(pub.closed).toBe(false);
    expect(sub.closed).toBe(false);
    expect(router.closed).toBe(false);
    expect(dealer.closed).toBe(false);

    await factory.cleanup();

    expect(pub.closed).toBe(true);
    expect(sub.closed).toBe(true);
    expect(router.closed).toBe(true);
    expect(dealer.closed).toBe(true);
  });

  it('cleanup is safe to call multiple times', async () => {
    factory.createPublisher();
    factory.createSubscriber();

    await factory.cleanup();
    // Second cleanup should not throw.
    await factory.cleanup();
  });
});

// ---------------------------------------------------------------------------
// wireFakePubSub helper
// ---------------------------------------------------------------------------

describe('wireFakePubSub', () => {
  it('returns a connected pub/sub pair', async () => {
    const { pub, sub } = await wireFakePubSub();

    expect(pub.boundAddress).toBeTruthy();
    expect(sub.connectedTo).toBe(pub);
    expect(pub.subscribers.has(sub)).toBe(true);
  });

  it('pair is immediately usable for messaging', async () => {
    const { pub, sub } = await wireFakePubSub();
    await sub.subscribe('');

    await pub.send(Buffer.from('test'), Buffer.from('data'));

    expect(sub.received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// wireFakeRouterDealer helper
// ---------------------------------------------------------------------------

describe('wireFakeRouterDealer', () => {
  it('returns a connected router/dealer pair', async () => {
    const { router, dealer } = await wireFakeRouterDealer();

    expect(router.boundAddress).toBeTruthy();
    expect(dealer.connectedTo).toBe(router);
    expect(router.dealers.has(dealer.identity.toString())).toBe(true);
  });

  it('pair is immediately usable for messaging', async () => {
    const { router, dealer } = await wireFakeRouterDealer();

    const received: string[] = [];
    router.on('message', (_identity, _delimiter, payload) => {
      received.push(payload.toString());
    });

    await dealer.send(Buffer.from('ping'));

    expect(received).toHaveLength(1);
    expect(received[0]).toBe('ping');
  });
});

// ---------------------------------------------------------------------------
// Buffer isolation (messages are copied, not shared)
// ---------------------------------------------------------------------------

describe('Buffer isolation', () => {
  it('PUB/SUB: modifying original buffers does not affect received messages', async () => {
    const { pub, sub } = await wireFakePubSub();
    await sub.subscribe('');

    const topic = Buffer.from('event');
    const payload = Buffer.from('original');
    await pub.send(topic, payload);

    // Mutate the original buffers.
    topic.write('XXXXX');
    payload.write('XXXXXXXX');

    // Received buffers should still hold the original data.
    expect(sub.received[0].topic.toString()).toBe('event');
    expect(sub.received[0].payload.toString()).toBe('original');
  });

  it('ROUTER/DEALER: modifying original buffers does not affect received messages', async () => {
    const { router, dealer } = await wireFakeRouterDealer();

    const responses: string[] = [];
    dealer.on('message', (payload) => {
      responses.push(payload.toString());
    });

    const payload = Buffer.from('response-data');
    await router.send(dealer.identity, Buffer.alloc(0), payload);

    // Mutate the original buffer.
    payload.write('XXXXXXXXXXXXX');

    expect(responses[0]).toBe('response-data');
    expect(dealer.received[0].payload.toString()).toBe('response-data');
  });
});
