/**
 * E2e test CI infrastructure for Carapace.
 *
 * Provides the core logic for nightly e2e test runs:
 * - {@link categorizeResult} — Classify individual test outcomes.
 * - {@link checkBudget} — Enforce token/cost/duration budget caps.
 * - {@link computeTrend} — Track pass rates across runs.
 * - {@link checkAlert} — Fire alerts on sustained pass-rate drops.
 *
 * These tests NEVER gate merges — they run on schedule and produce reports.
 *
 * DEVOPS-11
 */

// ---------------------------------------------------------------------------
// Result categories
// ---------------------------------------------------------------------------

/** Possible categorizations for an e2e test result. */
export type E2eResultCategory =
  | 'PASS'
  | 'DIFFERENT_PATH'
  | 'REGRESSION'
  | 'FLAKY'
  | 'BUDGET_EXCEEDED';

/** Input for categorizing a single e2e test result. */
export interface E2eTestResult {
  testId: string;
  passed: boolean;
  matchesBaseline: boolean;
  tokensUsed: number;
  durationMs: number;
  /** Whether this test passed consistently in recent runs. */
  previouslyPassed?: boolean;
  /** Per-test token budget (if set). */
  tokenBudget?: number;
  /** Per-test timeout in milliseconds (if set). */
  timeoutMs?: number;
}

/**
 * Categorize a single e2e test result.
 *
 * Priority: BUDGET_EXCEEDED > PASS/DIFFERENT_PATH/REGRESSION/FLAKY.
 * Budget checks take priority because runaway tests should always be flagged.
 */
export function categorizeResult(result: E2eTestResult): E2eResultCategory {
  // Budget exceeded takes priority
  if (result.tokenBudget !== undefined && result.tokensUsed > result.tokenBudget) {
    return 'BUDGET_EXCEEDED';
  }
  if (result.timeoutMs !== undefined && result.durationMs > result.timeoutMs) {
    return 'BUDGET_EXCEEDED';
  }

  // Test passed
  if (result.passed) {
    return result.matchesBaseline ? 'PASS' : 'DIFFERENT_PATH';
  }

  // Test failed
  return result.previouslyPassed ? 'REGRESSION' : 'FLAKY';
}

// ---------------------------------------------------------------------------
// Budget tracking
// ---------------------------------------------------------------------------

/** Budget configuration for an e2e test run. */
export interface BudgetConfig {
  /** Maximum total tokens across all tests in a run. */
  maxTotalTokens: number;
  /** Maximum total cost in cents. */
  maxCostCents: number;
  /** Maximum total wall-clock duration in milliseconds. */
  maxDurationMs: number;
  /** Cost per token in cents (for cost estimation). */
  costPerToken: number;
}

/** Current consumption for budget checking. */
export interface BudgetConsumption {
  totalTokens: number;
  totalDurationMs: number;
}

/** Result of a budget check. */
export interface BudgetStatus {
  exceeded: boolean;
  reason?: string;
  estimatedCostCents: number;
}

/**
 * Check whether a run's consumption exceeds budget limits.
 */
export function checkBudget(config: BudgetConfig, consumption: BudgetConsumption): BudgetStatus {
  const estimatedCostCents = consumption.totalTokens * config.costPerToken;

  if (consumption.totalTokens > config.maxTotalTokens) {
    return {
      exceeded: true,
      reason: `Token budget exceeded: ${consumption.totalTokens} / ${config.maxTotalTokens}`,
      estimatedCostCents,
    };
  }

  if (estimatedCostCents > config.maxCostCents) {
    return {
      exceeded: true,
      reason: `Cost budget exceeded: ${estimatedCostCents.toFixed(0)}¢ / ${config.maxCostCents}¢`,
      estimatedCostCents,
    };
  }

  if (consumption.totalDurationMs > config.maxDurationMs) {
    return {
      exceeded: true,
      reason: `Duration budget exceeded: ${Math.round(consumption.totalDurationMs / 1000)}s / ${Math.round(config.maxDurationMs / 1000)}s`,
      estimatedCostCents,
    };
  }

  return { exceeded: false, estimatedCostCents };
}

// ---------------------------------------------------------------------------
// Trend tracking
// ---------------------------------------------------------------------------

/** Category counts for a single run. */
export interface CategoryCounts {
  PASS: number;
  DIFFERENT_PATH: number;
  REGRESSION: number;
  FLAKY: number;
  BUDGET_EXCEEDED: number;
}

/** A single run's aggregated results for trend tracking. */
export interface TrendEntry {
  runId: string;
  timestamp: string;
  totalTests: number;
  passed: number;
  categories: CategoryCounts;
}

/** Summary of trend data across multiple runs. */
export interface TrendSummary {
  totalRuns: number;
  averagePassRate: number;
  latestPassRate: number;
  direction: 'improving' | 'declining' | 'stable';
}

/**
 * Compute trend summary from historical run entries.
 *
 * Direction is determined by comparing the first half and second half
 * average pass rates. A difference of less than 5% is considered stable.
 */
export function computeTrend(entries: TrendEntry[]): TrendSummary {
  if (entries.length === 0) {
    return { totalRuns: 0, averagePassRate: 0, latestPassRate: 0, direction: 'stable' };
  }

  const passRates = entries.map((e) => (e.totalTests > 0 ? e.passed / e.totalTests : 0));

  const averagePassRate = passRates.reduce((a, b) => a + b, 0) / passRates.length;
  const latestPassRate = passRates[passRates.length - 1]!;

  // Determine direction by comparing halves
  let direction: 'improving' | 'declining' | 'stable' = 'stable';
  if (entries.length >= 2) {
    const mid = Math.floor(passRates.length / 2);
    const firstHalf = passRates.slice(0, mid);
    const secondHalf = passRates.slice(mid);

    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    const diff = secondAvg - firstAvg;

    if (diff > 0.05) {
      direction = 'improving';
    } else if (diff < -0.05) {
      direction = 'declining';
    }
  }

  return {
    totalRuns: entries.length,
    averagePassRate,
    latestPassRate,
    direction,
  };
}

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

/** Configuration for pass-rate alerts. */
export interface AlertConfig {
  /** Minimum pass rate (0–1) before alerting. */
  passRateThreshold: number;
  /** Number of consecutive runs below threshold to trigger alert. */
  consecutiveFailedRuns: number;
}

/** Result of alert evaluation. */
export interface AlertStatus {
  shouldAlert: boolean;
  message?: string;
  consecutiveFailedRuns?: number;
}

/**
 * Check whether an alert should fire based on recent trend entries.
 *
 * Alerts when the last N consecutive runs all have pass rates below
 * the configured threshold.
 */
export function checkAlert(config: AlertConfig, entries: TrendEntry[]): AlertStatus {
  if (entries.length < config.consecutiveFailedRuns) {
    return { shouldAlert: false };
  }

  // Check the last N entries
  const recent = entries.slice(-config.consecutiveFailedRuns);
  let consecutiveBelow = 0;

  for (const entry of recent) {
    const passRate = entry.totalTests > 0 ? entry.passed / entry.totalTests : 0;
    if (passRate < config.passRateThreshold) {
      consecutiveBelow++;
    }
  }

  if (consecutiveBelow >= config.consecutiveFailedRuns) {
    const rates = recent.map((e) =>
      e.totalTests > 0 ? ((e.passed / e.totalTests) * 100).toFixed(0) : '0',
    );
    return {
      shouldAlert: true,
      message:
        `E2e pass rate below ${(config.passRateThreshold * 100).toFixed(0)}% ` +
        `for ${config.consecutiveFailedRuns} consecutive runs. ` +
        `Recent rates: ${rates.join('%, ')}%`,
      consecutiveFailedRuns: consecutiveBelow,
    };
  }

  return { shouldAlert: false };
}
