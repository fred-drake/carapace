/**
 * Tests for custom Semgrep SAST rules (SEC-14).
 *
 * Validates that:
 *   1. The rules file exists and is valid YAML
 *   2. All 6 required rule categories are present
 *   3. Each rule has required metadata (id, severity, message, CWE)
 *   4. Rule IDs follow the carapace.* naming convention
 *   5. Rules target the correct file paths
 *   6. CI workflow includes the Semgrep SAST job
 *
 * These tests do NOT require the semgrep binary — they validate the
 * rule definitions structurally. Semgrep execution happens in CI via
 * the returntocorp/semgrep-action GitHub Action.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '../..');
const RULES_PATH = resolve(ROOT, '.semgrep/carapace-rules.yml');
const CI_PATH = resolve(ROOT, '.github/workflows/ci.yml');

interface SemgrepRule {
  id: string;
  languages: string[];
  severity: string;
  message: string;
  metadata?: {
    category?: string;
    confidence?: string;
    impact?: string;
    cwe?: string;
    references?: string[];
  };
  paths?: {
    include?: string[];
    exclude?: string[];
  };
  pattern?: string;
  patterns?: unknown[];
  'pattern-either'?: unknown[];
  'pattern-not'?: string;
}

interface RulesFile {
  rules: SemgrepRule[];
}

function loadRules(): RulesFile {
  const content = readFileSync(RULES_PATH, 'utf-8');
  return parseYaml(content) as RulesFile;
}

// ---------------------------------------------------------------------------
// Rule file structure
// ---------------------------------------------------------------------------

describe('Semgrep rules file', () => {
  it('exists at .semgrep/carapace-rules.yml', () => {
    expect(existsSync(RULES_PATH)).toBe(true);
  });

  it('is valid YAML', () => {
    const content = readFileSync(RULES_PATH, 'utf-8');
    expect(() => parseYaml(content)).not.toThrow();
  });

  it('has a top-level rules array', () => {
    const file = loadRules();
    expect(Array.isArray(file.rules)).toBe(true);
    expect(file.rules.length).toBeGreaterThan(0);
  });

  it('has at least 6 rules', () => {
    const file = loadRules();
    expect(file.rules.length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Rule naming and structure
// ---------------------------------------------------------------------------

describe('Semgrep rule structure', () => {
  let rules: SemgrepRule[];

  rules = loadRules().rules;

  it('all rules use carapace.* ID prefix', () => {
    for (const rule of rules) {
      expect(rule.id).toMatch(/^carapace\./);
    }
  });

  it('all rules target TypeScript', () => {
    for (const rule of rules) {
      expect(rule.languages).toContain('typescript');
    }
  });

  it('all rules have ERROR severity', () => {
    for (const rule of rules) {
      expect(rule.severity).toBe('ERROR');
    }
  });

  it('all rules have a non-empty message', () => {
    for (const rule of rules) {
      expect(rule.message).toBeDefined();
      expect(rule.message.length).toBeGreaterThan(20);
    }
  });

  it('all rules include nosemgrep suppression instructions', () => {
    for (const rule of rules) {
      expect(rule.message).toContain('nosemgrep');
    }
  });

  it('all rules have metadata with CWE', () => {
    for (const rule of rules) {
      expect(rule.metadata).toBeDefined();
      expect(rule.metadata!.cwe).toBeDefined();
      expect(rule.metadata!.cwe).toMatch(/^CWE-\d+/);
    }
  });

  it('all rules have metadata with impact', () => {
    for (const rule of rules) {
      expect(rule.metadata!.impact).toBeDefined();
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(rule.metadata!.impact);
    }
  });

  it('all rules have at least one pattern', () => {
    for (const rule of rules) {
      const hasPattern =
        rule.pattern !== undefined ||
        rule.patterns !== undefined ||
        rule['pattern-either'] !== undefined;
      expect(hasPattern).toBe(true);
    }
  });

  it('all rules have path restrictions', () => {
    for (const rule of rules) {
      expect(rule.paths).toBeDefined();
      expect(rule.paths!.include).toBeDefined();
      expect(rule.paths!.include!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Required rule categories (per SEC-14 spec)
// ---------------------------------------------------------------------------

describe('required rule categories', () => {
  let ruleIds: string[];

  ruleIds = loadRules().rules.map((r) => r.id);

  it('has no-identity-in-wire-format rule', () => {
    expect(ruleIds).toContain('carapace.no-identity-in-wire-format');
  });

  it('has require-additional-properties-false rule', () => {
    expect(ruleIds).toContain('carapace.require-additional-properties-false');
  });

  it('has parameterized-sqlite-queries rules', () => {
    const sqlRules = ruleIds.filter((id) => id.includes('parameterized-sqlite'));
    expect(sqlRules.length).toBeGreaterThanOrEqual(1);
  });

  it('has no-error-message-passthrough rule', () => {
    expect(ruleIds).toContain('carapace.no-error-message-passthrough');
  });

  it('has no-credentials-in-responses rules', () => {
    const credRules = ruleIds.filter((id) => id.includes('credentials'));
    expect(credRules.length).toBeGreaterThanOrEqual(1);
  });

  it('has group-isolation rule', () => {
    const groupRules = ruleIds.filter((id) => id.includes('group-isolation'));
    expect(groupRules.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Rule-specific path targeting
// ---------------------------------------------------------------------------

describe('rule path targeting', () => {
  let rules: SemgrepRule[];

  rules = loadRules().rules;

  function findRule(id: string): SemgrepRule {
    const rule = rules.find((r) => r.id === id);
    if (!rule) throw new Error(`Rule ${id} not found`);
    return rule;
  }

  it('wire format rule targets pipeline directory', () => {
    const rule = findRule('carapace.no-identity-in-wire-format');
    expect(rule.paths!.include).toContain('src/core/pipeline/');
  });

  it('schema rule targets manifest-schema.ts', () => {
    const rule = findRule('carapace.require-additional-properties-false');
    expect(rule.paths!.include).toContain('src/types/manifest-schema.ts');
  });

  it('SQL injection rules target plugins and core', () => {
    const rule = findRule('carapace.parameterized-sqlite-queries-template');
    expect(rule.paths!.include).toContain('src/plugins/');
    expect(rule.paths!.include).toContain('src/core/');
  });

  it('error passthrough rule targets plugins and core', () => {
    const rule = findRule('carapace.no-error-message-passthrough');
    expect(rule.paths!.include).toContain('src/plugins/');
    expect(rule.paths!.include).toContain('src/core/');
  });

  it('credentials rule targets plugins and core', () => {
    const rule = findRule('carapace.no-credentials-in-responses');
    expect(rule.paths!.include).toContain('src/plugins/');
    expect(rule.paths!.include).toContain('src/core/');
  });

  it('group isolation rule targets plugins, excludes sqlite-manager', () => {
    const rule = findRule('carapace.group-isolation-db-path');
    expect(rule.paths!.include).toContain('src/plugins/');
    expect(rule.paths!.exclude).toContain('src/core/sqlite-manager.ts');
  });
});

// ---------------------------------------------------------------------------
// Security metadata coverage
// ---------------------------------------------------------------------------

describe('security metadata coverage', () => {
  let rules: SemgrepRule[];

  rules = loadRules().rules;

  it('covers CWE-89 (SQL Injection)', () => {
    const has89 = rules.some((r) => r.metadata?.cwe?.includes('CWE-89'));
    expect(has89).toBe(true);
  });

  it('covers CWE-200 (Information Exposure)', () => {
    const has200 = rules.some((r) => r.metadata?.cwe?.includes('CWE-200'));
    expect(has200).toBe(true);
  });

  it('covers CWE-209 (Error Message Information Leak)', () => {
    const has209 = rules.some((r) => r.metadata?.cwe?.includes('CWE-209'));
    expect(has209).toBe(true);
  });

  it('covers CWE-284 (Improper Access Control)', () => {
    const has284 = rules.some((r) => r.metadata?.cwe?.includes('CWE-284'));
    expect(has284).toBe(true);
  });

  it('covers CWE-20 (Improper Input Validation)', () => {
    const has20 = rules.some((r) => r.metadata?.cwe?.includes('CWE-20'));
    expect(has20).toBe(true);
  });

  it('covers CWE-22 (Path Traversal)', () => {
    const has22 = rules.some((r) => r.metadata?.cwe?.includes('CWE-22'));
    expect(has22).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CI integration
// ---------------------------------------------------------------------------

describe('CI integration', () => {
  it('CI workflow includes SAST job', () => {
    expect(existsSync(CI_PATH)).toBe(true);
    const content = readFileSync(CI_PATH, 'utf-8');
    expect(content).toContain('sast');
    expect(content).toContain('semgrep');
  });

  it('CI workflow references the rules file', () => {
    const content = readFileSync(CI_PATH, 'utf-8');
    expect(content).toContain('.semgrep/carapace-rules.yml');
  });

  it('SAST job blocks on findings (exit-code non-zero)', () => {
    const content = readFileSync(CI_PATH, 'utf-8');
    // The semgrep command should use --error flag or the action should
    // be configured to fail on findings
    expect(content).toMatch(/--error|exit-code|fail-on/i);
  });
});
