/**
 * Pipeline Stage 4: Authorization (pass-through stub).
 *
 * Always passes. Real authorization logic will be implemented in SEC-01 (P1).
 * This stage exists to maintain the 6-stage pipeline structure.
 */

import type { PipelineStage, PipelineContext, PipelineResult } from './types.js';

// ---------------------------------------------------------------------------
// Stage 4
// ---------------------------------------------------------------------------

export const stage4Authorize: PipelineStage = {
  name: 'authorize',

  execute(ctx: PipelineContext): PipelineResult | PipelineContext {
    return ctx;
  },
};
