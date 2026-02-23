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
 * - Only ONE credential is injected (API key via stdin)
 * - OAuth credentials are copied into the bind-mounted claude-state dir
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
export const OAUTH_CREDENTIALS_FILENAME = 'claude-credentials.json';

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

/** Extended filesystem interface that also supports writing (for OAuth prep). */
export interface CredentialPrepareFs extends CredentialFs {
  writeFileSync(path: string, data: string, opts: { mode: number }): void;
  renameSync(oldPath: string, newPath: string): void;
}

// ---------------------------------------------------------------------------
// Reader (API key only — stdin injection)
// ---------------------------------------------------------------------------

/**
 * Read stored API key and format it for container stdin injection.
 *
 * Only handles API keys. OAuth credentials are prepared separately
 * via {@link prepareOAuthCredentials} into the bind-mounted claude-state dir.
 *
 * @param credentialsDir - Absolute path to the credentials directory.
 * @param fs - Filesystem interface (injectable for testing).
 * @returns Formatted stdin data (`NAME=VALUE\n\n`) or null if no API key found.
 */
export function readCredentialStdin(credentialsDir: string, fs: CredentialFs): string | null {
  const apiKeyPath = `${credentialsDir}/${API_KEY_FILENAME}`;

  if (fs.existsSync(apiKeyPath)) {
    const value = fs.readFileSync(apiKeyPath, 'utf-8').trim();
    if (value.length > 0) {
      return `${API_KEY_ENV_VAR}=${value}\n\n`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// OAuth credential preparation (file-based — bind-mount injection)
// ---------------------------------------------------------------------------

/**
 * Copy OAuth credentials into the per-group claude-state directory.
 *
 * Reads `claude-credentials.json` from the credentials directory and writes
 * it atomically (temp file + rename) to `claudeStatePath/.credentials.json`
 * with mode 0600. Claude Code discovers this file naturally via the
 * bind-mounted `/home/node/.claude/` directory.
 *
 * @param credentialsDir - Absolute path to the credentials directory.
 * @param claudeStatePath - Absolute path to the per-group claude-state directory.
 * @param fs - Filesystem interface with write support.
 * @returns true if credentials were copied, false if source is missing or empty.
 */
export function prepareOAuthCredentials(
  credentialsDir: string,
  claudeStatePath: string,
  fs: CredentialPrepareFs,
): boolean {
  const sourcePath = `${credentialsDir}/${OAUTH_CREDENTIALS_FILENAME}`;

  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  const content = fs.readFileSync(sourcePath, 'utf-8');
  if (content.trim().length === 0) {
    return false;
  }

  const targetPath = `${claudeStatePath}/.credentials.json`;
  const tmpPath = `${targetPath}.tmp`;

  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, targetPath);

  return true;
}
