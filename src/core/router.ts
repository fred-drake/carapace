/**
 * Core message router for Carapace.
 *
 * Orchestrates the 6-stage validation pipeline for incoming WireMessages
 * from the container. Each message flows through: construct → topic →
 * payload → authorize → confirm → route. On any failure the pipeline
 * short-circuits and returns an error ResponseEnvelope.
 */

import { PROTOCOL_VERSION } from '../types/protocol.js';
import type { WireMessage, ResponseEnvelope } from '../types/protocol.js';
import { ErrorCode, ERROR_RETRIABLE_DEFAULTS } from '../types/errors.js';
import type { ErrorPayload } from '../types/errors.js';
import { ToolCatalog } from './tool-catalog.js';
import { stage1Construct } from './pipeline/stage-1-construct.js';
import { createStage2Topic } from './pipeline/stage-2-topic.js';
import { stage3Payload } from './pipeline/stage-3-payload.js';
import { stage4Authorize } from './pipeline/stage-4-authorize.js';
import { stage5Confirm } from './pipeline/stage-5-confirm.js';
import { dispatchToHandler } from './pipeline/stage-6-route.js';
import type {
  PipelineContext,
  PipelineResult,
  PipelineStage,
  SessionContext,
} from './pipeline/types.js';

// ---------------------------------------------------------------------------
// MessageRouter
// ---------------------------------------------------------------------------

export class MessageRouter {
  private readonly catalog: ToolCatalog;
  private readonly stages: PipelineStage[];

  constructor(toolCatalog: ToolCatalog) {
    this.catalog = toolCatalog;

    // Stages 1-5 are synchronous; stage 6 (dispatch) is async and handled
    // separately after the synchronous pipeline completes.
    this.stages = [
      stage1Construct,
      createStage2Topic(this.catalog),
      stage3Payload,
      stage4Authorize,
      stage5Confirm,
    ];
  }

  /**
   * Process a WireMessage through the full 6-stage pipeline.
   *
   * @param wire - The wire message from the container.
   * @param session - The trusted session context from the host.
   * @returns A ResponseEnvelope — either a success response from the handler
   *   or an error response from whichever stage rejected the message.
   */
  async processRequest(wire: WireMessage, session: SessionContext): Promise<ResponseEnvelope> {
    try {
      let ctx: PipelineContext = { wire, session };

      // Run synchronous stages 1-5
      for (const stage of this.stages) {
        const result = stage.execute(ctx);

        // Check if the stage returned an error (PipelineResult with ok: false)
        if (this.isPipelineResult(result)) {
          if (!result.ok) {
            return this.buildErrorResponse(wire, result.error);
          }
          // ok: true should not happen from stages 1-5, but handle gracefully
          return this.buildSuccessResponse(result);
        }

        // Stage returned an enriched context — continue
        ctx = result;
      }

      // At this point ctx should have envelope and tool from stages 1-2
      if (!ctx.envelope || !ctx.tool) {
        return this.buildErrorResponse(wire, {
          code: ErrorCode.PLUGIN_ERROR,
          message: 'Pipeline error: envelope or tool not resolved after all stages',
          retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.PLUGIN_ERROR],
        });
      }

      // Stage 6: async handler dispatch
      const handler = this.catalog.get(ctx.tool.name)?.handler;
      if (!handler) {
        return this.buildErrorResponse(wire, {
          code: ErrorCode.PLUGIN_UNAVAILABLE,
          message: `Handler not found for tool: "${ctx.tool.name}"`,
          retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.PLUGIN_UNAVAILABLE],
        });
      }

      return await dispatchToHandler(ctx.envelope, handler);
    } catch (err: unknown) {
      // Catch unexpected errors and wrap them
      const message = err instanceof Error ? err.message : String(err);
      return this.buildErrorResponse(wire, {
        code: ErrorCode.PLUGIN_ERROR,
        message: `Unexpected error: ${message}`,
        retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.PLUGIN_ERROR],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Type guard to distinguish PipelineResult from PipelineContext.
   * PipelineResult always has an `ok` property; PipelineContext does not.
   */
  private isPipelineResult(value: PipelineResult | PipelineContext): value is PipelineResult {
    return 'ok' in value;
  }

  /**
   * Build an error ResponseEnvelope with the correct correlation ID
   * from the original wire message.
   */
  private buildErrorResponse(wire: WireMessage, error: ErrorPayload): ResponseEnvelope {
    return {
      id: crypto.randomUUID(),
      version: PROTOCOL_VERSION,
      type: 'response',
      topic: wire.topic,
      source: 'core',
      correlation: wire.correlation,
      timestamp: new Date().toISOString(),
      group: '',
      payload: {
        result: null,
        error,
      },
    };
  }

  /**
   * Build a success ResponseEnvelope from a completed PipelineResult.
   * This path is not expected from the normal pipeline flow but exists
   * for completeness.
   */
  private buildSuccessResponse(_result: PipelineResult & { ok: true }): ResponseEnvelope {
    // This should not be reached in normal flow
    throw new Error('Unexpected success result from synchronous pipeline stage');
  }
}
