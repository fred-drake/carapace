/**
 * Tests for the e2e nightly workflow (DEVOPS-11).
 *
 * Validates that:
 *   1. The workflow file exists and is valid YAML
 *   2. Triggers on schedule (nightly cron) and manual dispatch
 *   3. Has budget configuration via environment variables
 *   4. Results are uploaded as artifacts
 *   5. Trend analysis and alerting jobs exist
 *   6. Alert creates a GitHub issue when threshold breached
 *   7. Never gates merges (no PR trigger)
 *   8. Actions pinned to commit SHA
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/e2e-nightly.yml');

function loadWorkflow(): Record<string, unknown> {
  const content = readFileSync(WORKFLOW_PATH, 'utf-8');
  return parseYaml(content) as Record<string, unknown>;
}

function getJobs(workflow: Record<string, unknown>): Record<string, unknown> {
  return workflow.jobs as Record<string, unknown>;
}

function getWorkflowContent(): string {
  return readFileSync(WORKFLOW_PATH, 'utf-8');
}

// ---------------------------------------------------------------------------
// Workflow file structure
// ---------------------------------------------------------------------------

describe('e2e nightly workflow file', () => {
  it('exists at .github/workflows/e2e-nightly.yml', () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
  });

  it('is valid YAML', () => {
    const content = readFileSync(WORKFLOW_PATH, 'utf-8');
    expect(() => parseYaml(content)).not.toThrow();
  });

  it('has a descriptive name', () => {
    const workflow = loadWorkflow();
    expect(String(workflow.name).toLowerCase()).toMatch(/e2e|nightly/);
  });
});

// ---------------------------------------------------------------------------
// Trigger configuration
// ---------------------------------------------------------------------------

describe('e2e trigger', () => {
  it('triggers on schedule (cron)', () => {
    const workflow = loadWorkflow();
    const on = workflow.on as Record<string, unknown>;
    expect(on.schedule).toBeDefined();
    const schedule = on.schedule as Array<Record<string, string>>;
    expect(schedule.length).toBeGreaterThan(0);
    expect(schedule[0]!.cron).toBeDefined();
  });

  it('supports manual dispatch', () => {
    const workflow = loadWorkflow();
    const on = workflow.on as Record<string, unknown>;
    expect(on.workflow_dispatch).toBeDefined();
  });

  it('does NOT trigger on pull_request (never gates merges)', () => {
    const workflow = loadWorkflow();
    const on = workflow.on as Record<string, unknown>;
    expect(on.pull_request).toBeUndefined();
  });

  it('does NOT trigger on push', () => {
    const workflow = loadWorkflow();
    const on = workflow.on as Record<string, unknown>;
    expect(on.push).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Budget configuration
// ---------------------------------------------------------------------------

describe('budget configuration', () => {
  it('has MAX_TOKENS environment variable', () => {
    const content = getWorkflowContent();
    expect(content).toContain('MAX_TOKENS');
  });

  it('has MAX_COST_CENTS environment variable', () => {
    const content = getWorkflowContent();
    expect(content).toContain('MAX_COST_CENTS');
  });

  it('has MAX_DURATION_SECONDS environment variable', () => {
    const content = getWorkflowContent();
    expect(content).toContain('MAX_DURATION_SECONDS');
  });

  it('allows budget override via workflow_dispatch input', () => {
    const workflow = loadWorkflow();
    const on = workflow.on as Record<string, unknown>;
    const dispatch = on.workflow_dispatch as Record<string, unknown>;
    const inputs = dispatch.inputs as Record<string, unknown>;
    expect(inputs.budget_tokens).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Job structure
// ---------------------------------------------------------------------------

describe('job structure', () => {
  it('has e2e-tests job', () => {
    const jobs = getJobs(loadWorkflow());
    expect(jobs['e2e-tests']).toBeDefined();
  });

  it('has analyze job', () => {
    const jobs = getJobs(loadWorkflow());
    expect(jobs.analyze).toBeDefined();
  });

  it('has alert job', () => {
    const jobs = getJobs(loadWorkflow());
    expect(jobs.alert).toBeDefined();
  });

  it('analyze depends on e2e-tests', () => {
    const jobs = getJobs(loadWorkflow());
    const analyze = jobs.analyze as Record<string, unknown>;
    const needs = analyze.needs as string[];
    expect(needs).toContain('e2e-tests');
  });

  it('alert depends on analyze', () => {
    const jobs = getJobs(loadWorkflow());
    const alert = jobs.alert as Record<string, unknown>;
    const needs = alert.needs as string[];
    expect(needs).toContain('analyze');
  });
});

// ---------------------------------------------------------------------------
// Artifacts and results
// ---------------------------------------------------------------------------

describe('artifacts', () => {
  it('uploads e2e results as artifacts', () => {
    const content = getWorkflowContent();
    expect(content).toContain('e2e-results');
  });

  it('uploads report as artifacts', () => {
    const content = getWorkflowContent();
    expect(content).toContain('e2e-report');
  });

  it('sets retention days on artifacts', () => {
    const content = getWorkflowContent();
    expect(content).toContain('retention-days');
  });
});

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

describe('alerting', () => {
  it('has alert threshold configuration', () => {
    const content = getWorkflowContent();
    expect(content).toContain('ALERT_PASS_RATE_THRESHOLD');
  });

  it('has consecutive runs configuration', () => {
    const content = getWorkflowContent();
    expect(content).toContain('ALERT_CONSECUTIVE_RUNS');
  });

  it('creates GitHub issue on alert', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/gh issue create/);
  });

  it('labels alert issues for filtering', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/e2e-alert/);
  });
});

// ---------------------------------------------------------------------------
// Action SHA pinning
// ---------------------------------------------------------------------------

describe('action SHA pinning', () => {
  it('all uses: directives reference a commit SHA', () => {
    const content = getWorkflowContent();
    const usesLines = content
      .split('\n')
      .filter((line) => line.trim().startsWith('- uses:') || line.trim().startsWith('uses:'))
      .map((line) => line.trim());

    expect(usesLines.length).toBeGreaterThan(0);

    for (const line of usesLines) {
      const match = line.match(/uses:\s*(.+)/);
      if (!match) continue;
      const ref = match[1].trim();
      expect(ref).toMatch(/@[0-9a-f]{40}/);
    }
  });
});
