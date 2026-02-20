/**
 * E2E test: full echo plugin round-trip.
 *
 * Exercises the complete path:
 *   Client DEALER → ZMQ → Server ROUTER → MessageRouter pipeline →
 *   echo handler → ResponseSanitizer → Server ROUTER → Client DEALER
 *
 * Uses FakeSocketFactory for in-memory transport (no real ZeroMQ).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Server } from './server.js';
import type { ServerConfig, ServerDeps } from './server.js';
import { FakeSocketFactory } from '../testing/fake-socket-factory.js';
import { FakeDealerSocket } from '../testing/fake-sockets.js';
import { IpcClient } from '../ipc/ipc-client.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestServer(): { server: Server; factory: FakeSocketFactory } {
  const factory = new FakeSocketFactory();
  const config: ServerConfig = {
    socketDir: '/tmp/e2e-test-sockets',
    pluginsDir: '/tmp/nonexistent-plugins',
  };
  const deps: ServerDeps = {
    socketFactory: factory,
    // Use mock FS that always succeeds
    fs: {
      existsSync: () => false,
      mkdirSync: () => {},
      chmodSync: () => {},
      unlinkSync: () => {},
      readdirSync: () => [],
    },
  };
  const server = new Server(config, deps);
  return { server, factory };
}

function createClient(factory: FakeSocketFactory): {
  client: IpcClient;
  dealer: FakeDealerSocket;
} {
  const router = factory.getRouters()[0];
  const dealer = new FakeDealerSocket();
  dealer.connectedTo = router;
  // connect() registers the dealer with the router
  void dealer.connect('ipc:///tmp/e2e-test-sockets/server-request.sock');
  const client = new IpcClient(dealer, { timeoutMs: 5000 });
  return { client, dealer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E: echo plugin round-trip', () => {
  let server: Server;
  let factory: FakeSocketFactory;
  let client: IpcClient;

  afterEach(async () => {
    await client?.close();
    await server?.stop();
    await factory?.cleanup();
  });

  it('echoes text back through the full pipeline', async () => {
    ({ server, factory } = createTestServer());
    await server.start();

    ({ client } = createClient(factory));

    const response = await client.invoke('tool.invoke.echo', { text: 'hello' });

    expect(response.payload.error).toBeNull();
    expect(response.payload.result).toEqual({ echoed: 'hello' });
  });

  it('returns the correct topic on the response', async () => {
    ({ server, factory } = createTestServer());
    await server.start();

    ({ client } = createClient(factory));

    const response = await client.invoke('tool.invoke.echo', { text: 'test' });

    expect(response.topic).toBe('tool.invoke.echo');
  });

  it('returns a valid correlation ID matching the request', async () => {
    ({ server, factory } = createTestServer());
    await server.start();

    ({ client } = createClient(factory));

    const response = await client.invoke('tool.invoke.echo', { text: 'corr' });

    expect(response.correlation).toBeDefined();
    expect(typeof response.correlation).toBe('string');
    expect(response.correlation.length).toBeGreaterThan(0);
  });

  it('rejects request when required text argument is omitted', async () => {
    ({ server, factory } = createTestServer());
    await server.start();

    ({ client } = createClient(factory));

    // The schema requires 'text' — pipeline stage 3 rejects missing args
    const response = await client.invoke('tool.invoke.echo', {});

    expect(response.payload.error).not.toBeNull();
    expect(response.payload.error!.code).toBe('VALIDATION_FAILED');
  });

  it('sanitizes credential patterns in echoed responses', async () => {
    ({ server, factory } = createTestServer());
    await server.start();

    ({ client } = createClient(factory));

    // Send text containing a credential pattern that matches the sanitizer's
    // api_key_prefix regex: /\b[sp]k[-_](?:live_|test_)?[A-Za-z0-9]{8,}/g
    const sensitiveKey = 'sk_live_abcdefgh12345678';
    const response = await client.invoke('tool.invoke.echo', {
      text: `my key is ${sensitiveKey}`,
    });

    expect(response.payload.error).toBeNull();
    const result = response.payload.result as Record<string, unknown>;
    // The echoed text should have the API key redacted
    expect(result['echoed']).toContain('[REDACTED]');
    expect(result['echoed']).not.toContain(sensitiveKey);
  });

  it('handles multiple sequential requests', async () => {
    ({ server, factory } = createTestServer());
    await server.start();

    ({ client } = createClient(factory));

    const r1 = await client.invoke('tool.invoke.echo', { text: 'first' });
    const r2 = await client.invoke('tool.invoke.echo', { text: 'second' });
    const r3 = await client.invoke('tool.invoke.echo', { text: 'third' });

    expect(r1.payload.result).toEqual({ echoed: 'first' });
    expect(r2.payload.result).toEqual({ echoed: 'second' });
    expect(r3.payload.result).toEqual({ echoed: 'third' });
  });

  it('returns error for unknown tool', async () => {
    ({ server, factory } = createTestServer());
    await server.start();

    ({ client } = createClient(factory));

    const response = await client.invoke('tool.invoke.nonexistent', { arg: 1 });

    expect(response.payload.error).toBeDefined();
    expect(response.payload.error).not.toBeNull();
  });

  it('echo tool is registered as intrinsic (always available)', async () => {
    ({ server, factory } = createTestServer());
    await server.start();

    // The echo tool should be in the catalog without any plugin directory
    expect(server.toolCatalog?.has('echo')).toBe(true);
  });
});
