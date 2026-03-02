/**
 * Real container E2E tests for API mode.
 *
 * Spins up actual containers with a real Anthropic API key, connects via
 * HTTP (UDS or TCP), sends prompts to Claude, and verifies the full
 * pipeline from container spawn through streaming response to EventBus
 * event publication.
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY env var set
 *   - Container image built (CARAPACE_IMAGE or 'carapace:latest')
 *   - A container runtime available (Docker, Podman, or Apple Containers)
 *
 * Run with:
 *   ANTHROPIC_API_KEY=sk-... pnpm run test:e2e -- src/core/container/api-mode.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ContainerLifecycleManager } from './lifecycle-manager.js';
import type { ManagedContainer, SpawnRequest } from './lifecycle-manager.js';
import { SessionManager } from '../session-manager.js';
import { ApiOutputReader } from '../api-output-reader.js';
import { DockerRuntime } from './docker-runtime.js';
import { PodmanRuntime } from './podman-runtime.js';
import { AppleContainerRuntime } from './apple-container-runtime.js';
import type { ContainerRuntime } from './runtime.js';
import type { EventEnvelope } from '../../types/protocol.js';

// ---------------------------------------------------------------------------
// Prerequisites (module-level, resolved before describe)
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CARAPACE_IMAGE = process.env.CARAPACE_IMAGE ?? 'carapace:latest';
const HAS_API_KEY = !!ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// Runtime-aware network configuration
// ---------------------------------------------------------------------------

function getNetworkName(runtime: ContainerRuntime): string | undefined {
  switch (runtime.name) {
    case 'docker':
      return 'bridge';
    case 'podman':
      return 'podman';
    case 'apple-container':
      // Apple Containers need a named network for API mode (port publishing
      // requires network interfaces). This returns 'default' for the standard
      // VM network. Note: Apple Container port publishing has a known
      // ECONNRESET bug in v0.9.0 — see findAvailableRuntime() exclusion.
      return 'default';
    default:
      return 'bridge';
  }
}

// ---------------------------------------------------------------------------
// Runtime CLI binary for belt-and-suspenders cleanup
// ---------------------------------------------------------------------------

function runtimeBinary(runtime: ContainerRuntime): string {
  switch (runtime.name) {
    case 'docker':
      return 'docker';
    case 'podman':
      return 'podman';
    case 'apple-container':
      return 'container';
    default:
      return 'docker';
  }
}

// ---------------------------------------------------------------------------
// Find available runtime
// ---------------------------------------------------------------------------

/**
 * Detect an available container runtime for API mode E2E tests.
 *
 * Override with CARAPACE_E2E_RUNTIME=docker|podman|apple-container.
 *
 * Apple Containers is excluded by default — its port publishing has a
 * known ECONNRESET bug in v0.9.0 that prevents the host from reaching
 * the container's HTTP server via `-p`.
 */
async function findAvailableRuntime(): Promise<ContainerRuntime | undefined> {
  const forced = process.env.CARAPACE_E2E_RUNTIME;
  if (forced) {
    const rt = createRuntime(forced);
    if (rt && (await rt.isAvailable())) return rt;
    return undefined;
  }

  // Prefer Docker/Podman — Apple Containers port publishing is broken
  const runtimes: ContainerRuntime[] = [new DockerRuntime(), new PodmanRuntime()];
  for (const rt of runtimes) {
    try {
      if (await rt.isAvailable()) return rt;
    } catch {
      // Skip unavailable runtimes
    }
  }
  return undefined;
}

function createRuntime(name: string): ContainerRuntime | undefined {
  switch (name) {
    case 'docker':
      return new DockerRuntime();
    case 'podman':
      return new PodmanRuntime();
    case 'apple-container':
      return new AppleContainerRuntime();
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_API_KEY)('API mode E2E (real containers)', () => {
  let runtime: ContainerRuntime;
  let sessionManager: SessionManager;
  let lifecycleManager: ContainerLifecycleManager;
  let tmpSocketPath: string;

  // Track current container handle for log capture on failure
  let currentManaged: ManagedContainer | undefined;

  beforeAll(async () => {
    // Detect runtime
    const detected = await findAvailableRuntime();
    if (!detected) {
      throw new Error('No container runtime available (Docker, Podman, or Apple Containers)');
    }
    runtime = detected;

    // Verify image exists
    const imageExists = await runtime.imageExists(CARAPACE_IMAGE);
    if (!imageExists) {
      throw new Error(
        `Container image '${CARAPACE_IMAGE}' not found. Build it first with: pnpm run build:image`,
      );
    }

    // Create dummy socket file for ZMQ mount (required by SpawnRequest but unused in API mode)
    tmpSocketPath = join(os.tmpdir(), `carapace-e2e-${crypto.randomUUID()}.sock`);
    writeFileSync(tmpSocketPath, '');

    // Create session manager and lifecycle manager
    sessionManager = new SessionManager();
    lifecycleManager = new ContainerLifecycleManager({
      runtime,
      sessionManager,
      useApiMode: true,
      networkName: getNetworkName(runtime),
      healthCheckTimeoutMs: 90_000,
    });
  }, 30_000);

  afterEach(async (ctx) => {
    // Capture container logs on test failure (best-effort)
    if (ctx.task.result?.state === 'fail' && currentManaged) {
      try {
        const bin = runtimeBinary(runtime);
        const logs = execFileSync(bin, ['logs', currentManaged.handle.id], {
          encoding: 'utf-8',
          timeout: 10_000,
        });
        console.error(`Container logs for failed test "${ctx.task.name}":\n${logs}`);
      } catch {
        /* best-effort log capture */
      }
    }
    currentManaged = undefined;
  });

  afterAll(async () => {
    // Shut down all managed containers
    if (lifecycleManager) {
      await lifecycleManager.shutdownAll();
    }

    // Belt-and-suspenders: force-remove any leaked containers.
    // NOTE: The `-aqf` and `--format` flags are Docker/Podman-specific.
    // Apple Containers uses a different CLI surface and is excluded from
    // the default E2E runtime list (see findAvailableRuntime).
    if (runtime) {
      try {
        const bin = runtimeBinary(runtime);
        const output = execFileSync(bin, ['ps', '-aqf', 'name=carapace-', '--format', '{{.ID}}'], {
          encoding: 'utf-8',
          timeout: 10_000,
        });
        const ids = output
          .trim()
          .split('\n')
          .filter((id) => id.length > 0);
        for (const id of ids) {
          try {
            execFileSync(bin, ['rm', '-f', id], { timeout: 10_000 });
          } catch {
            /* best effort */
          }
        }
      } catch {
        /* best effort */
      }
    }

    // Remove dummy socket file
    if (tmpSocketPath && existsSync(tmpSocketPath)) {
      try {
        unlinkSync(tmpSocketPath);
      } catch {
        /* best effort */
      }
    }
  });

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function makeSpawnRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
    return {
      group: 'e2e-test',
      image: CARAPACE_IMAGE,
      socketPath: tmpSocketPath,
      stdinData: `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}\n\n`,
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // Test 1: Container spawn and health check
  // -----------------------------------------------------------------------

  it('spawns container and passes health check', async () => {
    const managed = await lifecycleManager.spawn(makeSpawnRequest());
    currentManaged = managed;

    // Health check passed during spawn (apiClient is defined)
    expect(managed.apiClient).toBeDefined();

    // Container is running
    const state = await runtime.inspect(managed.handle);
    expect(state.status).toBe('running');

    // Shut down and verify cleanup
    const sessionId = managed.session.sessionId;
    await lifecycleManager.shutdown(sessionId);
    currentManaged = undefined;

    // Session is gone
    expect(sessionManager.get(sessionId)).toBeNull();
  }, 120_000);

  // -----------------------------------------------------------------------
  // Test 2: Non-streaming completion
  // -----------------------------------------------------------------------

  it('sends non-streaming completion and receives response', async () => {
    const managed = await lifecycleManager.spawn(makeSpawnRequest());
    currentManaged = managed;

    // Verify the API key reached the container via health check
    const healthResult = await managed.apiClient!.health();
    const checks = (healthResult as Record<string, unknown>)['checks'] as Record<string, unknown>;
    expect(checks).toMatchObject({ anthropic_key: 'ok' });

    // Drain stdout/stderr from the spawn handle to prevent pipe buffer blocking
    if (managed.handle.stdout) {
      managed.handle.stdout.on('data', () => {});
    }
    if (managed.handle.stderr) {
      managed.handle.stderr.on('data', () => {});
    }

    const response = await managed.apiClient!.complete({
      prompt: "Respond with only the word 'hello'. Do not include any other text.",
    });

    // Verify OpenAI ChatCompletion response structure
    expect(response.id).toBeDefined();
    expect(response.model).toBeDefined();
    expect(response.choices).toBeDefined();
    expect(response.choices.length).toBeGreaterThan(0);
    expect(response.choices[0]!.message.content).toBeDefined();
    expect(response.choices[0]!.message.content.toLowerCase()).toContain('hello');

    await lifecycleManager.shutdown(managed.session.sessionId);
    currentManaged = undefined;
  }, 120_000);

  // -----------------------------------------------------------------------
  // Test 3: Streaming completion
  // -----------------------------------------------------------------------

  it('sends streaming completion and collects chunks', async () => {
    const managed = await lifecycleManager.spawn(makeSpawnRequest());
    currentManaged = managed;

    const chunks: import('./sse-parser.js').ChatCompletionChunk[] = [];
    for await (const chunk of managed.apiClient!.completeStream({
      prompt: "Respond with only the word 'world'. Do not include any other text.",
    })) {
      chunks.push(chunk);
    }

    // At least one chunk should have text content
    const contentChunks = chunks.filter((c) => c.choices.length > 0 && c.choices[0]!.delta.content);
    expect(contentChunks.length).toBeGreaterThan(0);

    // Final chunk should have finish_reason: 'stop'
    const finalChunks = chunks.filter(
      (c) => c.choices.length > 0 && c.choices[0]!.finish_reason === 'stop',
    );
    expect(finalChunks.length).toBeGreaterThan(0);

    await lifecycleManager.shutdown(managed.session.sessionId);
    currentManaged = undefined;
  }, 120_000);

  // -----------------------------------------------------------------------
  // Test 4: Full pipeline — stream → ApiOutputReader → EventBus events
  // -----------------------------------------------------------------------

  it('processes stream through ApiOutputReader and publishes EventBus events', async () => {
    const managed = await lifecycleManager.spawn(makeSpawnRequest());
    currentManaged = managed;

    // Collect published events
    const events: EventEnvelope[] = [];
    const eventBus = {
      publish: async (envelope: EventEnvelope) => {
        events.push(envelope);
      },
    };

    // Lenient session store (accepts non-UUID session IDs like chatcmpl-*)
    const claudeSessionStore = {
      save: vi.fn((_group: string, _sessionId: string) => {}),
    };

    const apiReader = new ApiOutputReader({ eventBus, claudeSessionStore });

    const session = {
      sessionId: managed.session.sessionId,
      group: managed.session.group,
      containerId: managed.handle.id,
    };

    await apiReader.processStream(
      managed.apiClient!.completeStream({
        prompt: 'Respond with exactly one word: "test".',
      }),
      session,
    );

    // Verify response.system is published first
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.topic).toBe('response.system');

    // Verify one or more response.chunk events with text
    const chunkEvents = events.filter((e) => e.topic === 'response.chunk');
    expect(chunkEvents.length).toBeGreaterThan(0);
    const hasText = chunkEvents.some(
      (e) => typeof (e.payload as Record<string, unknown>)['text'] === 'string',
    );
    expect(hasText).toBe(true);

    // Verify response.end is published last
    const lastEvent = events[events.length - 1]!;
    expect(lastEvent.topic).toBe('response.end');
    expect((lastEvent.payload as Record<string, unknown>)['exitCode']).toBe(0);

    // Verify all events have valid envelope fields
    for (const event of events) {
      expect(event.id).toBeDefined();
      expect(event.version).toBeDefined();
      expect(event.type).toBe('event');
      expect(event.source).toBe(managed.handle.id);
      expect(event.group).toBe('e2e-test');
      expect(event.timestamp).toBeDefined();
    }

    // Verify monotonic sequence numbers
    const seqs = events.map((e) => (e.payload as Record<string, unknown>)['seq'] as number);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }

    await lifecycleManager.shutdown(managed.session.sessionId);
    currentManaged = undefined;
  }, 180_000);

  // -----------------------------------------------------------------------
  // Test 5: Sequential completions on same container
  // -----------------------------------------------------------------------

  it('handles multiple sequential completions on same container', async () => {
    const managed = await lifecycleManager.spawn(makeSpawnRequest());
    currentManaged = managed;

    // First completion
    const firstResponse = await managed.apiClient!.complete({
      prompt: "Respond with only the word 'alpha'. Do not include any other text.",
    });
    expect(firstResponse.id).toBeDefined();
    expect(firstResponse.choices[0]!.message.content.toLowerCase()).toContain('alpha');

    // Second completion — verifies the container stays healthy across requests
    const secondResponse = await managed.apiClient!.complete({
      prompt: "Respond with only the word 'beta'. Do not include any other text.",
    });
    expect(secondResponse.id).toBeDefined();
    expect(secondResponse.choices[0]!.message.content.toLowerCase()).toContain('beta');

    await lifecycleManager.shutdown(managed.session.sessionId);
    currentManaged = undefined;
  }, 180_000);
});
