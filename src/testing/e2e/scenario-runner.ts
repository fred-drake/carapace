/**
 * E2E scenario runner (QA-08).
 *
 * Executes e2e scenarios against the IntegrationHarness, records all
 * tool invocations, evaluates semantic assertions, and collects results
 * with cost tracking. Supports timeout and retry logic.
 */

import { IntegrationHarness } from '../integration-harness.js';
import type { HarnessSession } from '../integration-harness.js';
import type { ResponseEnvelope } from '../../types/protocol.js';
import type { ErrorCodeValue } from '../../types/errors.js';
import { evaluateAllAssertions } from './assertions.js';
import type {
  E2EScenario,
  ScenarioContext,
  ScenarioRecording,
  RecordedInvocation,
  ScenarioAttempt,
  ScenarioResult,
  SuiteReport,
  CostMetrics,
} from './types.js';

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 0;
const DEFAULT_GROUP = 'test';

// High rate limit so scenarios don't hit limits unless deliberately configured
const DEFAULT_RATE_CONFIG = { requestsPerMinute: 600_000, burstSize: 100_000 };

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

/** Run a single scenario and return the result (with retries). */
export async function runScenario(scenario: E2EScenario): Promise<ScenarioResult> {
  const maxAttempts = 1 + (scenario.retries ?? DEFAULT_RETRIES);
  const attempts: ScenarioAttempt[] = [];
  const suiteStart = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runSingleAttempt(scenario, attempt);
    attempts.push(result);

    if (result.passed) {
      return {
        name: scenario.name,
        description: scenario.description,
        tags: scenario.tags ?? [],
        passed: true,
        attempts,
        passingAttempt: attempt,
        totalDurationMs: Date.now() - suiteStart,
      };
    }
  }

  return {
    name: scenario.name,
    description: scenario.description,
    tags: scenario.tags ?? [],
    passed: false,
    attempts,
    passingAttempt: 0,
    totalDurationMs: Date.now() - suiteStart,
  };
}

/** Run all scenarios and produce a suite report. */
export async function runSuite(scenarios: E2EScenario[]): Promise<SuiteReport> {
  const suiteStart = Date.now();
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  const totalCost: CostMetrics = {
    toolInvocations: 0,
    toolTimeMs: 0,
    eventsPublished: 0,
    estimatedCostUsd: 0,
  };

  for (const result of results) {
    for (const attempt of result.attempts) {
      totalCost.toolInvocations += attempt.cost.toolInvocations;
      totalCost.toolTimeMs += attempt.cost.toolTimeMs;
      totalCost.eventsPublished += attempt.cost.eventsPublished;
      totalCost.estimatedCostUsd += attempt.cost.estimatedCostUsd;
    }
  }

  return {
    results,
    total: results.length,
    passed,
    failed,
    passRate: results.length > 0 ? (passed / results.length) * 100 : 0,
    totalDurationMs: Date.now() - suiteStart,
    totalCost,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Single attempt runner
// ---------------------------------------------------------------------------

async function runSingleAttempt(scenario: E2EScenario, attempt: number): Promise<ScenarioAttempt> {
  const timeoutMs = scenario.timeout ?? DEFAULT_TIMEOUT_MS;
  let harness: IntegrationHarness | null = null;

  try {
    // Create harness with high default rate limits
    harness = await IntegrationHarness.create({ rateLimiterConfig: DEFAULT_RATE_CONFIG });

    // Run setup
    await scenario.setup(harness);

    // Create session
    const session = harness.createSession({ group: scenario.group ?? DEFAULT_GROUP });

    // Build recording context
    const recording: ScenarioRecording = {
      invocations: [],
      events: [],
      notes: [],
      startedAt: Date.now(),
      finishedAt: 0,
      durationMs: 0,
    };

    const ctx = createScenarioContext(harness, session, recording);

    // Run steps with timeout
    await withTimeout(scenario.steps(ctx), timeoutMs);

    recording.finishedAt = Date.now();
    recording.durationMs = recording.finishedAt - recording.startedAt;

    // Evaluate assertions
    const assertionResults = evaluateAllAssertions(scenario.assertions, recording);
    const allPassed = assertionResults.every((r) => r.passed);

    return {
      attempt,
      passed: allPassed,
      recording,
      assertionResults,
      cost: computeCost(recording),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      attempt,
      passed: false,
      recording: emptyRecording(),
      assertionResults: [],
      cost: emptyCost(),
      error: message,
    };
  } finally {
    if (harness) {
      await harness.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

function createScenarioContext(
  harness: IntegrationHarness,
  session: HarnessSession,
  recording: ScenarioRecording,
): ScenarioContext {
  return {
    harness,
    session,

    async invoke(tool: string, args: Record<string, unknown>): Promise<ResponseEnvelope> {
      const start = Date.now();
      const response = await harness.sendRequest(session, tool, args);
      const durationMs = Date.now() - start;

      const success = response.payload.error === null;
      const errorCode = response.payload.error?.code as ErrorCodeValue | undefined;

      const invocation: RecordedInvocation = {
        tool,
        args,
        response,
        durationMs,
        success,
        errorCode,
        offsetMs: Date.now() - recording.startedAt,
      };

      recording.invocations.push(invocation);
      return response;
    },

    note(message: string): void {
      recording.notes.push(message);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T> | T, ms: number): Promise<T> {
  if (!(promise instanceof Promise)) return Promise.resolve(promise);

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Scenario timed out after ${ms}ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function computeCost(recording: ScenarioRecording): CostMetrics {
  return {
    toolInvocations: recording.invocations.length,
    toolTimeMs: recording.invocations.reduce((sum, i) => sum + i.durationMs, 0),
    eventsPublished: recording.events.length,
    // Placeholder: $0.001 per tool invocation as a rough estimate
    estimatedCostUsd: recording.invocations.length * 0.001,
  };
}

function emptyRecording(): ScenarioRecording {
  const now = Date.now();
  return {
    invocations: [],
    events: [],
    notes: [],
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
  };
}

function emptyCost(): CostMetrics {
  return {
    toolInvocations: 0,
    toolTimeMs: 0,
    eventsPublished: 0,
    estimatedCostUsd: 0,
  };
}
