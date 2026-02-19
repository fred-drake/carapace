/**
 * Error discrimination and handler execution for Carapace.
 *
 * Wraps plugin handler invocations with:
 * - Timeout enforcement (→ PLUGIN_TIMEOUT)
 * - ToolError discrimination (→ structured error response)
 * - Generic error catch-all (→ PLUGIN_ERROR, no internals leaked)
 * - Response size limits (→ HANDLER_ERROR for oversized responses)
 */

import type { ResponsePayload } from '../types/protocol.js';
import type { ErrorPayload } from '../types/errors.js';
import { ErrorCode, ERROR_RETRIABLE_DEFAULTS } from '../types/errors.js';
import type { PluginHandler, PluginContext } from './plugin-handler.js';
import { isToolError } from './tool-error.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Options controlling handler execution behavior. */
export interface HandlerExecutionOptions {
  /** Maximum time in milliseconds before PLUGIN_TIMEOUT. Default 30_000. */
  timeoutMs: number;
  /** Maximum response payload size in bytes. Default 1 MB. */
  maxResponseBytes: number;
}

/** Default handler execution options. */
export const DEFAULT_HANDLER_OPTIONS: Readonly<HandlerExecutionOptions> = {
  timeoutMs: 30_000,
  maxResponseBytes: 1_048_576,
};

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`Handler for "${label}" timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ---------------------------------------------------------------------------
// Response size check
// ---------------------------------------------------------------------------

function checkResponseSize(payload: ResponsePayload, maxBytes: number): ErrorPayload | null {
  const serialized = JSON.stringify(payload);
  const bytes = Buffer.byteLength(serialized, 'utf-8');

  if (bytes > maxBytes) {
    return {
      code: ErrorCode.HANDLER_ERROR,
      message: `Response payload exceeds size limit: ${bytes} bytes > ${maxBytes} byte limit`,
      retriable: false,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a plugin handler's tool invocation with full error discrimination.
 *
 * Flow:
 * 1. Call handler with timeout enforcement
 * 2. If handler returns normally: check response size, return ResponsePayload
 * 3. If ToolError thrown: convert to structured error response
 * 4. If other error thrown: produce generic PLUGIN_ERROR (no internals)
 * 5. If timeout: produce PLUGIN_TIMEOUT
 */
export async function executeHandler(
  handler: PluginHandler,
  tool: string,
  args: Record<string, unknown>,
  context: PluginContext,
  options?: Partial<HandlerExecutionOptions>,
): Promise<ResponsePayload> {
  const opts: HandlerExecutionOptions = {
    ...DEFAULT_HANDLER_OPTIONS,
    ...options,
  };

  try {
    const result = await withTimeout(
      handler.handleToolInvocation(tool, args, context),
      opts.timeoutMs,
      tool,
    );

    // Build response payload from handler result
    let payload: ResponsePayload;

    if (result.ok) {
      payload = { result: result.result, error: null };
    } else {
      payload = { result: null, error: result.error };
    }

    // Check response size before returning
    const sizeError = checkResponseSize(payload, opts.maxResponseBytes);
    if (sizeError) {
      return { result: null, error: sizeError };
    }

    return payload;
  } catch (error: unknown) {
    // Timeout → PLUGIN_TIMEOUT
    if (error instanceof TimeoutError) {
      return {
        result: null,
        error: {
          code: ErrorCode.PLUGIN_TIMEOUT,
          message: `Plugin handler for "${tool}" did not respond within ${opts.timeoutMs}ms`,
          retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.PLUGIN_TIMEOUT],
        },
      };
    }

    // ToolError → structured error response
    if (isToolError(error)) {
      return {
        result: null,
        error: error.toErrorPayload(),
      };
    }

    // Everything else → generic PLUGIN_ERROR (no internals leaked)
    return {
      result: null,
      error: {
        code: ErrorCode.PLUGIN_ERROR,
        message: 'Plugin handler encountered an internal error',
        retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.PLUGIN_ERROR],
      },
    };
  }
}
