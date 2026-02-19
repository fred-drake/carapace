/**
 * Carapace auth CLI commands.
 *
 * Provides three subcommands:
 *   - `carapace auth api-key`  — Prompt, validate, and store an Anthropic API key.
 *   - `carapace auth login`    — Guide OAuth token setup and store the token.
 *   - `carapace auth status`   — Show credential state without leaking values.
 *
 * Credentials are stored at `$CARAPACE_HOME/credentials/` with 0600 permissions.
 * API key takes precedence over OAuth token when both are present.
 */

import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_KEY_FILENAME = 'anthropic-api-key';
const OAUTH_TOKEN_FILENAME = 'claude-oauth-token';
const FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of API key validation. */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/** File stat information for credential files. */
export interface CredentialInfo {
  mtime: Date;
}

/** Injectable dependencies for auth commands. */
export interface AuthDeps {
  /** Write to stdout. */
  stdout: (msg: string) => void;
  /** Write to stderr. */
  stderr: (msg: string) => void;
  /** Resolved CARAPACE_HOME path. */
  home: string;
  /** Prompt for a secret value (masked input). */
  promptSecret: (prompt: string) => Promise<string>;
  /** Prompt for a string value (visible input). */
  promptString: (prompt: string) => Promise<string>;
  /** Validate an Anthropic API key (e.g. lightweight API call). */
  validateApiKey: (key: string) => Promise<ValidationResult>;
  /** Check if a file exists. */
  fileExists: (path: string) => boolean;
  /** Read file contents as string. */
  readFile: (path: string) => string;
  /** Write file with specific permissions. */
  writeFileSecure: (path: string, content: string, mode: number) => void;
  /** Get file modification time, or null if file doesn't exist. */
  fileStat: (path: string) => CredentialInfo | null;
}

// ---------------------------------------------------------------------------
// auth api-key
// ---------------------------------------------------------------------------

/**
 * Prompt for an Anthropic API key, validate it, and store it.
 *
 * @returns Exit code (0 = success, 1 = failure).
 */
export async function runAuthApiKey(deps: AuthDeps): Promise<number> {
  const credPath = path.join(deps.home, 'credentials', API_KEY_FILENAME);

  // Warn about existing key
  if (deps.fileExists(credPath)) {
    deps.stderr('Warning: An existing API key will be overwritten.');
  }

  // Prompt
  const key = await deps.promptSecret('Enter your Anthropic API key:');
  if (!key || key.trim().length === 0) {
    deps.stderr('No API key provided. Aborting.');
    return 1;
  }

  const trimmed = key.trim();

  // Validate
  const result = await deps.validateApiKey(trimmed);
  if (!result.valid) {
    deps.stderr(`API key validation failed: ${result.error ?? 'Invalid API key'}`);
    return 1;
  }

  // Store
  deps.writeFileSecure(credPath, trimmed, FILE_MODE);
  deps.stdout('API key configured and stored.');

  return 0;
}

// ---------------------------------------------------------------------------
// auth login
// ---------------------------------------------------------------------------

/**
 * Guide the user through OAuth token setup and store the token.
 *
 * @returns Exit code (0 = success, 1 = failure).
 */
export async function runAuthLogin(deps: AuthDeps): Promise<number> {
  const credPath = path.join(deps.home, 'credentials', OAUTH_TOKEN_FILENAME);

  deps.stdout('OAuth Token Setup');
  deps.stdout('');
  deps.stdout('To get your Claude OAuth token:');
  deps.stdout('  1. Open a new terminal');
  deps.stdout('  2. Run: claude setup-token');
  deps.stdout('  3. Follow the prompts to authenticate');
  deps.stdout('  4. Copy the resulting token');
  deps.stdout('');

  const token = await deps.promptString('Paste your OAuth token:');
  if (!token || token.trim().length === 0) {
    deps.stderr('No token provided. Aborting.');
    return 1;
  }

  const trimmed = token.trim();

  // Store
  deps.writeFileSecure(credPath, trimmed, FILE_MODE);
  deps.stdout('OAuth token configured and stored.');

  return 0;
}

// ---------------------------------------------------------------------------
// auth status
// ---------------------------------------------------------------------------

/**
 * Show credential status without leaking values.
 *
 * @returns Exit code (0 = success).
 */
export async function runAuthStatus(deps: AuthDeps): Promise<number> {
  const apiKeyPath = path.join(deps.home, 'credentials', API_KEY_FILENAME);
  const oauthPath = path.join(deps.home, 'credentials', OAUTH_TOKEN_FILENAME);

  const hasApiKey = deps.fileExists(apiKeyPath);
  const hasOAuth = deps.fileExists(oauthPath);

  if (!hasApiKey && !hasOAuth) {
    deps.stdout('No credentials configured.');
    deps.stdout('');
    deps.stdout('Run one of:');
    deps.stdout('  carapace auth api-key   Set up an Anthropic API key');
    deps.stdout('  carapace auth login     Set up an OAuth token');
    return 0;
  }

  deps.stdout('Credential Status:');
  deps.stdout('');

  if (hasApiKey) {
    const masked = maskApiKey(deps.readFile(apiKeyPath));
    const stat = deps.fileStat(apiKeyPath);
    const updated = stat ? stat.mtime.toISOString().split('T')[0] : 'unknown';
    const active = hasApiKey ? ' (active — takes precedence)' : '';
    deps.stdout(`  Anthropic API Key: ${masked}${active}`);
    deps.stdout(`    Last updated: ${updated}`);
  }

  if (hasOAuth) {
    const stat = deps.fileStat(oauthPath);
    const updated = stat ? stat.mtime.toISOString().split('T')[0] : 'unknown';
    const active = hasApiKey ? '' : ' (active)';
    deps.stdout(`  OAuth Token: configured${active}`);
    deps.stdout(`    Last updated: ${updated}`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mask an API key to show only the prefix. */
function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '***';

  // Show prefix through "sk-ant-" + ***
  return trimmed.slice(0, 7) + '***';
}
