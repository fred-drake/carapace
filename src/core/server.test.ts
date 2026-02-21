/**
 * Tests for the Server orchestrator (composition root).
 *
 * Uses FakeSocketFactory and a mock filesystem so no real ZMQ sockets
 * or disk I/O are needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Server } from './server.js';
import { FakeSocketFactory } from '../testing/fake-socket-factory.js';
import type { SocketFs } from './socket-provisioner.js';
import type { ContainerRuntime } from './container/runtime.js';
import type { EventEnvelope } from '../types/protocol.js';
import { configureLogging, resetLogging, type LogEntry, type LogSink } from './logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFs(): SocketFs {
  return {
    existsSync: vi.fn().mockReturnValue(false),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
  };
}

function createTestServer(overrides?: {
  socketFactory?: FakeSocketFactory;
  fs?: SocketFs;
  output?: (msg: string) => void;
}) {
  const socketFactory = overrides?.socketFactory ?? new FakeSocketFactory();
  const fs = overrides?.fs ?? createMockFs();
  const output = overrides?.output ?? vi.fn();

  const server = new Server(
    {
      socketDir: '/tmp/carapace-test-sockets',
      pluginsDir: '/tmp/carapace-test-plugins',
    },
    {
      socketFactory,
      fs,
      output,
    },
  );

  return { server, socketFactory, fs, output };
}

function createMockRuntime(): ContainerRuntime {
  return {
    name: 'docker' as const,
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Docker 27.0.0'),
    pull: vi.fn().mockResolvedValue(undefined),
    imageExists: vi.fn().mockResolvedValue(true),
    loadImage: vi.fn().mockResolvedValue(undefined),
    build: vi.fn().mockResolvedValue('sha256:abc'),
    inspectLabels: vi.fn().mockResolvedValue({}),
    run: vi.fn().mockResolvedValue({
      id: 'container-1',
      name: 'test-container',
      runtime: 'docker' as const,
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({ status: 'running' as const }),
  };
}

function createTestServerWithRuntime() {
  const socketFactory = new FakeSocketFactory();
  const fs = createMockFs();
  const output = vi.fn();
  const runtime = createMockRuntime();

  const server = new Server(
    {
      socketDir: '/tmp/carapace-test-sockets',
      pluginsDir: '/tmp/carapace-test-plugins',
      containerImage: 'carapace-agent:test',
      configuredGroups: ['email', 'slack'],
      maxSessionsPerGroup: 5,
    },
    {
      socketFactory,
      fs,
      output,
      containerRuntime: runtime,
    },
  );

  return { server, socketFactory, fs, output, runtime };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Server', () => {
  let server: Server;
  let socketFactory: FakeSocketFactory;
  let output: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const ctx = createTestServer();
    server = ctx.server;
    socketFactory = ctx.socketFactory;
    output = ctx.output as ReturnType<typeof vi.fn>;
  });

  afterEach(async () => {
    // Ensure cleanup even if a test fails
    try {
      await server.stop();
    } catch {
      // Already stopped
    }
  });

  describe('start()', () => {
    it('binds a ROUTER socket for the request channel', async () => {
      await server.start();
      const routers = socketFactory.getRouters();
      expect(routers.length).toBe(1);
      expect(routers[0].boundAddress).toMatch(/ipc:\/\//);
    });

    it('binds a PUB socket for the event bus', async () => {
      await server.start();
      const pubs = socketFactory.getPublishers();
      expect(pubs.length).toBe(1);
      expect(pubs[0].boundAddress).toMatch(/ipc:\/\//);
    });

    it('ensures socket directory exists with restricted permissions', async () => {
      const fs = createMockFs();
      const ctx = createTestServer({ fs });
      server = ctx.server;

      await server.start();

      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/carapace-test-sockets', {
        recursive: true,
      });
      expect(fs.chmodSync).toHaveBeenCalledWith('/tmp/carapace-test-sockets', 0o700);
    });

    it('reports ready via output callback', async () => {
      await server.start();
      expect(output).toHaveBeenCalledWith(expect.stringContaining('ready'));
    });

    it('throws if already started', async () => {
      await server.start();
      await expect(server.start()).rejects.toThrow('already');
    });
  });

  describe('stop()', () => {
    it('closes the request channel router socket', async () => {
      await server.start();
      const routers = socketFactory.getRouters();
      expect(routers[0].closed).toBe(false);

      await server.stop();
      expect(routers[0].closed).toBe(true);
    });

    it('closes the event bus publisher socket', async () => {
      await server.start();
      const pubs = socketFactory.getPublishers();
      expect(pubs[0].closed).toBe(false);

      await server.stop();
      expect(pubs[0].closed).toBe(true);
    });

    it('cleans up provisioned socket files', async () => {
      const fs = createMockFs();
      const ctx = createTestServer({ fs });
      server = ctx.server;

      await server.start();

      // After start, socket files "exist" for cleanup during stop
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      await server.stop();

      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('is idempotent (can be called multiple times)', async () => {
      await server.start();
      await server.stop();
      await expect(server.stop()).resolves.toBeUndefined();
    });

    it('can be called without start()', async () => {
      await expect(server.stop()).resolves.toBeUndefined();
    });
  });

  describe('request routing', () => {
    it('registers a message handler on the request channel', async () => {
      await server.start();
      const routers = socketFactory.getRouters();
      expect(routers[0].handlers.length).toBeGreaterThan(0);
    });
  });

  describe('component wiring', () => {
    it('creates a SessionManager', async () => {
      await server.start();
      // Server exposes sessionManager for the orchestrator chain
      expect(server.sessionManager).toBeDefined();
    });

    it('creates a ToolCatalog', async () => {
      await server.start();
      expect(server.toolCatalog).toBeDefined();
    });

    it('creates a ResponseSanitizer', async () => {
      await server.start();
      expect(server.responseSanitizer).toBeDefined();
    });
  });

  describe('getPluginHandler()', () => {
    it('returns undefined for unknown plugin name after start()', async () => {
      await server.start();
      expect(server.getPluginHandler('unknown')).toBeUndefined();
    });

    it('returns undefined before start() is called', () => {
      expect(server.getPluginHandler('anything')).toBeUndefined();
    });
  });

  describe('event dispatch wiring', () => {
    it('creates a SUB socket when containerRuntime is provided', async () => {
      const ctx = createTestServerWithRuntime();
      server = ctx.server;
      socketFactory = ctx.socketFactory;

      await server.start();

      const subs = socketFactory.getSubscribers();
      expect(subs.length).toBe(1);
    });

    it('does not create SUB socket when containerRuntime is absent', async () => {
      await server.start();

      const subs = socketFactory.getSubscribers();
      expect(subs.length).toBe(0);
    });

    it('subscribes to message.inbound and task.triggered topics', async () => {
      const ctx = createTestServerWithRuntime();
      server = ctx.server;
      socketFactory = ctx.socketFactory;

      await server.start();

      const subs = socketFactory.getSubscribers();
      expect(subs[0].subscriptions.has('message.inbound')).toBe(true);
      expect(subs[0].subscriptions.has('task.triggered')).toBe(true);
    });

    it('registers a message handler on the SUB socket', async () => {
      const ctx = createTestServerWithRuntime();
      server = ctx.server;
      socketFactory = ctx.socketFactory;

      await server.start();

      const subs = socketFactory.getSubscribers();
      expect(subs[0].handlers.length).toBe(1);
    });

    it('dispatches message.inbound events to spawn agents', async () => {
      const ctx = createTestServerWithRuntime();
      server = ctx.server;
      socketFactory = ctx.socketFactory;

      await server.start();

      const subs = socketFactory.getSubscribers();

      // Simulate a message.inbound event arriving on the SUB socket
      const envelope: EventEnvelope = {
        id: 'evt-1',
        version: 1,
        type: 'event',
        topic: 'message.inbound',
        source: 'test-plugin',
        correlation: null,
        timestamp: new Date().toISOString(),
        group: 'email',
        payload: {
          channel: 'email',
          sender: 'user@test.com',
          content_type: 'text',
          body: 'Hello',
        },
      };

      const topicBuf = Buffer.from('message.inbound', 'utf-8');
      const payloadBuf = Buffer.from(JSON.stringify(envelope), 'utf-8');
      subs[0].handlers[0](topicBuf, payloadBuf);

      // Wait for async dispatch to complete
      await vi.waitFor(() => {
        expect(ctx.runtime.run).toHaveBeenCalled();
      });
    });

    it('passes container image from config to spawn request', async () => {
      const ctx = createTestServerWithRuntime();
      server = ctx.server;
      socketFactory = ctx.socketFactory;

      await server.start();

      const subs = socketFactory.getSubscribers();

      const envelope: EventEnvelope = {
        id: 'evt-2',
        version: 1,
        type: 'event',
        topic: 'message.inbound',
        source: 'test-plugin',
        correlation: null,
        timestamp: new Date().toISOString(),
        group: 'email',
        payload: {
          channel: 'email',
          sender: 'user@test.com',
          content_type: 'text',
          body: 'Hello',
        },
      };

      const topicBuf = Buffer.from('message.inbound', 'utf-8');
      const payloadBuf = Buffer.from(JSON.stringify(envelope), 'utf-8');
      subs[0].handlers[0](topicBuf, payloadBuf);

      await vi.waitFor(() => {
        expect(ctx.runtime.run).toHaveBeenCalledWith(
          expect.objectContaining({ image: 'carapace-agent:test' }),
        );
      });
    });

    it('drops events for unconfigured groups', async () => {
      const ctx = createTestServerWithRuntime();
      server = ctx.server;
      socketFactory = ctx.socketFactory;

      await server.start();

      const subs = socketFactory.getSubscribers();

      const envelope: EventEnvelope = {
        id: 'evt-3',
        version: 1,
        type: 'event',
        topic: 'message.inbound',
        source: 'test-plugin',
        correlation: null,
        timestamp: new Date().toISOString(),
        group: 'unknown-group',
        payload: {
          channel: 'email',
          sender: 'user@test.com',
          content_type: 'text',
          body: 'Hello',
        },
      };

      const topicBuf = Buffer.from('message.inbound', 'utf-8');
      const payloadBuf = Buffer.from(JSON.stringify(envelope), 'utf-8');
      subs[0].handlers[0](topicBuf, payloadBuf);

      // Give dispatch a tick to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should NOT have spawned a container
      expect(ctx.runtime.run).not.toHaveBeenCalled();
    });
  });

  describe('stop() with event dispatch', () => {
    it('closes SUB socket on stop', async () => {
      const ctx = createTestServerWithRuntime();
      server = ctx.server;
      socketFactory = ctx.socketFactory;

      await server.start();

      const subs = socketFactory.getSubscribers();
      expect(subs[0].closed).toBe(false);

      await server.stop();
      expect(subs[0].closed).toBe(true);
    });

    it('shuts down lifecycle manager containers on stop', async () => {
      const ctx = createTestServerWithRuntime();
      server = ctx.server;
      socketFactory = ctx.socketFactory;

      await server.start();

      // Spawn a container via event dispatch
      const subs = socketFactory.getSubscribers();
      const envelope: EventEnvelope = {
        id: 'evt-4',
        version: 1,
        type: 'event',
        topic: 'message.inbound',
        source: 'test-plugin',
        correlation: null,
        timestamp: new Date().toISOString(),
        group: 'email',
        payload: {
          channel: 'email',
          sender: 'user@test.com',
          content_type: 'text',
          body: 'Hello',
        },
      };

      const topicBuf = Buffer.from('message.inbound', 'utf-8');
      const payloadBuf = Buffer.from(JSON.stringify(envelope), 'utf-8');
      subs[0].handlers[0](topicBuf, payloadBuf);

      await vi.waitFor(() => {
        expect(ctx.runtime.run).toHaveBeenCalled();
      });

      await server.stop();

      // Lifecycle manager calls stop() then remove() for each managed container
      expect(ctx.runtime.stop).toHaveBeenCalled();
    });
  });

  describe('logging', () => {
    let logEntries: LogEntry[];
    let logSink: LogSink;

    beforeEach(() => {
      logEntries = [];
      logSink = (entry) => logEntries.push(entry);
      configureLogging({ level: 'debug', sink: logSink });
    });

    afterEach(() => {
      resetLogging();
    });

    it('logs server starting and ready on start()', async () => {
      const ctx = createTestServer();
      server = ctx.server;

      await server.start();

      const msgs = logEntries.map((e) => e.msg);
      expect(msgs).toContain('server starting');
      expect(msgs).toContain('server ready');
    });

    it('logs server stopping and stopped on stop()', async () => {
      const ctx = createTestServer();
      server = ctx.server;

      await server.start();
      logEntries.length = 0; // Clear start logs
      await server.stop();

      const msgs = logEntries.map((e) => e.msg);
      expect(msgs).toContain('server stopping');
      expect(msgs).toContain('server stopped');
    });

    it('logs request received with correlation and topic', async () => {
      const ctx = createTestServer();
      server = ctx.server;

      await server.start();
      logEntries.length = 0;

      // Simulate a request arriving on the ROUTER socket via handler
      const routers = ctx.socketFactory.getRouters();
      const wire = {
        topic: 'tool.invoke.echo',
        correlation: 'corr-log-1',
        arguments: { message: 'hi' },
      };
      const identity = Buffer.from('dealer-test');
      const delimiter = Buffer.alloc(0);
      const payload = Buffer.from(JSON.stringify(wire));
      // Trigger the message handler registered on the router
      for (const handler of routers[0].handlers) {
        handler(identity, delimiter, payload);
      }

      // Wait for async handling
      await new Promise((resolve) => setTimeout(resolve, 10));

      const received = logEntries.find((e) => e.msg === 'request received');
      expect(received).toBeDefined();
      expect(received!.correlation).toBe('corr-log-1');
      expect(received!.topic).toBe('tool.invoke.echo');
    });

    it('logs request completed with duration and ok status', async () => {
      const ctx = createTestServer();
      server = ctx.server;

      await server.start();
      logEntries.length = 0;

      const routers = ctx.socketFactory.getRouters();
      const wire = {
        topic: 'tool.invoke.echo',
        correlation: 'corr-log-2',
        arguments: { text: 'test' },
      };
      const identity = Buffer.from('dealer-test2');
      const delimiter = Buffer.alloc(0);
      const payload = Buffer.from(JSON.stringify(wire));
      for (const handler of routers[0].handlers) {
        handler(identity, delimiter, payload);
      }

      await new Promise((resolve) => setTimeout(resolve, 10));

      const completed = logEntries.find((e) => e.msg === 'request completed');
      expect(completed).toBeDefined();
      expect(completed!.correlation).toBe('corr-log-2');
      expect(completed!.duration_ms).toBeDefined();
      expect(typeof completed!.duration_ms).toBe('number');
      expect(completed!.ok).toBe(true);
    });

    it('logs request-channel bind via child logger', async () => {
      const ctx = createTestServer();
      server = ctx.server;

      await server.start();

      const bindLog = logEntries.find((e) => e.msg === 'ROUTER socket bound');
      expect(bindLog).toBeDefined();
      expect(bindLog!.component).toBe('server:request-channel');
    });

    it('accepts injected logger via ServerDeps', async () => {
      const customEntries: LogEntry[] = [];
      const customSink: LogSink = (entry) => customEntries.push(entry);
      configureLogging({ level: 'debug', sink: customSink });

      const fs = createMockFs();
      const customServer = new Server(
        { socketDir: '/tmp/test-sockets', pluginsDir: '/tmp/test-plugins' },
        { socketFactory: new FakeSocketFactory(), fs, output: vi.fn() },
      );

      await customServer.start();

      const msgs = customEntries.map((e) => e.msg);
      expect(msgs).toContain('server starting');
      expect(msgs).toContain('server ready');

      await customServer.stop();
    });

    it('uses server component name for logger', async () => {
      const ctx = createTestServer();
      server = ctx.server;

      await server.start();

      const serverLogs = logEntries.filter((e) => e.component === 'server');
      expect(serverLogs.length).toBeGreaterThan(0);
    });

    it('logs response send failure as warning', async () => {
      const ctx = createTestServer();
      server = ctx.server;

      await server.start();
      logEntries.length = 0;

      // Send a request then force send failure
      const routers = ctx.socketFactory.getRouters();
      const wire = {
        topic: 'tool.invoke.echo',
        correlation: 'corr-fail',
        arguments: { message: 'fail test' },
      };

      // Override the router's send to throw
      routers[0].send = async () => {
        throw new Error('Connection closed');
      };

      const identity = Buffer.from('dealer-fail');
      const delimiter = Buffer.alloc(0);
      const payload = Buffer.from(JSON.stringify(wire));
      for (const handler of routers[0].handlers) {
        handler(identity, delimiter, payload);
      }

      await new Promise((resolve) => setTimeout(resolve, 20));

      const failLog = logEntries.find((e) => e.msg === 'response send failed');
      expect(failLog).toBeDefined();
    });
  });
});
