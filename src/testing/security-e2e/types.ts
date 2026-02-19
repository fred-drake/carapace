/**
 * Types for adversarial e2e security tests (SEC-12).
 *
 * Extends the QA-08 e2e scenario types with defense-layer mapping
 * and adversarial-specific metadata.
 */

import type { E2EScenario } from '../e2e/types.js';

// ---------------------------------------------------------------------------
// Defense layers
// ---------------------------------------------------------------------------

/**
 * Named defense layers in the Carapace architecture.
 *
 * Each maps to a concrete module or pipeline stage that blocks a class
 * of attacks.
 */
export type DefenseLayer =
  | 'wire_format_isolation' // Stage 1: core owns identity fields
  | 'topic_validation' // Stage 2: UNKNOWN_TOOL for undeclared tools
  | 'schema_validation' // Stage 3: additionalProperties:false, type checks
  | 'group_authorization' // Stage 4: group-based access control
  | 'rate_limiter' // Stage 4: token-bucket rate limiting
  | 'confirmation_gate' // Stage 5: high-risk tool approval
  | 'response_sanitizer' // Post-pipeline: credential redaction
  | 'container_isolation' // VM/namespace boundary
  | 'network_allowlist' // Container egress restriction
  | 'session_isolation'; // Per-session state separation

/** Human-readable descriptions of each defense layer. */
export const DEFENSE_LAYER_DESCRIPTIONS: Record<DefenseLayer, string> = {
  wire_format_isolation:
    'Stage 1 — Core constructs identity fields from trusted session state, ignoring wire claims',
  topic_validation: 'Stage 2 — Only declared tools can be invoked; UNKNOWN_TOOL for others',
  schema_validation:
    'Stage 3 — JSON Schema with additionalProperties:false blocks injection via extra fields',
  group_authorization: 'Stage 4 — Group-based access control prevents cross-group tool access',
  rate_limiter: 'Stage 4 — Token-bucket rate limiter with per-session and per-group buckets',
  confirmation_gate: 'Stage 5 — High-risk tools require explicit pre-approval',
  response_sanitizer: 'Post-pipeline — Deep-walks responses and redacts credential patterns',
  container_isolation: 'VM-level isolation prevents container from accessing host resources',
  network_allowlist: 'Container egress restricted to inproc:// sockets only',
  session_isolation: 'Per-session state prevents cross-session interference',
};

// ---------------------------------------------------------------------------
// Adversarial scenario
// ---------------------------------------------------------------------------

/** An adversarial scenario extends E2EScenario with attack metadata. */
export interface AdversarialScenario extends E2EScenario {
  /** MITRE ATT&CK-style attack description. */
  attack: string;
  /** Defense layers that block this attack. */
  defenses: DefenseLayer[];
  /** Severity if the attack succeeded (for reporting). */
  severity: 'critical' | 'high' | 'medium' | 'low';
}

// ---------------------------------------------------------------------------
// Defense report
// ---------------------------------------------------------------------------

/** Maps a scenario to its defense layers with pass/fail status. */
export interface DefenseMapping {
  /** Scenario name. */
  scenario: string;
  /** Attack description. */
  attack: string;
  /** Severity rating. */
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** Defense layers exercised. */
  defenses: DefenseLayer[];
  /** Whether all defenses held (scenario assertions passed). */
  contained: boolean;
}

/** Full defense report for the adversarial test suite. */
export interface DefenseReport {
  /** Individual scenario-to-defense mappings. */
  mappings: DefenseMapping[];
  /** Total scenarios. */
  total: number;
  /** Number of scenarios where all attacks were contained. */
  contained: number;
  /** Number where at least one defense failed. */
  breached: number;
  /** Unique defense layers exercised across all scenarios. */
  layersCovered: DefenseLayer[];
  /** Timestamp. */
  timestamp: string;
}
