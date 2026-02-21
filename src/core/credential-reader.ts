/**
 * Credential reader for Carapace container injection.
 *
 * Reads stored credentials from the host filesystem and formats them
 * for stdin injection into agent containers. The entrypoint script
 * reads NAME=VALUE lines from stdin and exports them as environment
 * variables.
 *
 * Security properties:
 * - Credentials piped via stdin, never visible in `docker inspect`
 * - Only ONE credential is injected (API key takes precedence)
 * - Credential values are never logged
 *
 * @see src/container/entrypoint.sh for the stdin reader
 * @see src/core/container/docker-runtime.ts for the stdinData mechanism
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Credential filenames under `$CARAPACE_HOME/credentials/`. */
export const API_KEY_FILENAME = 'anthropic-api-key';
export const OAUTH_TOKEN_FILENAME = 'claude-oauth-token';

/** Environment variable names expected by Claude Code. */
export const API_KEY_ENV_VAR = 'ANTHROPIC_API_KEY';
export const OAUTH_TOKEN_ENV_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/** Minimal filesystem interface for credential reading. */
export interface CredentialFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf-8'): string;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Read stored credentials and format them for container stdin injection.
 *
 * Reads from the credentials directory (typically `$CARAPACE_HOME/credentials/`).
 * API key takes precedence over OAuth token when both exist — only one
 * credential is injected per container.
 *
 * @param credentialsDir - Absolute path to the credentials directory.
 * @param fs - Filesystem interface (injectable for testing).
 * @returns Formatted stdin data (`NAME=VALUE\n\n`) or null if no credentials found.
 */
export function readCredentialStdin(credentialsDir: string, fs: CredentialFs): string | null {
  const apiKeyPath = `${credentialsDir}/${API_KEY_FILENAME}`;
  const oauthPath = `${credentialsDir}/${OAUTH_TOKEN_FILENAME}`;

  // API key takes precedence
  if (fs.existsSync(apiKeyPath)) {
    const value = fs.readFileSync(apiKeyPath, 'utf-8').trim();
    if (value.length > 0) {
      return `${API_KEY_ENV_VAR}=${value}\n\n`;
    }
  }

  // Fall back to OAuth token
  if (fs.existsSync(oauthPath)) {
    const value = fs.readFileSync(oauthPath, 'utf-8').trim();
    if (value.length > 0) {
      return `${OAUTH_TOKEN_ENV_VAR}=${value}\n\n`;
    }
  }

  return null;
}
