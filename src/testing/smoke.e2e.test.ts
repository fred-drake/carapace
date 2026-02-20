/**
 * E2E smoke test (QA-11).
 *
 * Validates the full Phase E2E pipeline end-to-end in a single test:
 *   1. Start host server (Server + FakeSocketFactory)
 *   2. Spawn container (ContainerLifecycleManager + MockContainerRuntime)
 *   3. Connect container-side IPC client
 *   4. Agent sends echo request via IPC
 *   5. Host routes through 6-stage pipeline + echo handler + ResponseSanitizer
 *   6. Verify response content matches expected
 *   7. Graceful shutdown of container and server
 *   8. Verify no zombie containers, no leaked sessions, no dangling sockets
 *
 * All in-memory (FakeSocketFactory + MockContainerRuntime). No Docker.
 * Runs in CI. Under 60 seconds.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Server } from '../core/server.js';
import type { ServerConfig, ServerDeps } from '../core/server.js';
import { FakeSocketFactory } from './fake-socket-factory.js';
import { FakeDealerSocket } from './fake-sockets.js';
import { IpcClient } from '../ipc/ipc-client.js';
import { ContainerLifecycleManager } from '../core/container/lifecycle-manager.js';
import { MockContainerRuntime } from '../core/container/mock-runtime.js';
import { SessionManager } from '../core/session-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SmokeContext {
  server: Server;
  factory: FakeSocketFactory;
  runtime: MockContainerRuntime;
  lifecycleManager: ContainerLifecycleManager;
  sessionManager: SessionManager;
}

function createSmokeContext(): SmokeContext {
  const factory = new FakeSocketFactory();
  const config: ServerConfig = {
    socketDir: '/tmp/smoke-test-sockets',
    pluginsDir: '/tmp/nonexistent-plugins',
  };
  const deps: ServerDeps = {
    socketFactory: factory,
    fs: {
      existsSync: () => false,
      mkdirSync: () => {},
      chmodSync: () => {},
      unlinkSync: () => {},
      readdirSync: () => [],
    },
  };
  const server = new Server(config, deps);

  const runtime = new MockContainerRuntime();
  const sessionManager = new SessionManager();
  const lifecycleManager = new ContainerLifecycleManager({
    runtime,
    sessionManager,
    shutdownTimeoutMs: 500,
  });

  return { server, factory, runtime, lifecycleManager, sessionManager };
}

function createIpcClient(factory: FakeSocketFactory): {
  client: IpcClient;
  dealer: FakeDealerSocket;
} {
  const router = factory.getRouters()[0];
  const dealer = new FakeDealerSocket();
  dealer.connectedTo = router;
  void dealer.connect('ipc:///tmp/smoke-test-sockets/server-request.sock');
  const client = new IpcClient(dealer, { timeoutMs: 5000 });
  return { client, dealer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E smoke test: full pipeline', () => {
  let ctx: SmokeContext;
  let client: IpcClient;

  afterEach(async () => {
    await client?.close();
    await ctx?.lifecycleManager?.shutdownAll();
    await ctx?.server?.stop();
    await ctx?.factory?.cleanup();
  });

  // -------------------------------------------------------------------------
  // 1. Full pipeline round-trip
  // -------------------------------------------------------------------------

  it('server start → container spawn → echo invocation → shutdown → clean', async () => {
    ctx = createSmokeContext();

    // 1. Start host server
    await ctx.server.start();
    expect(ctx.server.toolCatalog?.has('echo')).toBe(true);

    // 2. Spawn container (simulated via MockContainerRuntime)
    const managed = await ctx.lifecycleManager.spawn({
      group: 'smoke-test',
      image: 'carapace-agent:latest',
      socketPath: '/tmp/smoke-test-sockets/server-request.sock',
    });
    expect(managed.session.group).toBe('smoke-test');

    // Verify container is running
    const containerState = await ctx.runtime.inspect(managed.handle);
    expect(containerState.status).toBe('running');

    // 3. Connect container-side IPC client
    ({ client } = createIpcClient(ctx.factory));

    // 4. Agent sends echo request
    const response = await client.invoke('tool.invoke.echo', { text: 'smoke test hello' });

    // 5. Verify response
    expect(response.payload.error).toBeNull();
    expect(response.payload.result).toEqual({ echoed: 'smoke test hello' });
    expect(response.topic).toBe('tool.invoke.echo');
    expect(response.correlation).toBeDefined();

    // 6. Graceful shutdown — container first, then server
    await client.close();
    const shutdownResult = await ctx.lifecycleManager.shutdown(managed.session.sessionId);
    expect(shutdownResult).toBe(true);
    await ctx.server.stop();

    // 7. Verify no zombies / leaks
    expect(ctx.lifecycleManager.getAll()).toHaveLength(0);
    expect(ctx.sessionManager.getAll()).toHaveLength(0);
    expect(ctx.runtime.getRunningHandles()).toHaveLength(0);
    expect(ctx.server.toolCatalog).toBeNull();
    expect(ctx.server.sessionManager).toBeNull();
    expect(ctx.server.responseSanitizer).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. Credential sanitization in full pipeline
  // -------------------------------------------------------------------------

  it('response sanitizer redacts credentials through the full pipeline', async () => {
    ctx = createSmokeContext();
    await ctx.server.start();

    await ctx.lifecycleManager.spawn({
      group: 'security-test',
      image: 'carapace-agent:latest',
      socketPath: '/tmp/smoke-test-sockets/server-request.sock',
    });

    ({ client } = createIpcClient(ctx.factory));

    // Send text with a credential pattern matching api_key_prefix regex
    const sensitiveKey = 'sk_live_abcdefgh12345678';
    const response = await client.invoke('tool.invoke.echo', {
      text: `my key is ${sensitiveKey}`,
    });

    expect(response.payload.error).toBeNull();
    const result = response.payload.result as Record<string, unknown>;
    expect(result['echoed']).toContain('[REDACTED]');
    expect(result['echoed']).not.toContain(sensitiveKey);
  });

  // -------------------------------------------------------------------------
  // 3. Multiple containers with independent invocations
  // -------------------------------------------------------------------------

  it('multiple containers invoke tools independently', async () => {
    ctx = createSmokeContext();
    await ctx.server.start();

    // Spawn two containers in different groups
    const container1 = await ctx.lifecycleManager.spawn({
      group: 'email',
      image: 'carapace-agent:latest',
      socketPath: '/tmp/smoke-test-sockets/server-request.sock',
    });
    const container2 = await ctx.lifecycleManager.spawn({
      group: 'slack',
      image: 'carapace-agent:latest',
      socketPath: '/tmp/smoke-test-sockets/server-request.sock',
    });

    expect(ctx.lifecycleManager.getAll()).toHaveLength(2);

    // Each container uses its own IPC client
    const { client: client1 } = createIpcClient(ctx.factory);
    const { client: client2 } = createIpcClient(ctx.factory);

    const r1 = await client1.invoke('tool.invoke.echo', { text: 'from email' });
    const r2 = await client2.invoke('tool.invoke.echo', { text: 'from slack' });

    expect(r1.payload.result).toEqual({ echoed: 'from email' });
    expect(r2.payload.result).toEqual({ echoed: 'from slack' });

    // Cleanup
    await client1.close();
    await client2.close();
    client = undefined as unknown as IpcClient; // prevent double-close in afterEach

    // Shutdown both containers
    await ctx.lifecycleManager.shutdownAll();
    expect(ctx.lifecycleManager.getAll()).toHaveLength(0);
    expect(ctx.runtime.getRunningHandles()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. Validation rejection through full pipeline
  // -------------------------------------------------------------------------

  it('rejects invalid arguments through full pipeline', async () => {
    ctx = createSmokeContext();
    await ctx.server.start();

    await ctx.lifecycleManager.spawn({
      group: 'validation-test',
      image: 'carapace-agent:latest',
      socketPath: '/tmp/smoke-test-sockets/server-request.sock',
    });

    ({ client } = createIpcClient(ctx.factory));

    // Omit required 'text' argument
    const response = await client.invoke('tool.invoke.echo', {});

    expect(response.payload.error).not.toBeNull();
    expect(response.payload.error!.code).toBe('VALIDATION_FAILED');
  });

  // -------------------------------------------------------------------------
  // 5. Unknown tool error through full pipeline
  // -------------------------------------------------------------------------

  it('returns error for unknown tool through full pipeline', async () => {
    ctx = createSmokeContext();
    await ctx.server.start();

    await ctx.lifecycleManager.spawn({
      group: 'error-test',
      image: 'carapace-agent:latest',
      socketPath: '/tmp/smoke-test-sockets/server-request.sock',
    });

    ({ client } = createIpcClient(ctx.factory));

    const response = await client.invoke('tool.invoke.nonexistent', { arg: 1 });

    expect(response.payload.error).toBeDefined();
    expect(response.payload.error).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. Server stop is idempotent
  // -------------------------------------------------------------------------

  it('server stop is idempotent and cleans up all subsystems', async () => {
    ctx = createSmokeContext();
    await ctx.server.start();

    ({ client } = createIpcClient(ctx.factory));
    await client.invoke('tool.invoke.echo', { text: 'before stop' });

    await client.close();
    client = undefined as unknown as IpcClient;

    // Stop twice — should not throw
    await ctx.server.stop();
    await ctx.server.stop();

    // All subsystems are null after stop
    expect(ctx.server.toolCatalog).toBeNull();
    expect(ctx.server.sessionManager).toBeNull();
    expect(ctx.server.responseSanitizer).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 7. Container crash detection in full pipeline
  // -------------------------------------------------------------------------

  it('detects container crash and cleans up properly', async () => {
    ctx = createSmokeContext();
    await ctx.server.start();

    const managed = await ctx.lifecycleManager.spawn({
      group: 'crash-test',
      image: 'carapace-agent:latest',
      socketPath: '/tmp/smoke-test-sockets/server-request.sock',
    });

    // Simulate crash
    ctx.runtime.simulateCrash(managed.handle);

    // Container status should show dead
    const status = await ctx.lifecycleManager.getStatus(managed.session.sessionId);
    expect(status!.status).toBe('dead');
    expect(status!.exitCode).toBe(137);

    // Shutdown still cleans up
    const result = await ctx.lifecycleManager.shutdown(managed.session.sessionId);
    expect(result).toBe(true);

    // Nothing leaked
    expect(ctx.lifecycleManager.getAll()).toHaveLength(0);
    expect(ctx.sessionManager.getAll()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 8. Sequential requests maintain pipeline integrity
  // -------------------------------------------------------------------------

  it('handles sequential requests without pipeline state leaks', async () => {
    ctx = createSmokeContext();
    await ctx.server.start();

    await ctx.lifecycleManager.spawn({
      group: 'sequential-test',
      image: 'carapace-agent:latest',
      socketPath: '/tmp/smoke-test-sockets/server-request.sock',
    });

    ({ client } = createIpcClient(ctx.factory));

    // Send multiple requests sequentially
    const responses = [];
    for (let i = 0; i < 5; i++) {
      const r = await client.invoke('tool.invoke.echo', { text: `msg-${i}` });
      responses.push(r);
    }

    // All should succeed with correct payloads
    for (let i = 0; i < 5; i++) {
      expect(responses[i]!.payload.error).toBeNull();
      expect(responses[i]!.payload.result).toEqual({ echoed: `msg-${i}` });
    }

    // All have unique correlation IDs
    const correlations = new Set(responses.map((r) => r.correlation));
    expect(correlations.size).toBe(5);
  });
});
