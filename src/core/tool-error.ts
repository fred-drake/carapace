/**
 * ToolError — structured error class for plugin handlers.
 *
 * Plugin handlers throw ToolError to produce a structured error response
 * with a specific error code. The core discriminates ToolError from
 * other throws: ToolError → structured error response, anything else →
 * generic PLUGIN_ERROR (no internals leaked).
 *
 * If a handler throws ToolError with a reserved pipeline code, the core
 * normalizes it to HANDLER_ERROR and preserves the original message.
 */

import type { ErrorCodeValue, ErrorPayload } from '../types/errors.js';
import { ERROR_RETRIABLE_DEFAULTS, RESERVED_PIPELINE_CODES, ErrorCode } from '../types/errors.js';

// ---------------------------------------------------------------------------
// Brand symbol (module-private, not exported)
// ---------------------------------------------------------------------------

/**
 * Private symbol used to brand ToolError instances. This prevents
 * plain objects or Error subclasses from spoofing ToolError via
 * duck-typing or __proto__ manipulation.
 */
const TOOL_ERROR_BRAND = Symbol.for('carapace.ToolError');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for constructing a ToolError. */
export interface ToolErrorOptions {
  /** Machine-readable error code. */
  code: ErrorCodeValue;
  /** Human-readable explanation. */
  message: string;
  /** Whether the same request might succeed if retried. Defaults to ERROR_RETRIABLE_DEFAULTS. */
  retriable?: boolean;
  /** Which argument field caused the error. */
  field?: string;
  /** Seconds to wait before retrying. */
  retry_after?: number;
}

// ---------------------------------------------------------------------------
// ToolError class
// ---------------------------------------------------------------------------

export class ToolError extends Error {
  /** Machine-readable error code (normalized if reserved). */
  readonly code: ErrorCodeValue;
  /** Whether the same request might succeed if retried. */
  readonly retriable: boolean;
  /** Which argument field caused the error. */
  readonly field?: string;
  /** Seconds to wait before retrying. */
  readonly retry_after?: number;

  /** @internal Brand for safe instanceof checks across module boundaries. */
  readonly [TOOL_ERROR_BRAND] = true as const;

  constructor(options: ToolErrorOptions) {
    super(options.message);
    this.name = 'ToolError';

    // Normalize reserved pipeline codes to HANDLER_ERROR
    this.code = RESERVED_PIPELINE_CODES.has(options.code) ? ErrorCode.HANDLER_ERROR : options.code;

    this.retriable = options.retriable ?? ERROR_RETRIABLE_DEFAULTS[this.code];

    if (options.field !== undefined) {
      this.field = options.field;
    }
    if (options.retry_after !== undefined) {
      this.retry_after = options.retry_after;
    }
  }

  /**
   * Convert to a sanitized ErrorPayload suitable for the response envelope.
   * No stack traces or internal details are included.
   */
  toErrorPayload(): ErrorPayload {
    const payload: ErrorPayload = {
      code: this.code,
      message: this.message,
      retriable: this.retriable,
    };

    if (this.field !== undefined) {
      payload.field = this.field;
    }
    if (this.retry_after !== undefined) {
      payload.retry_after = this.retry_after;
    }

    return payload;
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Safe type guard for ToolError instances.
 *
 * Uses the private brand symbol to prevent spoofing via duck-typing,
 * plain objects with matching fields, or __proto__ manipulation.
 * Also checks instanceof for same-module usage.
 */
export function isToolError(value: unknown): value is ToolError {
  if (value instanceof ToolError) {
    return true;
  }

  // Cross-module check: branded symbol
  if (
    typeof value === 'object' &&
    value !== null &&
    TOOL_ERROR_BRAND in value &&
    (value as Record<symbol, unknown>)[TOOL_ERROR_BRAND] === true
  ) {
    return true;
  }

  return false;
}
