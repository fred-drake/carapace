/**
 * Pipeline Stage 5: User confirmation gate.
 *
 * Checks the tool's risk_level. Low-risk tools pass through immediately.
 * High-risk tools require user confirmation — if no pre-approval exists
 * for the correlation ID, the stage rejects with CONFIRMATION_TIMEOUT
 * to signal that the async confirmation flow should be initiated.
 *
 * The actual async confirmation waiting is handled by ConfirmationGate
 * (see confirmation-gate.ts). The router/orchestrator is responsible for:
 *   1. Catching the CONFIRMATION_TIMEOUT rejection from this stage
 *   2. Calling ConfirmationGate.requestConfirmation()
 *   3. On approval, adding the correlation to preApprovedCorrelations
 *      and re-running the pipeline (or proceeding to stage 6)
 */

import { ErrorCode, ERROR_RETRIABLE_DEFAULTS } from '../../types/errors.js';
import type { PipelineStage, PipelineContext, PipelineResult } from './types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration for the confirmation stage. */
export interface Stage5Options {
  /**
   * Set of correlation IDs that have already been approved by the user.
   * When a high-risk tool's correlation is in this set, stage 5 passes.
   * Managed by the router/orchestrator after ConfirmationGate.approve().
   */
  preApprovedCorrelations?: Set<string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Stage 5 confirmation pipeline stage.
 *
 * - Low-risk tools: always pass through.
 * - High-risk tools: pass if pre-approved, reject otherwise.
 */
export function createStage5Confirm(options?: Stage5Options): PipelineStage {
  const preApproved = options?.preApprovedCorrelations;

  return {
    name: 'confirm',

    execute(ctx: PipelineContext): PipelineResult | PipelineContext {
      const { tool, envelope } = ctx;

      // Guard: tool must be resolved by stage 2
      if (!tool) {
        return {
          ok: false,
          error: {
            code: ErrorCode.CONFIRMATION_TIMEOUT,
            message: 'Pipeline error: tool not resolved before confirmation stage',
            retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.CONFIRMATION_TIMEOUT],
            stage: 5,
          },
        };
      }

      // Low-risk tools bypass confirmation entirely
      if (tool.risk_level === 'low') {
        return ctx;
      }

      // High-risk tool: check for pre-approval
      const correlation = envelope?.correlation;
      if (correlation && preApproved?.has(correlation)) {
        return ctx;
      }

      // No pre-approval — reject to signal confirmation needed
      return {
        ok: false,
        error: {
          code: ErrorCode.CONFIRMATION_TIMEOUT,
          message:
            `Tool "${tool.name}" has risk_level "high" and requires ` +
            `user confirmation before execution`,
          retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.CONFIRMATION_TIMEOUT],
          stage: 5,
        },
      };
    },
  };
}

/**
 * Backward-compatible pass-through stub.
 *
 * @deprecated Use `createStage5Confirm()` for the full confirmation gate.
 */
export const stage5Confirm: PipelineStage = {
  name: 'confirm',

  execute(ctx: PipelineContext): PipelineResult | PipelineContext {
    return ctx;
  },
};
