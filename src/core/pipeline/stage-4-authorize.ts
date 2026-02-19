/**
 * Pipeline Stage 4: Authorization and rate limiting.
 *
 * Two checks in order:
 *   1. Group authorization — verify the session's group is allowed to invoke
 *      the resolved tool. Tools not in the restriction map are unrestricted.
 *   2. Rate limiting — consume a token from the session's bucket. Group auth
 *      runs first so that unauthorized requests don't consume rate limit tokens.
 *
 * Produces UNAUTHORIZED (stage 4) or RATE_LIMITED (stage 4) on failure.
 */

import { ErrorCode, ERROR_RETRIABLE_DEFAULTS } from '../../types/errors.js';
import type { RateLimiter } from '../rate-limiter.js';
import type { PipelineStage, PipelineContext, PipelineResult } from './types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration for the authorization stage. */
export interface Stage4Options {
  /** Rate limiter instance for per-session throttling. */
  rateLimiter: RateLimiter;
  /**
   * Per-tool group restrictions. Maps tool name → set of allowed groups.
   * Tools not in this map are unrestricted (available to all groups).
   * When omitted, all tools are unrestricted.
   */
  toolGroupRestrictions?: Map<string, Set<string>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Stage 4 authorization pipeline stage.
 *
 * Group authorization runs before rate limiting so that unauthorized
 * requests don't consume rate limit tokens.
 */
export function createStage4Authorize(options: Stage4Options): PipelineStage {
  const { rateLimiter, toolGroupRestrictions } = options;

  return {
    name: 'authorize',

    execute(ctx: PipelineContext): PipelineResult | PipelineContext {
      const { session, tool } = ctx;

      // Guard: tool must be resolved by stage 2
      if (!tool) {
        return {
          ok: false,
          error: {
            code: ErrorCode.UNAUTHORIZED,
            message: 'Pipeline error: tool not resolved before authorization',
            retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.UNAUTHORIZED],
            stage: 4,
          },
        };
      }

      // 1. Group authorization
      if (toolGroupRestrictions) {
        const allowedGroups = toolGroupRestrictions.get(tool.name);
        if (allowedGroups && !allowedGroups.has(session.group)) {
          return {
            ok: false,
            error: {
              code: ErrorCode.UNAUTHORIZED,
              message:
                `Group "${session.group}" is not authorized ` + `to invoke tool "${tool.name}"`,
              retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.UNAUTHORIZED],
              stage: 4,
            },
          };
        }
      }

      // 2. Rate limiting (only after auth passes — don't consume tokens on auth failure)
      const rateResult = rateLimiter.tryConsume(session.sessionId, session.group);
      if (!rateResult.allowed) {
        return {
          ok: false,
          error: {
            code: ErrorCode.RATE_LIMITED,
            message: `Rate limit exceeded for session "${session.sessionId}"`,
            retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.RATE_LIMITED],
            stage: 4,
            retry_after: Math.ceil(rateResult.retryAfter),
          },
        };
      }

      return ctx;
    },
  };
}

/**
 * Backward-compatible pass-through stub for code that hasn't migrated to
 * the factory function yet.
 *
 * @deprecated Use `createStage4Authorize()` instead.
 */
export const stage4Authorize: PipelineStage = {
  name: 'authorize',

  execute(ctx: PipelineContext): PipelineResult | PipelineContext {
    return ctx;
  },
};
