/**
 * Message size limits and DoS prevention for Carapace.
 *
 * Enforces configurable limits on raw message size, payload size,
 * individual field lengths, and JSON nesting depth. Designed to run
 * BEFORE full JSON parsing where possible to prevent memory exhaustion
 * and stack overflow attacks at the trust boundary.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configurable limits for incoming messages. All sizes in bytes. */
export interface MessageLimitsConfig {
  /** Maximum raw byte length of the entire message. Default 1 MB. */
  maxRawBytes?: number;
  /** Maximum byte length of the serialised `arguments` payload. Default 1 MB. */
  maxPayloadBytes?: number;
  /** Maximum byte length of any single argument field value. Default 100 KB. */
  maxFieldBytes?: number;
  /** Maximum JSON nesting depth (objects + arrays). Default 64. */
  maxJsonDepth?: number;
}

/** Default limits — 1 MB raw, 1 MB payload, 100 KB per field, 64 depth. */
export const DEFAULT_MESSAGE_LIMITS: Required<MessageLimitsConfig> = {
  maxRawBytes: 1_048_576,
  maxPayloadBytes: 1_048_576,
  maxFieldBytes: 102_400,
  maxJsonDepth: 64,
};

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Result of a message limits check. */
export type MessageLimitsResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// JSON depth checker (character-level scan, no parsing)
// ---------------------------------------------------------------------------

/**
 * Scan the raw JSON string and return the maximum nesting depth.
 * Counts `{` and `[` as depth increments, `}` and `]` as decrements.
 * Skips characters inside string literals (handles `\"` escapes).
 */
function measureJsonDepth(raw: string): number {
  let depth = 0;
  let maxDepth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{' || ch === '[') {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    } else if (ch === '}' || ch === ']') {
      depth--;
    }
  }

  return maxDepth;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check a raw message string against configurable size and depth limits.
 *
 * Checks are ordered so that the cheapest (raw byte length) runs first,
 * and rejection can happen before any JSON parsing.
 *
 * @param raw - The raw message string (before JSON.parse).
 * @param config - Optional overrides for individual limits.
 * @returns `{ ok: true }` if all limits pass, or `{ ok: false, error }` with
 *   a descriptive message naming the limit, actual value, and configured max.
 */
export function checkMessageLimits(raw: string, config?: MessageLimitsConfig): MessageLimitsResult {
  const limits = { ...DEFAULT_MESSAGE_LIMITS, ...config };

  // 1. Raw byte size — cheapest check, before any parsing
  const rawBytes = Buffer.byteLength(raw, 'utf-8');
  if (rawBytes > limits.maxRawBytes) {
    return {
      ok: false,
      error:
        `Message exceeds raw byte size limit: ` +
        `${rawBytes} bytes > ${limits.maxRawBytes} byte limit`,
    };
  }

  // Empty/tiny messages pass size checks; downstream handles parse errors.
  if (raw.length === 0) {
    return { ok: true };
  }

  // 2. JSON depth — character-level scan, no JSON.parse needed
  const depth = measureJsonDepth(raw);
  if (depth > limits.maxJsonDepth) {
    return {
      ok: false,
      error:
        `Message exceeds JSON nesting depth limit: ` +
        `${depth} levels > ${limits.maxJsonDepth} level limit`,
    };
  }

  // 3. Parse JSON to inspect payload and fields
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // If JSON is invalid, that's a protocol error handled downstream.
    // Our job is size/depth limits, not format validation.
    return { ok: true };
  }

  // 4. Payload size — serialised `arguments` object
  const args = parsed.arguments;
  if (args !== undefined && args !== null && typeof args === 'object') {
    const argsJson = JSON.stringify(args);
    const payloadBytes = Buffer.byteLength(argsJson, 'utf-8');
    if (payloadBytes > limits.maxPayloadBytes) {
      return {
        ok: false,
        error:
          `Message exceeds payload size limit: ` +
          `${payloadBytes} bytes > ${limits.maxPayloadBytes} byte limit`,
      };
    }

    // 5. Per-field size — each top-level argument field
    const argsObj = args as Record<string, unknown>;
    for (const [key, value] of Object.entries(argsObj)) {
      const fieldJson = JSON.stringify(value);
      const fieldBytes = Buffer.byteLength(fieldJson, 'utf-8');
      if (fieldBytes > limits.maxFieldBytes) {
        return {
          ok: false,
          error:
            `Argument field "${key}" exceeds field size limit: ` +
            `${fieldBytes} bytes > ${limits.maxFieldBytes} byte limit`,
        };
      }
    }
  }

  return { ok: true };
}
