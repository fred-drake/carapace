/**
 * Response sanitizer for the Carapace Response Path.
 *
 * Stage 1 of Sanitize → Log → Forward. Deep-walks response payloads and
 * replaces credential patterns with [REDACTED]. Reports field paths that
 * were sanitized so the audit log can record them without leaking values.
 *
 * Defense-in-depth against plugin authors accidentally leaking secrets
 * in tool responses or error messages.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Replacement string for redacted credential values. */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Result of sanitizing a value. */
export interface SanitizeResult {
  /** The sanitized value (deep copy — original is not mutated). */
  value: unknown;
  /** JSON-path-style field paths where redaction occurred. */
  redactedPaths: string[];
}

// ---------------------------------------------------------------------------
// Credential patterns
// ---------------------------------------------------------------------------

/**
 * Each pattern is a pair: [regex, replacer].
 *
 * Patterns are applied in order. A string may match multiple patterns.
 * Replacers receive the match and return the sanitized replacement.
 */
const CREDENTIAL_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  replace: (match: string) => string;
}> = [
  // Bearer tokens: "Bearer <token>" but NOT "bearer of" in prose
  {
    name: 'bearer_token',
    pattern: /\b(bearer)\s+([A-Za-z0-9._~+/=-]{6,})/gi,
    replace: (match: string) => {
      const prefix = match.split(/\s+/)[0];
      return `${prefix} ${REDACTED_PLACEHOLDER}`;
    },
  },

  // GitHub tokens: ghp_, gho_, ghs_, github_pat_
  {
    name: 'github_token',
    pattern: /\b(ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{10,}/g,
    replace: () => REDACTED_PLACEHOLDER,
  },

  // Google OAuth tokens: ya29.
  {
    name: 'google_oauth',
    pattern: /\bya29\.[A-Za-z0-9._-]{10,}/g,
    replace: () => REDACTED_PLACEHOLDER,
  },

  // OpenAI / Stripe style keys: sk-, pk-, sk_live_, pk_live_, sk_test_, pk_test_
  {
    name: 'api_key_prefix',
    pattern: /\b[sp]k[-_](?:live_|test_)?[A-Za-z0-9]{8,}/g,
    replace: () => REDACTED_PLACEHOLDER,
  },

  // AWS Access Key IDs: AKIA followed by 16 uppercase alphanumeric chars
  {
    name: 'aws_access_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => REDACTED_PLACEHOLDER,
  },

  // Connection strings with embedded credentials:
  // postgres://, mysql://, mongodb://, mongodb+srv://, redis://, amqp://
  {
    name: 'connection_string',
    pattern: /\b(postgres|mysql|mongodb\+srv|mongodb|redis|amqp):\/\/[^\s]+/gi,
    replace: () => REDACTED_PLACEHOLDER,
  },

  // X-API-Key header: "X-API-Key: <value>"
  {
    name: 'x_api_key_header',
    pattern: /\b(x-api-key):\s*(\S+)/gi,
    replace: (match: string) => {
      const colonIndex = match.indexOf(':');
      const header = match.slice(0, colonIndex);
      const space = match.slice(colonIndex + 1).match(/^(\s*)/)?.[1] ?? ' ';
      return `${header}:${space}${REDACTED_PLACEHOLDER}`;
    },
  },

  // Generic api_key= in query strings or config
  {
    name: 'api_key_param',
    pattern: /\b(api_key|apikey|api-key)=([^\s&]+)/gi,
    replace: (match: string) => {
      const eqIndex = match.indexOf('=');
      return `${match.slice(0, eqIndex)}=${REDACTED_PLACEHOLDER}`;
    },
  },

  // Private key blocks
  {
    name: 'private_key',
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*/g,
    replace: () => REDACTED_PLACEHOLDER,
  },
];

// ---------------------------------------------------------------------------
// ResponseSanitizer
// ---------------------------------------------------------------------------

export class ResponseSanitizer {
  /**
   * Sanitize a value by deep-walking it and replacing credential patterns.
   *
   * Returns a deep copy of the value with sensitive data replaced and
   * a list of JSON-path field paths where redaction occurred.
   */
  sanitize(value: unknown): SanitizeResult {
    const redactedPaths: string[] = [];
    const sanitized = this.walk(value, '$', redactedPaths);
    return { value: sanitized, redactedPaths };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private walk(value: unknown, path: string, redactedPaths: string[]): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      return this.sanitizeString(value, path, redactedPaths);
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item, index) => this.walk(item, `${path}[${index}]`, redactedPaths));
    }

    // Plain object
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = this.walk(val, `${path}.${key}`, redactedPaths);
    }
    return result;
  }

  private sanitizeString(value: string, path: string, redactedPaths: string[]): string {
    let sanitized = value;
    let wasRedacted = false;

    for (const { pattern, replace } of CREDENTIAL_PATTERNS) {
      // Reset regex lastIndex for global patterns
      pattern.lastIndex = 0;
      if (pattern.test(sanitized)) {
        pattern.lastIndex = 0;
        sanitized = sanitized.replace(pattern, (match) => {
          wasRedacted = true;
          return replace(match);
        });
      }
    }

    if (wasRedacted) {
      redactedPaths.push(path);
    }

    return sanitized;
  }
}
