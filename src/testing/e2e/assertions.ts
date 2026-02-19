/**
 * Semantic assertion library for e2e tests (QA-08).
 *
 * Provides builder functions for creating semantic assertions and
 * an evaluator that checks assertions against a scenario recording.
 */

import type {
  SemanticAssertion,
  ScenarioRecording,
  AssertionResult,
  RecordedInvocation,
} from './types.js';
import type { ErrorCodeValue } from '../../types/errors.js';

// ---------------------------------------------------------------------------
// Assertion builders
// ---------------------------------------------------------------------------

/** Assert that a tool was invoked at least once. */
export function toolInvoked(tool: string): SemanticAssertion {
  return { type: 'tool_invoked', tool };
}

/** Assert that a tool was NOT invoked. */
export function toolNotInvoked(tool: string): SemanticAssertion {
  return { type: 'tool_not_invoked', tool };
}

/** Assert that a tool was invoked exactly N times. */
export function toolInvokedCount(tool: string, count: number): SemanticAssertion {
  return { type: 'tool_invoked_count', tool, count };
}

/** Assert that tools were invoked in the given order. */
export function toolInvokedInOrder(tools: string[]): SemanticAssertion {
  return { type: 'tool_invoked_in_order', tools };
}

/** Assert that no invocations returned error codes. */
export function noErrors(): SemanticAssertion {
  return { type: 'no_errors' };
}

/** Assert that at least one invocation returned a specific error code. */
export function errorCode(code: ErrorCodeValue): SemanticAssertion {
  return { type: 'error_code', code };
}

/** Assert that a tool's response result matches a predicate. */
export function responseContains(
  tool: string,
  predicate: (result: unknown) => boolean,
  label: string,
): SemanticAssertion {
  return { type: 'response_contains', tool, predicate, label };
}

/** Assert that a tool's invocation arguments match a predicate. */
export function toolArgsMatch(
  tool: string,
  predicate: (args: Record<string, unknown>) => boolean,
  label: string,
): SemanticAssertion {
  return { type: 'tool_args_match', tool, predicate, label };
}

/** Assert a custom condition against the full recording. */
export function custom(
  name: string,
  check: (recording: ScenarioRecording) => boolean,
): SemanticAssertion {
  return { type: 'custom', name, check };
}

// ---------------------------------------------------------------------------
// Assertion evaluation
// ---------------------------------------------------------------------------

/** Describe an assertion in human-readable form. */
export function describeAssertion(assertion: SemanticAssertion): string {
  switch (assertion.type) {
    case 'tool_invoked':
      return `Tool "${assertion.tool}" was invoked`;
    case 'tool_not_invoked':
      return `Tool "${assertion.tool}" was NOT invoked`;
    case 'tool_invoked_count':
      return `Tool "${assertion.tool}" was invoked exactly ${assertion.count} time(s)`;
    case 'tool_invoked_in_order':
      return `Tools invoked in order: ${assertion.tools.join(' → ')}`;
    case 'no_errors':
      return 'No error codes in any response';
    case 'error_code':
      return `At least one response has error code "${assertion.code}"`;
    case 'response_contains':
      return `Response from "${assertion.tool}": ${assertion.label}`;
    case 'tool_args_match':
      return `Arguments to "${assertion.tool}": ${assertion.label}`;
    case 'custom':
      return `Custom: ${assertion.name}`;
  }
}

/** Evaluate a single assertion against a scenario recording. */
export function evaluateAssertion(
  assertion: SemanticAssertion,
  recording: ScenarioRecording,
): AssertionResult {
  const description = describeAssertion(assertion);

  switch (assertion.type) {
    case 'tool_invoked':
      return evaluateToolInvoked(assertion.tool, recording, description);
    case 'tool_not_invoked':
      return evaluateToolNotInvoked(assertion.tool, recording, description);
    case 'tool_invoked_count':
      return evaluateToolInvokedCount(assertion.tool, assertion.count, recording, description);
    case 'tool_invoked_in_order':
      return evaluateToolInvokedInOrder(assertion.tools, recording, description);
    case 'no_errors':
      return evaluateNoErrors(recording, description);
    case 'error_code':
      return evaluateErrorCode(assertion.code, recording, description);
    case 'response_contains':
      return evaluateResponseContains(assertion.tool, assertion.predicate, recording, description);
    case 'tool_args_match':
      return evaluateToolArgsMatch(assertion.tool, assertion.predicate, recording, description);
    case 'custom':
      return evaluateCustom(assertion.check, recording, description);
  }
}

/** Evaluate all assertions and return results. */
export function evaluateAllAssertions(
  assertions: SemanticAssertion[],
  recording: ScenarioRecording,
): AssertionResult[] {
  return assertions.map((a) => evaluateAssertion(a, recording));
}

// ---------------------------------------------------------------------------
// Individual evaluators
// ---------------------------------------------------------------------------

function invocationsForTool(tool: string, recording: ScenarioRecording): RecordedInvocation[] {
  return recording.invocations.filter((i) => i.tool === tool);
}

function evaluateToolInvoked(
  tool: string,
  recording: ScenarioRecording,
  description: string,
): AssertionResult {
  const found = invocationsForTool(tool, recording);
  return {
    assertion: { type: 'tool_invoked', tool },
    passed: found.length > 0,
    description,
    reason: found.length === 0 ? `Tool "${tool}" was never invoked` : undefined,
  };
}

function evaluateToolNotInvoked(
  tool: string,
  recording: ScenarioRecording,
  description: string,
): AssertionResult {
  const found = invocationsForTool(tool, recording);
  return {
    assertion: { type: 'tool_not_invoked', tool },
    passed: found.length === 0,
    description,
    reason: found.length > 0 ? `Tool "${tool}" was invoked ${found.length} time(s)` : undefined,
  };
}

function evaluateToolInvokedCount(
  tool: string,
  count: number,
  recording: ScenarioRecording,
  description: string,
): AssertionResult {
  const found = invocationsForTool(tool, recording);
  return {
    assertion: { type: 'tool_invoked_count', tool, count },
    passed: found.length === count,
    description,
    reason:
      found.length !== count ? `Expected ${count} invocation(s), got ${found.length}` : undefined,
  };
}

function evaluateToolInvokedInOrder(
  tools: string[],
  recording: ScenarioRecording,
  description: string,
): AssertionResult {
  const invokedTools = recording.invocations.map((i) => i.tool);
  let toolIdx = 0;
  for (const invoked of invokedTools) {
    if (toolIdx < tools.length && invoked === tools[toolIdx]) {
      toolIdx++;
    }
  }

  const passed = toolIdx === tools.length;
  return {
    assertion: { type: 'tool_invoked_in_order', tools },
    passed,
    description,
    reason: !passed
      ? `Expected order [${tools.join(', ')}], actual invocations: [${invokedTools.join(', ')}]`
      : undefined,
  };
}

function evaluateNoErrors(recording: ScenarioRecording, description: string): AssertionResult {
  const errors = recording.invocations.filter((i) => !i.success);
  return {
    assertion: { type: 'no_errors' },
    passed: errors.length === 0,
    description,
    reason:
      errors.length > 0
        ? `${errors.length} invocation(s) had errors: ${errors.map((e) => `${e.tool}(${e.errorCode})`).join(', ')}`
        : undefined,
  };
}

function evaluateErrorCode(
  code: string,
  recording: ScenarioRecording,
  description: string,
): AssertionResult {
  const found = recording.invocations.some((i) => i.errorCode === code);
  return {
    assertion: { type: 'error_code', code: code as ErrorCodeValue },
    passed: found,
    description,
    reason: !found ? `No invocation returned error code "${code}"` : undefined,
  };
}

function evaluateResponseContains(
  tool: string,
  predicate: (result: unknown) => boolean,
  recording: ScenarioRecording,
  description: string,
): AssertionResult {
  const invocations = invocationsForTool(tool, recording);
  if (invocations.length === 0) {
    return {
      assertion: { type: 'response_contains', tool, predicate, label: '' },
      passed: false,
      description,
      reason: `Tool "${tool}" was never invoked`,
    };
  }

  // Only check successful invocations (error responses have null result)
  const successful = invocations.filter((i) => i.success);
  if (successful.length === 0) {
    return {
      assertion: { type: 'response_contains', tool, predicate, label: '' },
      passed: false,
      description,
      reason: `All invocations of "${tool}" returned errors`,
    };
  }

  const matched = successful.some((i) => {
    try {
      return predicate(i.response.payload.result);
    } catch {
      return false;
    }
  });
  return {
    assertion: { type: 'response_contains', tool, predicate, label: '' },
    passed: matched,
    description,
    reason: !matched ? `No successful response from "${tool}" matched the predicate` : undefined,
  };
}

function evaluateToolArgsMatch(
  tool: string,
  predicate: (args: Record<string, unknown>) => boolean,
  recording: ScenarioRecording,
  description: string,
): AssertionResult {
  const invocations = invocationsForTool(tool, recording);
  if (invocations.length === 0) {
    return {
      assertion: { type: 'tool_args_match', tool, predicate, label: '' },
      passed: false,
      description,
      reason: `Tool "${tool}" was never invoked`,
    };
  }

  const matched = invocations.some((i) => predicate(i.args));
  return {
    assertion: { type: 'tool_args_match', tool, predicate, label: '' },
    passed: matched,
    description,
    reason: !matched ? `No invocation of "${tool}" matched the argument predicate` : undefined,
  };
}

function evaluateCustom(
  check: (recording: ScenarioRecording) => boolean,
  recording: ScenarioRecording,
  description: string,
): AssertionResult {
  const passed = check(recording);
  return {
    assertion: { type: 'custom', name: description, check },
    passed,
    description,
    reason: !passed ? 'Custom assertion failed' : undefined,
  };
}
