import { describe, it, expect } from 'vitest';
import {
  categorizeResult,
  checkBudget,
  computeTrend,
  checkAlert,
  type E2eTestResult,
  type E2eResultCategory,
  type BudgetConfig,
  type BudgetStatus,
  type TrendEntry,
  type TrendSummary,
  type AlertConfig,
  type AlertStatus,
} from './e2e-ci.js';

// ---------------------------------------------------------------------------
// categorizeResult
// ---------------------------------------------------------------------------

describe('categorizeResult', () => {
  it('returns PASS when test passed and output matches baseline', () => {
    const result = categorizeResult({
      testId: 'test-1',
      passed: true,
      matchesBaseline: true,
      tokensUsed: 100,
      durationMs: 5000,
    });
    expect(result).toBe('PASS');
  });

  it('returns DIFFERENT_PATH when test passed but output differs from baseline', () => {
    const result = categorizeResult({
      testId: 'test-1',
      passed: true,
      matchesBaseline: false,
      tokensUsed: 100,
      durationMs: 5000,
    });
    expect(result).toBe('DIFFERENT_PATH');
  });

  it('returns REGRESSION when test failed and previously passed', () => {
    const result = categorizeResult({
      testId: 'test-1',
      passed: false,
      matchesBaseline: false,
      tokensUsed: 100,
      durationMs: 5000,
      previouslyPassed: true,
    });
    expect(result).toBe('REGRESSION');
  });

  it('returns FLAKY when test failed but was not previously passing consistently', () => {
    const result = categorizeResult({
      testId: 'test-1',
      passed: false,
      matchesBaseline: false,
      tokensUsed: 100,
      durationMs: 5000,
      previouslyPassed: false,
    });
    expect(result).toBe('FLAKY');
  });

  it('returns BUDGET_EXCEEDED when tokens exceed per-test budget', () => {
    const result = categorizeResult({
      testId: 'test-1',
      passed: true,
      matchesBaseline: true,
      tokensUsed: 50000,
      durationMs: 5000,
      tokenBudget: 10000,
    });
    expect(result).toBe('BUDGET_EXCEEDED');
  });

  it('returns BUDGET_EXCEEDED when duration exceeds per-test timeout', () => {
    const result = categorizeResult({
      testId: 'test-1',
      passed: true,
      matchesBaseline: true,
      tokensUsed: 100,
      durationMs: 600000,
      timeoutMs: 300000,
    });
    expect(result).toBe('BUDGET_EXCEEDED');
  });

  it('BUDGET_EXCEEDED takes priority over PASS', () => {
    const result = categorizeResult({
      testId: 'test-1',
      passed: true,
      matchesBaseline: true,
      tokensUsed: 50000,
      durationMs: 5000,
      tokenBudget: 10000,
    });
    expect(result).toBe('BUDGET_EXCEEDED');
  });

  it('BUDGET_EXCEEDED takes priority over REGRESSION', () => {
    const result = categorizeResult({
      testId: 'test-1',
      passed: false,
      matchesBaseline: false,
      tokensUsed: 50000,
      durationMs: 5000,
      previouslyPassed: true,
      tokenBudget: 10000,
    });
    expect(result).toBe('BUDGET_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// checkBudget
// ---------------------------------------------------------------------------

describe('checkBudget', () => {
  const config: BudgetConfig = {
    maxTotalTokens: 100000,
    maxCostCents: 500,
    maxDurationMs: 3600000,
    costPerToken: 0.003,
  };

  it('returns within_budget when all limits are under', () => {
    const status = checkBudget(config, {
      totalTokens: 50000,
      totalDurationMs: 1800000,
    });
    expect(status.exceeded).toBe(false);
    expect(status.reason).toBeUndefined();
  });

  it('returns exceeded when total tokens exceed max', () => {
    const status = checkBudget(config, {
      totalTokens: 150000,
      totalDurationMs: 1800000,
    });
    expect(status.exceeded).toBe(true);
    expect(status.reason).toMatch(/token/i);
  });

  it('returns exceeded when cost exceeds max', () => {
    const status = checkBudget(config, {
      totalTokens: 200000,
      totalDurationMs: 1800000,
    });
    expect(status.exceeded).toBe(true);
  });

  it('returns exceeded when duration exceeds max', () => {
    const status = checkBudget(config, {
      totalTokens: 50000,
      totalDurationMs: 4000000,
    });
    expect(status.exceeded).toBe(true);
    expect(status.reason).toMatch(/duration|time/i);
  });

  it('includes estimated cost in status', () => {
    const status = checkBudget(config, {
      totalTokens: 50000,
      totalDurationMs: 1800000,
    });
    expect(status.estimatedCostCents).toBeDefined();
    expect(status.estimatedCostCents).toBeCloseTo(150, 0);
  });

  it('reports first exceeded limit', () => {
    const status = checkBudget(config, {
      totalTokens: 150000,
      totalDurationMs: 4000000,
    });
    expect(status.exceeded).toBe(true);
    expect(status.reason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// computeTrend
// ---------------------------------------------------------------------------

describe('computeTrend', () => {
  it('computes pass rate from trend entries', () => {
    const entries: TrendEntry[] = [
      {
        runId: 'r1',
        timestamp: '2026-02-01',
        totalTests: 10,
        passed: 8,
        categories: { PASS: 8, REGRESSION: 2, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r2',
        timestamp: '2026-02-02',
        totalTests: 10,
        passed: 9,
        categories: { PASS: 9, REGRESSION: 1, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
    ];
    const summary = computeTrend(entries);

    expect(summary.averagePassRate).toBeCloseTo(0.85, 2);
    expect(summary.latestPassRate).toBeCloseTo(0.9, 2);
  });

  it('returns 0 pass rate for empty entries', () => {
    const summary = computeTrend([]);

    expect(summary.averagePassRate).toBe(0);
    expect(summary.latestPassRate).toBe(0);
    expect(summary.totalRuns).toBe(0);
  });

  it('detects improving trend', () => {
    const entries: TrendEntry[] = [
      {
        runId: 'r1',
        timestamp: '2026-02-01',
        totalTests: 10,
        passed: 5,
        categories: { PASS: 5, REGRESSION: 5, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r2',
        timestamp: '2026-02-02',
        totalTests: 10,
        passed: 7,
        categories: { PASS: 7, REGRESSION: 3, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r3',
        timestamp: '2026-02-03',
        totalTests: 10,
        passed: 9,
        categories: { PASS: 9, REGRESSION: 1, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
    ];
    const summary = computeTrend(entries);

    expect(summary.direction).toBe('improving');
  });

  it('detects declining trend', () => {
    const entries: TrendEntry[] = [
      {
        runId: 'r1',
        timestamp: '2026-02-01',
        totalTests: 10,
        passed: 9,
        categories: { PASS: 9, REGRESSION: 1, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r2',
        timestamp: '2026-02-02',
        totalTests: 10,
        passed: 7,
        categories: { PASS: 7, REGRESSION: 3, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r3',
        timestamp: '2026-02-03',
        totalTests: 10,
        passed: 5,
        categories: { PASS: 5, REGRESSION: 5, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
    ];
    const summary = computeTrend(entries);

    expect(summary.direction).toBe('declining');
  });

  it('detects stable trend', () => {
    const entries: TrendEntry[] = [
      {
        runId: 'r1',
        timestamp: '2026-02-01',
        totalTests: 10,
        passed: 8,
        categories: { PASS: 8, REGRESSION: 2, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r2',
        timestamp: '2026-02-02',
        totalTests: 10,
        passed: 8,
        categories: { PASS: 8, REGRESSION: 2, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r3',
        timestamp: '2026-02-03',
        totalTests: 10,
        passed: 8,
        categories: { PASS: 8, REGRESSION: 2, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
    ];
    const summary = computeTrend(entries);

    expect(summary.direction).toBe('stable');
  });

  it('returns total run count', () => {
    const entries: TrendEntry[] = [
      {
        runId: 'r1',
        timestamp: '2026-02-01',
        totalTests: 10,
        passed: 8,
        categories: { PASS: 8, REGRESSION: 2, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r2',
        timestamp: '2026-02-02',
        totalTests: 10,
        passed: 9,
        categories: { PASS: 9, REGRESSION: 1, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
    ];
    const summary = computeTrend(entries);

    expect(summary.totalRuns).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// checkAlert
// ---------------------------------------------------------------------------

describe('checkAlert', () => {
  const config: AlertConfig = {
    passRateThreshold: 0.7,
    consecutiveFailedRuns: 3,
  };

  it('returns no alert when pass rate is above threshold', () => {
    const entries: TrendEntry[] = [
      {
        runId: 'r1',
        timestamp: '2026-02-01',
        totalTests: 10,
        passed: 8,
        categories: { PASS: 8, REGRESSION: 2, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r2',
        timestamp: '2026-02-02',
        totalTests: 10,
        passed: 9,
        categories: { PASS: 9, REGRESSION: 1, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r3',
        timestamp: '2026-02-03',
        totalTests: 10,
        passed: 8,
        categories: { PASS: 8, REGRESSION: 2, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
    ];
    const status = checkAlert(config, entries);

    expect(status.shouldAlert).toBe(false);
  });

  it('returns alert when pass rate below threshold for N consecutive runs', () => {
    const entries: TrendEntry[] = [
      {
        runId: 'r1',
        timestamp: '2026-02-01',
        totalTests: 10,
        passed: 5,
        categories: { PASS: 5, REGRESSION: 5, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r2',
        timestamp: '2026-02-02',
        totalTests: 10,
        passed: 4,
        categories: { PASS: 4, REGRESSION: 6, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r3',
        timestamp: '2026-02-03',
        totalTests: 10,
        passed: 6,
        categories: { PASS: 6, REGRESSION: 4, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
    ];
    const status = checkAlert(config, entries);

    expect(status.shouldAlert).toBe(true);
    expect(status.message).toMatch(/pass rate/i);
  });

  it('does not alert when fewer than N runs exist', () => {
    const entries: TrendEntry[] = [
      {
        runId: 'r1',
        timestamp: '2026-02-01',
        totalTests: 10,
        passed: 3,
        categories: { PASS: 3, REGRESSION: 7, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
    ];
    const status = checkAlert(config, entries);

    expect(status.shouldAlert).toBe(false);
  });

  it('does not alert when only some recent runs are below threshold', () => {
    const entries: TrendEntry[] = [
      {
        runId: 'r1',
        timestamp: '2026-02-01',
        totalTests: 10,
        passed: 9,
        categories: { PASS: 9, REGRESSION: 1, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r2',
        timestamp: '2026-02-02',
        totalTests: 10,
        passed: 5,
        categories: { PASS: 5, REGRESSION: 5, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r3',
        timestamp: '2026-02-03',
        totalTests: 10,
        passed: 5,
        categories: { PASS: 5, REGRESSION: 5, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
    ];
    // Only 2 of last 3 below threshold, need all 3
    const status = checkAlert(config, entries);

    expect(status.shouldAlert).toBe(false);
  });

  it('includes consecutive count in alert message', () => {
    const entries: TrendEntry[] = [
      {
        runId: 'r1',
        timestamp: '2026-02-01',
        totalTests: 10,
        passed: 5,
        categories: { PASS: 5, REGRESSION: 5, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r2',
        timestamp: '2026-02-02',
        totalTests: 10,
        passed: 4,
        categories: { PASS: 4, REGRESSION: 6, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r3',
        timestamp: '2026-02-03',
        totalTests: 10,
        passed: 3,
        categories: { PASS: 3, REGRESSION: 7, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
    ];
    const status = checkAlert(config, entries);

    expect(status.shouldAlert).toBe(true);
    expect(status.consecutiveFailedRuns).toBe(3);
  });

  it('handles entries with zero total tests', () => {
    const entries: TrendEntry[] = [
      {
        runId: 'r1',
        timestamp: '2026-02-01',
        totalTests: 0,
        passed: 0,
        categories: { PASS: 0, REGRESSION: 0, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r2',
        timestamp: '2026-02-02',
        totalTests: 0,
        passed: 0,
        categories: { PASS: 0, REGRESSION: 0, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
      {
        runId: 'r3',
        timestamp: '2026-02-03',
        totalTests: 0,
        passed: 0,
        categories: { PASS: 0, REGRESSION: 0, DIFFERENT_PATH: 0, FLAKY: 0, BUDGET_EXCEEDED: 0 },
      },
    ];
    const status = checkAlert(config, entries);

    expect(status.shouldAlert).toBe(true);
  });
});
