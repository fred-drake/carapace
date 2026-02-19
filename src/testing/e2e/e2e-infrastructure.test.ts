/**
 * Unit tests for the e2e test infrastructure (QA-08).
 *
 * Tests the assertion library, scenario runner, mock plugins,
 * and result reporter independently.
 */

import { describe, it, expect } from 'vitest';
import { ErrorCode } from '../../types/errors.js';
import {
  toolInvoked,
  toolNotInvoked,
  toolInvokedCount,
  toolInvokedInOrder,
  noErrors,
  errorCode,
  responseContains,
  toolArgsMatch,
  custom,
  describeAssertion,
  evaluateAssertion,
  evaluateAllAssertions,
} from './assertions.js';
import { runScenario } from './scenario-runner.js';
import { echoTool, calculatorTool, failingTool, registerMockPlugin } from './mock-plugins.js';
import { formatTextReport, formatJUnitReport, getAssertionSummary } from './result-reporter.js';
import type { ScenarioRecording, RecordedInvocation, E2EScenario } from './types.js';
import { createResponseEnvelope } from '../factories.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecording(invocations: Partial<RecordedInvocation>[]): ScenarioRecording {
  return {
    invocations: invocations.map((i) => ({
      tool: i.tool ?? 'test_tool',
      args: i.args ?? {},
      response: i.response ?? createResponseEnvelope(),
      durationMs: i.durationMs ?? 1,
      success: i.success ?? true,
      errorCode: i.errorCode,
      offsetMs: i.offsetMs ?? 0,
    })),
    events: [],
    notes: [],
    startedAt: Date.now(),
    finishedAt: Date.now(),
    durationMs: 0,
  };
}

// ---------------------------------------------------------------------------
// Assertion library tests
// ---------------------------------------------------------------------------

describe('assertion library', () => {
  describe('toolInvoked', () => {
    it('passes when tool was invoked', () => {
      const recording = makeRecording([{ tool: 'echo' }]);
      const result = evaluateAssertion(toolInvoked('echo'), recording);
      expect(result.passed).toBe(true);
    });

    it('fails when tool was not invoked', () => {
      const recording = makeRecording([{ tool: 'other' }]);
      const result = evaluateAssertion(toolInvoked('echo'), recording);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('never invoked');
    });
  });

  describe('toolNotInvoked', () => {
    it('passes when tool was not invoked', () => {
      const recording = makeRecording([{ tool: 'other' }]);
      const result = evaluateAssertion(toolNotInvoked('echo'), recording);
      expect(result.passed).toBe(true);
    });

    it('fails when tool was invoked', () => {
      const recording = makeRecording([{ tool: 'echo' }]);
      const result = evaluateAssertion(toolNotInvoked('echo'), recording);
      expect(result.passed).toBe(false);
    });
  });

  describe('toolInvokedCount', () => {
    it('passes with exact count', () => {
      const recording = makeRecording([{ tool: 'echo' }, { tool: 'echo' }]);
      const result = evaluateAssertion(toolInvokedCount('echo', 2), recording);
      expect(result.passed).toBe(true);
    });

    it('fails with wrong count', () => {
      const recording = makeRecording([{ tool: 'echo' }]);
      const result = evaluateAssertion(toolInvokedCount('echo', 2), recording);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Expected 2');
    });
  });

  describe('toolInvokedInOrder', () => {
    it('passes when tools are in order', () => {
      const recording = makeRecording([{ tool: 'read' }, { tool: 'process' }, { tool: 'write' }]);
      const result = evaluateAssertion(toolInvokedInOrder(['read', 'process', 'write']), recording);
      expect(result.passed).toBe(true);
    });

    it('passes with extra tools interspersed', () => {
      const recording = makeRecording([{ tool: 'read' }, { tool: 'log' }, { tool: 'write' }]);
      const result = evaluateAssertion(toolInvokedInOrder(['read', 'write']), recording);
      expect(result.passed).toBe(true);
    });

    it('fails when order is wrong', () => {
      const recording = makeRecording([{ tool: 'write' }, { tool: 'read' }]);
      const result = evaluateAssertion(toolInvokedInOrder(['read', 'write']), recording);
      expect(result.passed).toBe(false);
    });
  });

  describe('noErrors', () => {
    it('passes when all invocations succeed', () => {
      const recording = makeRecording([
        { tool: 'a', success: true },
        { tool: 'b', success: true },
      ]);
      const result = evaluateAssertion(noErrors(), recording);
      expect(result.passed).toBe(true);
    });

    it('fails when any invocation has error', () => {
      const recording = makeRecording([
        { tool: 'a', success: true },
        { tool: 'b', success: false, errorCode: ErrorCode.PLUGIN_ERROR },
      ]);
      const result = evaluateAssertion(noErrors(), recording);
      expect(result.passed).toBe(false);
    });
  });

  describe('errorCode', () => {
    it('passes when error code is present', () => {
      const recording = makeRecording([
        { tool: 'a', success: false, errorCode: ErrorCode.RATE_LIMITED },
      ]);
      const result = evaluateAssertion(errorCode(ErrorCode.RATE_LIMITED), recording);
      expect(result.passed).toBe(true);
    });

    it('fails when error code is not present', () => {
      const recording = makeRecording([{ tool: 'a', success: true }]);
      const result = evaluateAssertion(errorCode(ErrorCode.RATE_LIMITED), recording);
      expect(result.passed).toBe(false);
    });
  });

  describe('responseContains', () => {
    it('passes when predicate matches', () => {
      const resp = createResponseEnvelope({
        payload: { result: { value: 42 }, error: null },
      });
      const recording = makeRecording([{ tool: 'calc', response: resp }]);
      const result = evaluateAssertion(
        responseContains(
          'calc',
          (r) => (r as Record<string, unknown>)['value'] === 42,
          'has value 42',
        ),
        recording,
      );
      expect(result.passed).toBe(true);
    });

    it('fails when tool not invoked', () => {
      const recording = makeRecording([]);
      const result = evaluateAssertion(
        responseContains('calc', () => true, 'always true'),
        recording,
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('never invoked');
    });
  });

  describe('toolArgsMatch', () => {
    it('passes when args match', () => {
      const recording = makeRecording([{ tool: 'send', args: { to: 'alice@example.com' } }]);
      const result = evaluateAssertion(
        toolArgsMatch('send', (args) => args['to'] === 'alice@example.com', 'sent to alice'),
        recording,
      );
      expect(result.passed).toBe(true);
    });
  });

  describe('custom', () => {
    it('passes when check returns true', () => {
      const recording = makeRecording([{ tool: 'a' }]);
      const result = evaluateAssertion(
        custom('has invocations', (r) => r.invocations.length > 0),
        recording,
      );
      expect(result.passed).toBe(true);
    });
  });

  describe('describeAssertion', () => {
    it('describes tool_invoked', () => {
      expect(describeAssertion(toolInvoked('echo'))).toBe('Tool "echo" was invoked');
    });

    it('describes no_errors', () => {
      expect(describeAssertion(noErrors())).toBe('No error codes in any response');
    });

    it('describes tool_invoked_in_order', () => {
      expect(describeAssertion(toolInvokedInOrder(['a', 'b']))).toBe(
        'Tools invoked in order: a → b',
      );
    });
  });

  describe('evaluateAllAssertions', () => {
    it('evaluates multiple assertions', () => {
      const recording = makeRecording([{ tool: 'echo', success: true }]);
      const results = evaluateAllAssertions(
        [toolInvoked('echo'), noErrors(), toolInvokedCount('echo', 1)],
        recording,
      );
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.passed)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario runner tests
// ---------------------------------------------------------------------------

describe('scenario runner', () => {
  it('runs a passing scenario', async () => {
    const scenario: E2EScenario = {
      name: 'test-pass',
      description: 'A test that passes',
      setup: (harness) => {
        registerMockPlugin(harness, echoTool);
      },
      steps: async (ctx) => {
        await ctx.invoke('echo', { text: 'hello' });
      },
      assertions: [toolInvoked('echo'), noErrors()],
    };

    const result = await runScenario(scenario);
    expect(result.passed).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.cost.toolInvocations).toBe(1);
  });

  it('runs a failing scenario', async () => {
    const scenario: E2EScenario = {
      name: 'test-fail',
      description: 'A test that fails assertions',
      setup: (harness) => {
        registerMockPlugin(harness, echoTool);
      },
      steps: async (ctx) => {
        await ctx.invoke('echo', { text: 'hello' });
      },
      assertions: [toolInvokedCount('echo', 5)], // wrong count
    };

    const result = await runScenario(scenario);
    expect(result.passed).toBe(false);
  });

  it('retries a scenario', async () => {
    let callCount = 0;
    const scenario: E2EScenario = {
      name: 'test-retry',
      description: 'Passes on second attempt',
      retries: 2,
      setup: (harness) => {
        registerMockPlugin(harness, echoTool);
      },
      steps: async (ctx) => {
        callCount++;
        await ctx.invoke('echo', { text: 'hello' });
      },
      assertions: [custom('passes on attempt 2+', () => callCount >= 2)],
    };

    const result = await runScenario(scenario);
    expect(result.passed).toBe(true);
    expect(result.attempts.length).toBeGreaterThanOrEqual(2);
    expect(result.passingAttempt).toBe(2);
  });

  it('handles scenario that throws', async () => {
    const scenario: E2EScenario = {
      name: 'test-throw',
      description: 'Scenario throws an error',
      setup: () => {},
      steps: async () => {
        throw new Error('Unexpected crash');
      },
      assertions: [],
    };

    const result = await runScenario(scenario);
    expect(result.passed).toBe(false);
    expect(result.attempts[0]!.error).toBe('Unexpected crash');
  });

  it('records notes', async () => {
    const scenario: E2EScenario = {
      name: 'test-notes',
      description: 'Records notes',
      setup: (harness) => {
        registerMockPlugin(harness, echoTool);
      },
      steps: async (ctx) => {
        ctx.note('step 1');
        await ctx.invoke('echo', { text: 'hi' });
        ctx.note('step 2');
      },
      assertions: [noErrors()],
    };

    const result = await runScenario(scenario);
    expect(result.passed).toBe(true);
    expect(result.attempts[0]!.recording.notes).toEqual(['step 1', 'step 2']);
  });

  it('tracks cost metrics', async () => {
    const scenario: E2EScenario = {
      name: 'test-cost',
      description: 'Tracks cost',
      setup: (harness) => {
        registerMockPlugin(harness, echoTool);
        registerMockPlugin(harness, calculatorTool);
      },
      steps: async (ctx) => {
        await ctx.invoke('echo', { text: 'a' });
        await ctx.invoke('echo', { text: 'b' });
        await ctx.invoke('calculator', { operation: 'add', a: 1, b: 2 });
      },
      assertions: [noErrors()],
    };

    const result = await runScenario(scenario);
    expect(result.attempts[0]!.cost.toolInvocations).toBe(3);
    expect(result.attempts[0]!.cost.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('records invocation durations', async () => {
    const scenario: E2EScenario = {
      name: 'test-duration',
      description: 'Records invocation timing',
      setup: (harness) => {
        registerMockPlugin(harness, echoTool);
      },
      steps: async (ctx) => {
        await ctx.invoke('echo', { text: 'hello' });
      },
      assertions: [noErrors()],
    };

    const result = await runScenario(scenario);
    const inv = result.attempts[0]!.recording.invocations[0]!;
    expect(inv.durationMs).toBeGreaterThanOrEqual(0);
    expect(inv.offsetMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Mock plugins tests
// ---------------------------------------------------------------------------

describe('mock plugins', () => {
  it('echo tool returns input text', async () => {
    const { IntegrationHarness } = await import('../integration-harness.js');
    const harness = await IntegrationHarness.create();
    registerMockPlugin(harness, echoTool);
    const session = harness.createSession({ group: 'test' });
    const resp = await harness.sendRequest(session, 'echo', { text: 'test' });
    expect((resp.payload.result as Record<string, unknown>)['echoed']).toBe('test');
    await harness.close();
  });

  it('calculator performs arithmetic', async () => {
    const { IntegrationHarness } = await import('../integration-harness.js');
    const harness = await IntegrationHarness.create();
    registerMockPlugin(harness, calculatorTool);
    const session = harness.createSession({ group: 'test' });
    const resp = await harness.sendRequest(session, 'calculator', {
      operation: 'multiply',
      a: 6,
      b: 7,
    });
    expect((resp.payload.result as Record<string, unknown>)['result']).toBe(42);
    await harness.close();
  });

  it('failing tool returns PLUGIN_ERROR', async () => {
    const { IntegrationHarness } = await import('../integration-harness.js');
    const harness = await IntegrationHarness.create();
    registerMockPlugin(harness, failingTool);
    const session = harness.createSession({ group: 'test' });
    const resp = await harness.sendRequest(session, 'unstable_service', { action: 'test' });
    expect(resp.payload.error).not.toBeNull();
    expect(resp.payload.error!.code).toBe(ErrorCode.PLUGIN_ERROR);
    await harness.close();
  });
});

// ---------------------------------------------------------------------------
// Result reporter tests
// ---------------------------------------------------------------------------

describe('result reporter', () => {
  it('formatTextReport produces readable output', async () => {
    const scenario: E2EScenario = {
      name: 'reporter-test',
      description: 'Test reporter',
      setup: (harness) => {
        registerMockPlugin(harness, echoTool);
      },
      steps: async (ctx) => {
        await ctx.invoke('echo', { text: 'hello' });
      },
      assertions: [toolInvoked('echo')],
    };

    const result = await runScenario(scenario);
    const report = {
      results: [result],
      total: 1,
      passed: result.passed ? 1 : 0,
      failed: result.passed ? 0 : 1,
      passRate: result.passed ? 100 : 0,
      totalDurationMs: result.totalDurationMs,
      totalCost: result.attempts[0]!.cost,
      timestamp: new Date().toISOString(),
    };

    const text = formatTextReport(report);
    expect(text).toContain('E2E Test Suite Report');
    expect(text).toContain('reporter-test');
    expect(text).toContain('1/1 passed');
  });

  it('formatJUnitReport produces valid XML', async () => {
    const scenario: E2EScenario = {
      name: 'junit-test',
      description: 'Test JUnit output',
      setup: (harness) => {
        registerMockPlugin(harness, echoTool);
      },
      steps: async (ctx) => {
        await ctx.invoke('echo', { text: 'hello' });
      },
      assertions: [toolInvoked('echo')],
    };

    const result = await runScenario(scenario);
    const report = {
      results: [result],
      total: 1,
      passed: 1,
      failed: 0,
      passRate: 100,
      totalDurationMs: result.totalDurationMs,
      totalCost: result.attempts[0]!.cost,
      timestamp: new Date().toISOString(),
    };

    const xml = formatJUnitReport(report);
    expect(xml).toContain('<?xml version');
    expect(xml).toContain('<testsuite');
    expect(xml).toContain('junit-test');
  });

  it('getAssertionSummary returns correct counts', () => {
    const result = {
      name: 'test',
      description: 'test',
      tags: [],
      passed: false,
      attempts: [
        {
          attempt: 1,
          passed: false,
          recording: makeRecording([]),
          assertionResults: [
            { assertion: toolInvoked('a'), passed: true, description: 'a invoked' },
            {
              assertion: toolInvoked('b'),
              passed: false,
              description: 'b invoked',
              reason: 'not invoked',
            },
            { assertion: noErrors(), passed: true, description: 'no errors' },
          ],
          cost: { toolInvocations: 0, toolTimeMs: 0, eventsPublished: 0, estimatedCostUsd: 0 },
        },
      ],
      passingAttempt: 0,
      totalDurationMs: 10,
    };

    const summary = getAssertionSummary(result);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failures).toHaveLength(1);
  });
});
