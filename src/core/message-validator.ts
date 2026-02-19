/**
 * Host-side message validation pipeline for Carapace.
 *
 * Composes the synchronous pipeline stages (construct → topic → payload →
 * authorize) into a single validation pass. Every incoming WireMessage from
 * the container flows through this pipeline before handler dispatch.
 *
 * Rejection logging: when any stage rejects a message, the `onRejection`
 * callback fires with the wire message, session context, rejecting stage
 * name, and error details. Callers typically forward this to the AuditLog.
 */

import type { WireMessage } from '../types/protocol.js';
import type { ErrorPayload } from '../types/errors.js';
import type { ToolCatalog } from './tool-catalog.js';
import type { SchemaValidator } from './schema-validator.js';
import type { RateLimiter } from './rate-limiter.js';
import { stage1Construct } from './pipeline/stage-1-construct.js';
import { createStage2Topic } from './pipeline/stage-2-topic.js';
import { stage3Payload } from './pipeline/stage-3-payload.js';
import { createStage4Authorize } from './pipeline/stage-4-authorize.js';
import type {
  SessionContext,
  PipelineContext,
  PipelineResult,
  PipelineStage,
} from './pipeline/types.js';

// ---------------------------------------------------------------------------
// Rejection entry
// ---------------------------------------------------------------------------

/** Information passed to the onRejection callback. */
export interface RejectionEntry {
  wire: WireMessage;
  session: SessionContext;
  stage: string;
  error: ErrorPayload;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration for the MessageValidator. */
export interface MessageValidatorOptions {
  /** Tool catalog for topic whitelist (stage 2). */
  catalog: ToolCatalog;
  /** Schema validator with pre-compiled tool schemas (stage 3). */
  schemaValidator: SchemaValidator;
  /** Rate limiter for per-session throttling (stage 4). */
  rateLimiter: RateLimiter;
  /**
   * Per-tool group restrictions for authorization (stage 4).
   * Maps tool name → set of allowed groups. Omit for unrestricted access.
   */
  toolGroupRestrictions?: Map<string, Set<string>>;
  /**
   * Callback fired when any stage rejects a message.
   * Typically used to write to the audit log.
   */
  onRejection?: (entry: RejectionEntry) => void;
}

// ---------------------------------------------------------------------------
// MessageValidator
// ---------------------------------------------------------------------------

export class MessageValidator {
  private readonly stages: PipelineStage[];
  readonly onRejection?: (entry: RejectionEntry) => void;

  constructor(options: MessageValidatorOptions) {
    this.onRejection = options.onRejection;

    this.stages = [
      stage1Construct,
      createStage2Topic(options.catalog),
      stage3Payload,
      createStage4Authorize({
        rateLimiter: options.rateLimiter,
        toolGroupRestrictions: options.toolGroupRestrictions,
      }),
    ];
  }

  /**
   * Run a WireMessage through all validation stages.
   *
   * @param wire - The wire message from the container.
   * @param session - The trusted session context from the host.
   * @returns PipelineResult: success (with envelope + tool) or rejection (with error).
   */
  validate(wire: WireMessage, session: SessionContext): PipelineResult {
    let ctx: PipelineContext = { wire, session };

    for (const stage of this.stages) {
      const result = stage.execute(ctx);

      if (this.isPipelineResult(result)) {
        if (!result.ok && this.onRejection) {
          this.onRejection({
            wire,
            session,
            stage: stage.name,
            error: result.error,
          });
        }
        return result;
      }

      ctx = result;
    }

    // All stages passed — ctx should have envelope and tool
    if (ctx.envelope && ctx.tool) {
      return { ok: true, envelope: ctx.envelope, tool: ctx.tool };
    }

    // Should not happen if stages are correctly implemented
    return {
      ok: false,
      error: {
        code: 'PLUGIN_ERROR',
        message: 'Pipeline error: envelope or tool not resolved after all stages',
        retriable: false,
      },
    };
  }

  /**
   * Type guard: PipelineResult has `ok`, PipelineContext does not.
   */
  private isPipelineResult(value: PipelineResult | PipelineContext): value is PipelineResult {
    return 'ok' in value;
  }
}
