/**
 * Credential injection protocol for the Carapace container entrypoint.
 *
 * Credentials are piped to the container's stdin in a simple line protocol:
 *   NAME=VALUE\n
 *   NAME=VALUE\n
 *   \n  (empty line terminates the credential list)
 *
 * This ensures credentials never appear in:
 *   - `docker inspect` (not set via -e or Dockerfile ENV)
 *   - Image layers (not baked into the image)
 *   - Mounted files (not written to a volume)
 *   - Process arguments (not CLI flags)
 *
 * The entrypoint.sh script reads these lines, exports them as env vars,
 * then exec's into Claude Code.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single credential to inject into the container. */
export interface Credential {
  /** Environment variable name (must be a valid shell identifier). */
  name: string;
  /** Environment variable value (must not contain newlines). */
  value: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Valid environment variable name: starts with a letter or underscore,
 * followed by letters, digits, or underscores. No spaces, hyphens,
 * equals signs, newlines, or null bytes.
 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate that a string is a safe environment variable name. */
export function validateCredentialName(name: string): boolean {
  return ENV_NAME_RE.test(name);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single credential line from the wire protocol.
 *
 * @returns The parsed credential, or null if the line is empty or invalid.
 */
export function parseCredentialLine(line: string): Credential | null {
  if (line.length === 0) return null;

  const eqIndex = line.indexOf('=');
  if (eqIndex === -1) return null;

  const name = line.slice(0, eqIndex);
  const value = line.slice(eqIndex + 1);

  if (!validateCredentialName(name)) return null;

  return { name, value };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize credentials into the wire protocol format for writing to
 * the container's stdin.
 *
 * Format: `NAME=VALUE\n` per credential, followed by `\n` (empty line)
 * to signal end of credentials.
 *
 * @throws If any credential name is invalid or any value contains a newline.
 */
export function serializeCredentials(credentials: Credential[]): string {
  if (credentials.length === 0) {
    return '\n';
  }

  const lines: string[] = [];

  for (const cred of credentials) {
    if (!validateCredentialName(cred.name)) {
      throw new Error(`Invalid credential name: "${cred.name}"`);
    }
    if (cred.value.includes('\n')) {
      throw new Error(`Credential value for "${cred.name}" must not contain newlines`);
    }
    lines.push(`${cred.name}=${cred.value}`);
  }

  // Each credential line + empty line terminator
  return lines.join('\n') + '\n\n';
}
