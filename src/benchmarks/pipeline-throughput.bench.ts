/**
 * Pipeline throughput benchmark (QA-11).
 *
 * Measures messages/second through the full 6-stage validation pipeline
 * using the IntegrationHarness with in-memory fake ZeroMQ sockets.
 *
 * Target: >100 msg/s through full pipeline.
 */

import { bench, describe } from 'vitest';
import { IntegrationHarness } from '../testing/integration-harness.js';
import type { HarnessSession } from '../testing/integration-harness.js';

// Module-level setup — runs once before benchmarks
const harness = await IntegrationHarness.create({
  rateLimiterConfig: { requestsPerMinute: 600_000, burstSize: 100_000 },
});
harness.registerTool(
  {
    name: 'echo',
    description: 'Echo tool for benchmarking',
    risk_level: 'low',
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
    },
  },
  async (envelope) => {
    const args = envelope.payload.arguments as Record<string, unknown>;
    return { echoed: args['text'] };
  },
);

// Pre-create a session for benchmarks
const session: HarnessSession = harness.createSession({ group: 'bench' });

describe('pipeline throughput', () => {
  bench(
    'full 6-stage pipeline (sendRequest)',
    async () => {
      await harness.sendRequest(session, 'echo', { text: 'benchmark' });
    },
    { iterations: 500, time: 5000 },
  );

  bench(
    'full pipeline with wire serialization (sendWireRequest)',
    async () => {
      await harness.sendWireRequest(session, {
        topic: 'tool.invoke.echo',
        correlation: crypto.randomUUID(),
        arguments: { text: 'benchmark' },
      });
    },
    { iterations: 200, time: 5000 },
  );
});
