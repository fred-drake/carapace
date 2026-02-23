/**
 * Carapace auth CLI commands.
 *
 * Provides three subcommands:
 *   - `carapace auth api-key`  — Prompt, validate, and store an Anthropic API key.
 *   - `carapace auth login`    — Copy host's Claude OAuth credentials for container use.
 *   - `carapace auth status`   — Show credential state without leaking values.
 *
 * Credentials are stored at `$CARAPACE_HOME/credentials/` with 0600 permissions.
 * API key takes precedence over OAuth credentials when both are present.
 */

import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_KEY_FILENAME = 'anthropic-api-key';
const OAUTH_CREDENTIALS_FILENAME = 'claude-credentials.json';
const LEGACY_OAUTH_TOKEN_FILENAME = 'claude-oauth-token';
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
  /** User's home directory (e.g. /Users/fdrake). */
  userHome: string;
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
 * Copy the host's Claude OAuth credentials for container use.
 *
 * Reads `~/.claude/.credentials.json` (written by `claude login`) and copies
 * it to `$CARAPACE_HOME/credentials/claude-credentials.json`. This file is
 * later copied into the per-group claude-state directory before each container
 * spawn, so Claude Code finds its credentials naturally.
 *
 * @returns Exit code (0 = success, 1 = failure).
 */
export async function runAuthLogin(deps: AuthDeps): Promise<number> {
  const sourcePath = path.join(deps.userHome, '.claude', '.credentials.json');
  const targetPath = path.join(deps.home, 'credentials', OAUTH_CREDENTIALS_FILENAME);

  if (!deps.fileExists(sourcePath)) {
    deps.stderr('No Claude OAuth credentials found.');
    deps.stderr('');
    deps.stderr('Run `claude login` first to authenticate with Claude Code,');
    deps.stderr(`then re-run \`carapace auth login\` to import the credentials.`);
    return 1;
  }

  const content = deps.readFile(sourcePath);
  if (!content || content.trim().length === 0) {
    deps.stderr('Claude credentials file is empty. Run `claude login` to re-authenticate.');
    return 1;
  }

  // Store
  deps.writeFileSecure(targetPath, content, FILE_MODE);
  deps.stdout('OAuth credentials imported from ~/.claude/.credentials.json');

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
  const oauthCredsPath = path.join(deps.home, 'credentials', OAUTH_CREDENTIALS_FILENAME);
  const legacyOauthPath = path.join(deps.home, 'credentials', LEGACY_OAUTH_TOKEN_FILENAME);

  const hasApiKey = deps.fileExists(apiKeyPath);
  const hasOAuthCreds = deps.fileExists(oauthCredsPath);
  const hasLegacyOAuth = deps.fileExists(legacyOauthPath);

  if (!hasApiKey && !hasOAuthCreds && !hasLegacyOAuth) {
    deps.stdout('No credentials configured.');
    deps.stdout('');
    deps.stdout('Run one of:');
    deps.stdout('  carapace auth api-key   Set up an Anthropic API key');
    deps.stdout('  carapace auth login     Import OAuth credentials');
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

  if (hasOAuthCreds) {
    const stat = deps.fileStat(oauthCredsPath);
    const updated = stat ? stat.mtime.toISOString().split('T')[0] : 'unknown';
    const active = hasApiKey ? '' : ' (active)';

    // Try to parse expiresAt from the credentials JSON
    let expiryInfo = '';
    try {
      const content = deps.readFile(oauthCredsPath);
      const parsed = JSON.parse(content) as { expiresAt?: string };
      if (parsed.expiresAt) {
        const expiresAt = new Date(parsed.expiresAt);
        const now = new Date();
        if (expiresAt > now) {
          const hoursLeft = Math.round((expiresAt.getTime() - now.getTime()) / 3_600_000);
          expiryInfo = ` (expires in ~${hoursLeft}h)`;
        } else {
          expiryInfo = ' (expired — run `carapace auth login` to refresh)';
        }
      }
    } catch {
      // Non-fatal — just skip expiry info
    }

    deps.stdout(`  OAuth Credentials: configured${active}${expiryInfo}`);
    deps.stdout(`    Last updated: ${updated}`);
  }

  if (hasLegacyOAuth) {
    deps.stderr('');
    deps.stderr('  Warning: Legacy OAuth token file detected (claude-oauth-token).');
    deps.stderr('  Run `carapace auth login` to migrate to the new credentials format.');
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
