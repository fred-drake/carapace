/**
 * Pipeline Stage 5: User confirmation (pass-through stub).
 *
 * Always passes. Real user confirmation logic will be implemented in
 * ENG-15 (P1). This stage exists to maintain the 6-stage pipeline structure.
 */

import type { PipelineStage, PipelineContext, PipelineResult } from './types.js';

// ---------------------------------------------------------------------------
// Stage 5
// ---------------------------------------------------------------------------

export const stage5Confirm: PipelineStage = {
  name: 'confirm',

  execute(ctx: PipelineContext): PipelineResult | PipelineContext {
    return ctx;
  },
};
