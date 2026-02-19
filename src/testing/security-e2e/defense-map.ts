/**
 * Defense layer mapping and report generation (SEC-12).
 *
 * Builds a structured report mapping adversarial scenarios to the
 * defense layers that blocked each attack.
 */

import type { ScenarioResult } from '../e2e/types.js';
import type {
  AdversarialScenario,
  DefenseLayer,
  DefenseMapping,
  DefenseReport,
  DEFENSE_LAYER_DESCRIPTIONS,
} from './types.js';

// Re-export for convenience
export type { DefenseMapping, DefenseReport };

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

/** Build a defense report from adversarial scenarios and their results. */
export function buildDefenseReport(
  scenarios: AdversarialScenario[],
  results: ScenarioResult[],
): DefenseReport {
  const mappings: DefenseMapping[] = scenarios.map((scenario, index) => {
    const result = results[index];
    return {
      scenario: scenario.name,
      attack: scenario.attack,
      severity: scenario.severity,
      defenses: scenario.defenses,
      contained: result?.passed ?? false,
    };
  });

  const allLayers = new Set<DefenseLayer>();
  for (const m of mappings) {
    for (const d of m.defenses) {
      allLayers.add(d);
    }
  }

  const contained = mappings.filter((m) => m.contained).length;

  return {
    mappings,
    total: mappings.length,
    contained,
    breached: mappings.length - contained,
    layersCovered: [...allLayers].sort(),
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Text report formatter
// ---------------------------------------------------------------------------

/** Format a defense report as a human-readable text summary. */
export function formatDefenseReport(
  report: DefenseReport,
  descriptions: typeof DEFENSE_LAYER_DESCRIPTIONS,
): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('  Adversarial Security E2E — Defense Report');
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  Timestamp:    ${report.timestamp}`);
  lines.push(`  Total:        ${report.total} scenarios`);
  lines.push(`  Contained:    ${report.contained}/${report.total}`);
  lines.push(`  Breached:     ${report.breached}/${report.total}`);
  lines.push(`  Layers tested: ${report.layersCovered.length}`);
  lines.push('');

  lines.push('───────────────────────────────────────────────────────────');
  lines.push('  Scenario Results');
  lines.push('───────────────────────────────────────────────────────────');

  for (const mapping of report.mappings) {
    const icon = mapping.contained ? '✓' : '✗';
    const severity = mapping.severity.toUpperCase().padEnd(8);
    lines.push(`  ${icon} [${severity}] ${mapping.scenario}`);
    lines.push(`    Attack:   ${mapping.attack}`);
    lines.push(`    Defenses: ${mapping.defenses.join(', ')}`);
    lines.push(`    Status:   ${mapping.contained ? 'CONTAINED' : 'BREACHED'}`);
    lines.push('');
  }

  lines.push('───────────────────────────────────────────────────────────');
  lines.push('  Defense Layer Coverage');
  lines.push('───────────────────────────────────────────────────────────');

  for (const layer of report.layersCovered) {
    const desc = descriptions[layer];
    const scenarioCount = report.mappings.filter((m) => m.defenses.includes(layer)).length;
    lines.push(`  ${layer} (${scenarioCount} scenarios)`);
    lines.push(`    ${desc}`);
  }

  lines.push('');
  return lines.join('\n');
}
