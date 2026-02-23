/**
 * Integration tests: event-to-spawn wiring.
 *
 * Proves the full pipeline from event publication through to container spawn
 * and session registration. Uses AutoWiringSocketFactory so PUB/SUB delivery
 * works in-process, with a mock container runtime (no real Docker).
 *
 * Covers:
 *   - message.inbound → validate group + payload → spawn → session registered
 *   - task.triggered → bypass group check → CARAPACE_TASK_PROMPT env → spawn
 *   - Unconfigured group → dropped, no spawn
 *   - Concurrent session limit → rejected, no spawn
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Server } from './server.js';
import type { ContainerRuntime, ContainerRunOptions } from './container/runtime.js';
import type { EventEnvelope } from '../types/protocol.js';
import { AutoWiringSocketFactory } from '../testing/integration-harness.js';
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

let containerCounter = 0;

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
    run: vi.fn().mockImplementation(async () => ({
      id: `container-${++containerCounter}`,
      name: `test-${containerCounter}`,
      runtime: 'docker' as const,
    })),
    stop: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({ status: 'running' as const }),
  };
}

function makeMessageInboundEnvelope(group: string): EventEnvelope {
  return {
    id: crypto.randomUUID(),
    version: 1,
    type: 'event',
    topic: 'message.inbound',
    source: 'test-plugin',
    correlation: null,
    timestamp: new Date().toISOString(),
    group,
    payload: {
      channel: 'email',
      sender: 'user@test.com',
      content_type: 'text',
      body: 'Hello from integration test',
    },
  };
}

function makeTaskTriggeredEnvelope(group: string, prompt: string): EventEnvelope {
  return {
    id: crypto.randomUUID(),
    version: 1,
    type: 'event',
    topic: 'task.triggered',
    source: 'cron',
    correlation: null,
    timestamp: new Date().toISOString(),
    group,
    payload: { prompt },
  };
}

interface TestContext {
  server: Server;
  socketFactory: AutoWiringSocketFactory;
  runtime: ContainerRuntime;
}

function createWiredServer(overrides?: {
  configuredGroups?: string[];
  maxSessionsPerGroup?: number;
  containerImage?: string;
  credentialsDir?: string;
  credentialFiles?: Record<string, string>;
}): TestContext {
  const socketFactory = new AutoWiringSocketFactory();
  const runtime = createMockRuntime();

  const server = new Server(
    {
      socketDir: '/tmp/carapace-wiring-test-sockets',
      pluginsDir: '/tmp/carapace-wiring-test-plugins',
      containerImage: overrides?.containerImage ?? 'carapace-agent:integration',
      configuredGroups: overrides?.configuredGroups ?? ['email', 'slack'],
      maxSessionsPerGroup: overrides?.maxSessionsPerGroup ?? 5,
      credentialsDir: overrides?.credentialsDir,
    },
    {
      socketFactory,
      fs: createMockFs(),
      containerRuntime: runtime,
      credentialFs: overrides?.credentialFiles
        ? {
            existsSync: (path: string) => path in (overrides.credentialFiles ?? {}),
            readFileSync: (path: string) => {
              const files = overrides.credentialFiles ?? {};
              if (path in files) return files[path];
              throw new Error(`ENOENT: ${path}`);
            },
            writeFileSync: vi.fn(),
            renameSync: vi.fn(),
          }
        : undefined,
    },
  );

  return { server, socketFactory, runtime };
}

/**
 * Publish an event through the PUB socket (simulating a plugin publishing).
 * The AutoWiringSocketFactory ensures SUB receives it.
 */
async function publishEvent(
  socketFactory: AutoWiringSocketFactory,
  envelope: EventEnvelope,
): Promise<void> {
  const pubs = socketFactory.getPublishers();
  const topicBuf = Buffer.from(envelope.topic, 'utf-8');
  const payloadBuf = Buffer.from(JSON.stringify(envelope), 'utf-8');
  await pubs[0].send(topicBuf, payloadBuf);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Server event-to-spawn wiring (integration)', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx?.server) {
      await ctx.server.stop();
    }
  });

  // -------------------------------------------------------------------------
  // message.inbound → spawn → session
  // -------------------------------------------------------------------------

  it('message.inbound event triggers container spawn', async () => {
    ctx = createWiredServer();
    await ctx.server.start();

    const envelope = makeMessageInboundEnvelope('email');
    await publishEvent(ctx.socketFactory, envelope);

    await vi.waitFor(() => {
      expect(ctx.runtime.run).toHaveBeenCalledTimes(1);
    });
  });

  it('message.inbound spawn uses configured container image', async () => {
    ctx = createWiredServer({ containerImage: 'my-custom-image:v2' });
    await ctx.server.start();

    const envelope = makeMessageInboundEnvelope('email');
    await publishEvent(ctx.socketFactory, envelope);

    await vi.waitFor(() => {
      expect(ctx.runtime.run).toHaveBeenCalledWith(
        expect.objectContaining({ image: 'my-custom-image:v2' }),
      );
    });
  });

  it('message.inbound spawn registers session in SessionManager', async () => {
    ctx = createWiredServer();
    await ctx.server.start();

    expect(ctx.server.sessionManager!.getAll().length).toBe(0);

    const envelope = makeMessageInboundEnvelope('email');
    await publishEvent(ctx.socketFactory, envelope);

    await vi.waitFor(() => {
      const sessions = ctx.server.sessionManager!.getAll();
      expect(sessions.length).toBe(1);
      expect(sessions[0].group).toBe('email');
    });
  });

  it('message.inbound spawn mounts the server request socket', async () => {
    ctx = createWiredServer();
    await ctx.server.start();

    const envelope = makeMessageInboundEnvelope('email');
    await publishEvent(ctx.socketFactory, envelope);

    await vi.waitFor(() => {
      const runCall = (ctx.runtime.run as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as ContainerRunOptions;
      expect(runCall.socketMounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            hostPath: expect.stringContaining('request.sock'),
          }),
        ]),
      );
    });
  });

  // -------------------------------------------------------------------------
  // task.triggered → CARAPACE_TASK_PROMPT → spawn
  // -------------------------------------------------------------------------

  it('task.triggered event triggers container spawn', async () => {
    ctx = createWiredServer();
    await ctx.server.start();

    const envelope = makeTaskTriggeredEnvelope('email', 'Summarize my inbox');
    await publishEvent(ctx.socketFactory, envelope);

    await vi.waitFor(() => {
      expect(ctx.runtime.run).toHaveBeenCalledTimes(1);
    });
  });

  it('task.triggered passes CARAPACE_TASK_PROMPT as container env', async () => {
    ctx = createWiredServer();
    await ctx.server.start();

    const prompt = 'Check for security alerts';
    const envelope = makeTaskTriggeredEnvelope('email', prompt);
    await publishEvent(ctx.socketFactory, envelope);

    await vi.waitFor(() => {
      const runCall = (ctx.runtime.run as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as ContainerRunOptions;
      expect(runCall.env).toEqual(expect.objectContaining({ CARAPACE_TASK_PROMPT: prompt }));
    });
  });

  it('task.triggered bypasses group configuration check', async () => {
    // Only 'email' is configured, but task.triggered for 'unconfigured' should still spawn
    ctx = createWiredServer({ configuredGroups: ['email'] });
    await ctx.server.start();

    const envelope = makeTaskTriggeredEnvelope('unconfigured-group', 'Run task');
    await publishEvent(ctx.socketFactory, envelope);

    await vi.waitFor(() => {
      expect(ctx.runtime.run).toHaveBeenCalledTimes(1);
    });
  });

  it('task.triggered spawn registers session in SessionManager', async () => {
    ctx = createWiredServer();
    await ctx.server.start();

    const envelope = makeTaskTriggeredEnvelope('slack', 'Daily standup summary');
    await publishEvent(ctx.socketFactory, envelope);

    await vi.waitFor(() => {
      const sessions = ctx.server.sessionManager!.getAll();
      expect(sessions.length).toBe(1);
      expect(sessions[0].group).toBe('slack');
    });
  });

  // -------------------------------------------------------------------------
  // Rejection cases
  // -------------------------------------------------------------------------

  it('message.inbound for unconfigured group does not spawn', async () => {
    ctx = createWiredServer({ configuredGroups: ['email'] });
    await ctx.server.start();

    const envelope = makeMessageInboundEnvelope('unknown-group');
    await publishEvent(ctx.socketFactory, envelope);

    // Give dispatch a tick to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ctx.runtime.run).not.toHaveBeenCalled();
    expect(ctx.server.sessionManager!.getAll().length).toBe(0);
  });

  it('concurrent session limit prevents additional spawns', async () => {
    ctx = createWiredServer({ maxSessionsPerGroup: 1 });
    await ctx.server.start();

    // First event: should spawn
    const e1 = makeMessageInboundEnvelope('email');
    await publishEvent(ctx.socketFactory, e1);

    await vi.waitFor(() => {
      expect(ctx.runtime.run).toHaveBeenCalledTimes(1);
    });

    // Second event: should be rejected (limit is 1)
    const e2 = makeMessageInboundEnvelope('email');
    await publishEvent(ctx.socketFactory, e2);

    // Give dispatch a tick to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Still only 1 spawn call
    expect(ctx.runtime.run).toHaveBeenCalledTimes(1);
    expect(ctx.server.sessionManager!.getAll().length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Multiple events
  // -------------------------------------------------------------------------

  it('multiple events for different groups spawn independent containers', async () => {
    ctx = createWiredServer();
    await ctx.server.start();

    const e1 = makeMessageInboundEnvelope('email');
    const e2 = makeMessageInboundEnvelope('slack');
    await publishEvent(ctx.socketFactory, e1);
    await publishEvent(ctx.socketFactory, e2);

    await vi.waitFor(() => {
      expect(ctx.runtime.run).toHaveBeenCalledTimes(2);
    });

    const sessions = ctx.server.sessionManager!.getAll();
    expect(sessions.length).toBe(2);

    const groups = sessions.map((s) => s.group).sort();
    expect(groups).toEqual(['email', 'slack']);
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  it('stop() cleans up containers spawned via event dispatch', async () => {
    ctx = createWiredServer();
    await ctx.server.start();

    const envelope = makeMessageInboundEnvelope('email');
    await publishEvent(ctx.socketFactory, envelope);

    await vi.waitFor(() => {
      expect(ctx.runtime.run).toHaveBeenCalledTimes(1);
    });

    await ctx.server.stop();

    // Lifecycle manager's shutdownAll calls stop + remove on each container
    expect(ctx.runtime.stop).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Credential injection
  // -------------------------------------------------------------------------

  it('spawned container receives stdinData when API key is configured', async () => {
    const credsDir = '/tmp/carapace-test-creds';
    ctx = createWiredServer({
      credentialsDir: credsDir,
      credentialFiles: {
        [`${credsDir}/anthropic-api-key`]: 'sk-ant-api03-test-key',
      },
    });
    await ctx.server.start();

    const envelope = makeMessageInboundEnvelope('email');
    await publishEvent(ctx.socketFactory, envelope);

    await vi.waitFor(() => {
      const runCall = (ctx.runtime.run as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as import('./container/runtime.js').ContainerRunOptions;
      expect(runCall.stdinData).toBe('ANTHROPIC_API_KEY=sk-ant-api03-test-key\n\n');
    });
  });

  it('spawned container has no stdinData when only OAuth credentials are configured', async () => {
    const credsDir = '/tmp/carapace-test-creds';
    ctx = createWiredServer({
      credentialsDir: credsDir,
      credentialFiles: {
        [`${credsDir}/claude-credentials.json`]: '{"accessToken":"abc","refreshToken":"xyz"}',
      },
    });
    await ctx.server.start();

    const envelope = makeMessageInboundEnvelope('email');
    await publishEvent(ctx.socketFactory, envelope);

    await vi.waitFor(() => {
      const runCall = (ctx.runtime.run as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as import('./container/runtime.js').ContainerRunOptions;
      // OAuth credentials are copied to claude-state dir, not injected via stdin
      expect(runCall.stdinData).toBeUndefined();
    });
  });

  it('spawned container has no stdinData when no credentials are configured', async () => {
    ctx = createWiredServer(); // no credentialsDir
    await ctx.server.start();

    const envelope = makeMessageInboundEnvelope('email');
    await publishEvent(ctx.socketFactory, envelope);

    await vi.waitFor(() => {
      const runCall = (ctx.runtime.run as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as import('./container/runtime.js').ContainerRunOptions;
      expect(runCall.stdinData).toBeUndefined();
    });
  });
});
