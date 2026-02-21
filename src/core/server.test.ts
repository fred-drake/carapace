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
});
