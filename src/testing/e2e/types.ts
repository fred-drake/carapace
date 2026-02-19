/**
 * E2E test infrastructure types (QA-08).
 *
 * Defines the scenario format, semantic assertions, recording structure,
 * and test result types for end-to-end tests driven by agent sessions.
 */

import type { ResponseEnvelope, EventEnvelope } from '../../types/protocol.js';
import type { ErrorCodeValue } from '../../types/errors.js';
import type { IntegrationHarness, HarnessSession } from '../integration-harness.js';

// ---------------------------------------------------------------------------
// Scenario definition
// ---------------------------------------------------------------------------

/** Context provided to scenario setup and step functions. */
export interface ScenarioContext {
  /** The integration harness for this scenario run. */
  harness: IntegrationHarness;
  /** The session representing the agent. */
  session: HarnessSession;
  /** Invoke a tool and record the result. */
  invoke(tool: string, args: Record<string, unknown>): Promise<ResponseEnvelope>;
  /** Record a note/observation for debugging. */
  note(message: string): void;
}

/** An e2e test scenario definition. */
export interface E2EScenario {
  /** Human-readable name for the scenario. */
  name: string;
  /** Description of what this scenario tests. */
  description: string;
  /** Optional tags for filtering (e.g., 'happy-path', 'error', 'security'). */
  tags?: string[];
  /** Group name for the session (default: 'test'). */
  group?: string;
  /** Timeout in ms for the entire scenario (default: 30000). */
  timeout?: number;
  /** Number of retry attempts for flaky scenarios (default: 0). */
  retries?: number;
  /** Configure the harness before the scenario runs. */
  setup: (harness: IntegrationHarness) => void | Promise<void>;
  /** Execute the scenario steps (tool invocations, etc.). */
  steps: (ctx: ScenarioContext) => void | Promise<void>;
  /** Semantic assertions to verify after steps complete. */
  assertions: SemanticAssertion[];
}

// ---------------------------------------------------------------------------
// Semantic assertions
// ---------------------------------------------------------------------------

/** A semantic assertion checked against the scenario recording. */
export type SemanticAssertion =
  | ToolInvokedAssertion
  | ToolNotInvokedAssertion
  | ToolInvokedCountAssertion
  | ToolInvokedInOrderAssertion
  | NoErrorsAssertion
  | ErrorCodeAssertion
  | ResponseContainsAssertion
  | ToolArgsMatchAssertion
  | CustomAssertion;

export interface ToolInvokedAssertion {
  type: 'tool_invoked';
  /** Tool name that must have been invoked. */
  tool: string;
}

export interface ToolNotInvokedAssertion {
  type: 'tool_not_invoked';
  /** Tool name that must NOT have been invoked. */
  tool: string;
}

export interface ToolInvokedCountAssertion {
  type: 'tool_invoked_count';
  /** Tool name. */
  tool: string;
  /** Expected invocation count. */
  count: number;
}

export interface ToolInvokedInOrderAssertion {
  type: 'tool_invoked_in_order';
  /** Tools in expected invocation order. */
  tools: string[];
}

export interface NoErrorsAssertion {
  type: 'no_errors';
}

export interface ErrorCodeAssertion {
  type: 'error_code';
  /** Expected error code in at least one response. */
  code: ErrorCodeValue;
}

export interface ResponseContainsAssertion {
  type: 'response_contains';
  /** Tool whose response to check. */
  tool: string;
  /** Predicate that checks the response result. */
  predicate: (result: unknown) => boolean;
  /** Human-readable description of what the predicate checks. */
  label: string;
}

export interface ToolArgsMatchAssertion {
  type: 'tool_args_match';
  /** Tool name. */
  tool: string;
  /** Predicate that checks the arguments. */
  predicate: (args: Record<string, unknown>) => boolean;
  /** Human-readable description. */
  label: string;
}

export interface CustomAssertion {
  type: 'custom';
  /** Name for reporting. */
  name: string;
  /** Check function against the full recording. */
  check: (recording: ScenarioRecording) => boolean;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** A single tool invocation recorded during a scenario. */
export interface RecordedInvocation {
  /** Tool name. */
  tool: string;
  /** Arguments passed to the tool. */
  args: Record<string, unknown>;
  /** The full response envelope. */
  response: ResponseEnvelope;
  /** Duration of the invocation in milliseconds. */
  durationMs: number;
  /** Whether the invocation succeeded (no error in response). */
  success: boolean;
  /** Error code if the invocation failed. */
  errorCode?: ErrorCodeValue;
  /** Monotonic timestamp (ms since scenario start). */
  offsetMs: number;
}

/** Complete recording of a scenario run. */
export interface ScenarioRecording {
  /** All tool invocations in order. */
  invocations: RecordedInvocation[];
  /** All events published during the scenario. */
  events: EventEnvelope[];
  /** Notes added by the scenario. */
  notes: string[];
  /** Scenario start time (Date.now()). */
  startedAt: number;
  /** Scenario end time (Date.now()). */
  finishedAt: number;
  /** Total duration in ms. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Test results
// ---------------------------------------------------------------------------

/** Result of a single assertion check. */
export interface AssertionResult {
  /** The assertion that was checked. */
  assertion: SemanticAssertion;
  /** Whether the assertion passed. */
  passed: boolean;
  /** Human-readable description of the assertion. */
  description: string;
  /** Failure reason if not passed. */
  reason?: string;
}

/** Result of a single scenario run (one attempt). */
export interface ScenarioAttempt {
  /** Which attempt (1-based). */
  attempt: number;
  /** Whether the attempt passed. */
  passed: boolean;
  /** The recording from this attempt. */
  recording: ScenarioRecording;
  /** Individual assertion results. */
  assertionResults: AssertionResult[];
  /** Cost tracking for this attempt. */
  cost: CostMetrics;
  /** Error if the scenario threw. */
  error?: string;
}

/** Cost metrics for a scenario run. */
export interface CostMetrics {
  /** Number of tool invocations made. */
  toolInvocations: number;
  /** Total time spent in tool invocations (ms). */
  toolTimeMs: number;
  /** Number of events published. */
  eventsPublished: number;
  /** Estimated API cost (placeholder for future integration). */
  estimatedCostUsd: number;
}

/** Final result of a scenario (potentially with retries). */
export interface ScenarioResult {
  /** Scenario name. */
  name: string;
  /** Scenario description. */
  description: string;
  /** Scenario tags. */
  tags: string[];
  /** Whether the scenario ultimately passed. */
  passed: boolean;
  /** All attempts (first attempt + retries). */
  attempts: ScenarioAttempt[];
  /** Which attempt passed (0 if none). */
  passingAttempt: number;
  /** Total wall time across all attempts (ms). */
  totalDurationMs: number;
}

/** Aggregate report for a test suite run. */
export interface SuiteReport {
  /** All scenario results. */
  results: ScenarioResult[];
  /** Total scenarios run. */
  total: number;
  /** Number that passed. */
  passed: number;
  /** Number that failed. */
  failed: number;
  /** Pass rate as a percentage. */
  passRate: number;
  /** Total wall time (ms). */
  totalDurationMs: number;
  /** Aggregate cost metrics. */
  totalCost: CostMetrics;
  /** ISO 8601 timestamp. */
  timestamp: string;
}
