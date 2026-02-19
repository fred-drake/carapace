/**
 * Structured test result reporter for e2e tests (QA-08).
 *
 * Formats suite reports for CI output and human consumption.
 */

import type { SuiteReport, ScenarioResult, AssertionResult } from './types.js';

// ---------------------------------------------------------------------------
// Text report
// ---------------------------------------------------------------------------

/** Format a suite report as a human-readable text summary. */
export function formatTextReport(report: SuiteReport): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('  E2E Test Suite Report');
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  Timestamp: ${report.timestamp}`);
  lines.push(`  Duration:  ${report.totalDurationMs}ms`);
  lines.push(
    `  Results:   ${report.passed}/${report.total} passed (${report.passRate.toFixed(1)}%)`,
  );
  lines.push('');

  for (const result of report.results) {
    lines.push(formatScenarioResult(result));
  }

  lines.push('───────────────────────────────────────────────────────────');
  lines.push('  Cost Summary');
  lines.push('───────────────────────────────────────────────────────────');
  lines.push(`  Tool invocations: ${report.totalCost.toolInvocations}`);
  lines.push(`  Tool time:        ${report.totalCost.toolTimeMs}ms`);
  lines.push(`  Events published: ${report.totalCost.eventsPublished}`);
  lines.push(`  Estimated cost:   $${report.totalCost.estimatedCostUsd.toFixed(4)}`);
  lines.push('');

  return lines.join('\n');
}

function formatScenarioResult(result: ScenarioResult): string {
  const lines: string[] = [];
  const icon = result.passed ? '✓' : '✗';
  const retryNote = result.attempts.length > 1 ? ` (${result.attempts.length} attempts)` : '';

  lines.push(`  ${icon} ${result.name}${retryNote} [${result.totalDurationMs}ms]`);

  if (!result.passed) {
    const lastAttempt = result.attempts[result.attempts.length - 1]!;
    if (lastAttempt.error) {
      lines.push(`    Error: ${lastAttempt.error}`);
    }
    for (const ar of lastAttempt.assertionResults) {
      if (!ar.passed) {
        lines.push(`    FAIL: ${ar.description}`);
        if (ar.reason) {
          lines.push(`          ${ar.reason}`);
        }
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON report (CI-compatible)
// ---------------------------------------------------------------------------

/** Format a suite report as a CI-compatible JSON string. */
export function formatJsonReport(report: SuiteReport): string {
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// JUnit XML report (CI-compatible)
// ---------------------------------------------------------------------------

/** Format a suite report as JUnit XML for CI systems. */
export function formatJUnitReport(report: SuiteReport): string {
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuite name="e2e" tests="${report.total}" failures="${report.failed}" time="${(report.totalDurationMs / 1000).toFixed(3)}">`,
  );

  for (const result of report.results) {
    const time = (result.totalDurationMs / 1000).toFixed(3);
    if (result.passed) {
      lines.push(`  <testcase name="${escapeXml(result.name)}" time="${time}" />`);
    } else {
      lines.push(`  <testcase name="${escapeXml(result.name)}" time="${time}">`);
      const lastAttempt = result.attempts[result.attempts.length - 1]!;
      const failures = lastAttempt.assertionResults.filter((a) => !a.passed);
      for (const f of failures) {
        const msg = f.reason ?? f.description;
        lines.push(
          `    <failure message="${escapeXml(msg)}">${escapeXml(f.description)}</failure>`,
        );
      }
      if (lastAttempt.error) {
        lines.push(
          `    <error message="${escapeXml(lastAttempt.error)}">${escapeXml(lastAttempt.error)}</error>`,
        );
      }
      lines.push('  </testcase>');
    }
  }

  lines.push('</testsuite>');
  return lines.join('\n');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Assertion summary
// ---------------------------------------------------------------------------

/** Get a summary of assertion results from a scenario result. */
export function getAssertionSummary(result: ScenarioResult): {
  total: number;
  passed: number;
  failed: number;
  failures: AssertionResult[];
} {
  const lastAttempt = result.attempts[result.attempts.length - 1];
  if (!lastAttempt) {
    return { total: 0, passed: 0, failed: 0, failures: [] };
  }

  const total = lastAttempt.assertionResults.length;
  const passed = lastAttempt.assertionResults.filter((a) => a.passed).length;
  const failed = total - passed;
  const failures = lastAttempt.assertionResults.filter((a) => !a.passed);

  return { total, passed, failed, failures };
}
