/**
 * Container spawn time benchmark (QA-11).
 *
 * Measures container spawn latency using MockContainerRuntime.
 * This benchmarks the lifecycle manager overhead, not actual Docker/Podman
 * startup. Real container spawn benchmarks require the e2e test infrastructure.
 *
 * Target: <10s cold start (mock measures overhead only).
 */

import { bench, describe } from 'vitest';
import { MockContainerRuntime } from '../core/container/mock-runtime.js';
import { ContainerLifecycleManager } from '../core/container/lifecycle-manager.js';
import { SessionManager } from '../core/session-manager.js';

describe('container spawn (mock runtime)', () => {
  bench(
    'single container spawn',
    async () => {
      const runtime = new MockContainerRuntime();
      const sessionManager = new SessionManager();
      const lifecycle = new ContainerLifecycleManager({ runtime, sessionManager });
      await lifecycle.spawn({
        group: 'bench',
        image: 'carapace:latest',
        socketPath: '/tmp/bench.sock',
      });
      await lifecycle.shutdownAll();
    },
    { iterations: 200, time: 5000 },
  );

  bench(
    'sequential spawn + shutdown cycle',
    async () => {
      const runtime = new MockContainerRuntime();
      const sessionManager = new SessionManager();
      const lifecycle = new ContainerLifecycleManager({ runtime, sessionManager });
      const managed = await lifecycle.spawn({
        group: 'bench',
        image: 'carapace:latest',
        socketPath: '/tmp/bench.sock',
      });
      await lifecycle.shutdown(managed.session.sessionId);
    },
    { iterations: 100, time: 5000 },
  );

  bench(
    'concurrent spawn (5 containers)',
    async () => {
      const runtime = new MockContainerRuntime();
      const sessionManager = new SessionManager();
      const lifecycle = new ContainerLifecycleManager({ runtime, sessionManager });
      const spawns = Array.from({ length: 5 }, (_, i) =>
        lifecycle.spawn({
          group: `bench-${i}`,
          image: 'carapace:latest',
          socketPath: `/tmp/bench-${i}.sock`,
        }),
      );
      await Promise.all(spawns);
      await lifecycle.shutdownAll();
    },
    { iterations: 50, time: 5000 },
  );
});
