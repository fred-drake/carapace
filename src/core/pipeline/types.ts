/**
 * Pipeline types for the Carapace 6-stage validation pipeline.
 *
 * The pipeline processes a WireMessage from the container through six stages
 * before dispatching to the appropriate plugin handler. Each stage can either
 * pass (returning an updated context) or reject (returning an error).
 */

import type { WireMessage, RequestEnvelope } from '../../types/protocol.js';
import type { ErrorPayload } from '../../types/errors.js';
import type { ToolDeclaration } from '../../types/manifest.js';

// ---------------------------------------------------------------------------
// Session context
// ---------------------------------------------------------------------------

/**
 * Trusted session state constructed by the host. Never comes from the
 * container — the core builds this from its own bookkeeping.
 */
export interface SessionContext {
  sessionId: string;
  group: string;
  source: string;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Pipeline context
// ---------------------------------------------------------------------------

/**
 * Mutable context threaded through each pipeline stage.
 *
 * Stages enrich the context as they execute:
 *   Stage 1 sets `envelope`
 *   Stage 2 sets `tool`
 *   Stages 3-6 validate and dispatch
 */
export interface PipelineContext {
  wire: WireMessage;
  session: SessionContext;
  envelope?: RequestEnvelope;
  tool?: ToolDeclaration;
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

/**
 * Terminal result of the full pipeline. Either a successful dispatch
 * (with the resolved envelope + tool) or a rejection (with error details).
 */
export type PipelineResult =
  | { ok: true; envelope: RequestEnvelope; tool: ToolDeclaration }
  | { ok: false; error: ErrorPayload };

// ---------------------------------------------------------------------------
// Pipeline stage
// ---------------------------------------------------------------------------

/**
 * A single stage in the validation pipeline.
 *
 * Each stage receives the current context and returns either:
 *   - An enriched `PipelineContext` (pass — continue to next stage)
 *   - A `PipelineResult` with `ok: false` (reject — stop the pipeline)
 */
export interface PipelineStage {
  name: string;
  execute(ctx: PipelineContext): PipelineResult | PipelineContext;
}
