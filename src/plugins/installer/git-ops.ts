/**
 * GitOps interface and RealGitOps implementation for Carapace plugin installer.
 *
 * Provides a mockable abstraction over git CLI operations. RealGitOps
 * uses `child_process.execFile` (never `exec`) to avoid shell injection.
 * URL validation restricts protocols to https:// and git@ only.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// CloneOptions
// ---------------------------------------------------------------------------

export interface CloneOptions {
  /** Shallow clone depth (default 1). */
  depth?: number;
  /** Specific branch or tag to clone. */
  branch?: string;
  /** Clone only the specified branch (default true). */
  singleBranch?: boolean;
}

// ---------------------------------------------------------------------------
// GitOps interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over git CLI operations. Designed to be injectable and
 * mockable for downstream testing of the plugin installer.
 */
export interface GitOps {
  clone(url: string, destDir: string, opts?: CloneOptions): Promise<void>;
  fetch(repoDir: string): Promise<void>;
  checkout(repoDir: string, ref: string): Promise<void>;
  getRemoteUrl(repoDir: string): Promise<string>;
  getCurrentRef(repoDir: string): Promise<string>;
  getDefaultBranch(repoDir: string): Promise<string>;
  configUnset(repoDir: string, key: string): Promise<void>;
  configList(repoDir: string): Promise<Map<string, string>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum time (ms) for any single git operation. */
const GIT_TIMEOUT_MS = 60_000;

/** Maximum stdout/stderr buffer size per operation. */
const GIT_MAX_BUFFER = 1024 * 1024;

/**
 * Shell metacharacters that must never appear in git URLs.
 * Prevents argument injection even though execFile does not invoke a shell.
 */
const SHELL_METACHARACTERS = /[;|&$`(){}\n\r]/;

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Validate a git URL. Only `https://` and `git@` protocols are allowed.
 * Rejects `file://`, `http://`, `ftp://`, and URLs containing shell
 * metacharacters.
 *
 * @throws Error if the URL is invalid or uses a disallowed protocol.
 */
export function validateGitUrl(url: string): void {
  if (!url || typeof url !== 'string') {
    throw new Error('Git URL must be a non-empty string');
  }

  // Check for shell metacharacters first (security-critical)
  if (SHELL_METACHARACTERS.test(url)) {
    throw new Error(`Git URL contains disallowed characters: ${url}`);
  }

  // Protocol allowlist
  const isHttps = url.startsWith('https://');
  const isGitSsh = url.startsWith('git@');

  if (!isHttps && !isGitSsh) {
    throw new Error(`Git URL must use https:// or git@ protocol, got: ${url}`);
  }
}

// ---------------------------------------------------------------------------
// RealGitOps
// ---------------------------------------------------------------------------

/**
 * Production implementation of GitOps using `child_process.execFile`.
 *
 * Security properties:
 * - Uses execFile (not exec) — no shell interpretation of arguments
 * - URL validation rejects file://, http://, ftp://, and metacharacters
 * - Git hooks are disabled via --config core.hooksPath=/dev/null on clone
 * - Symlinks are disabled via --config core.symlinks=false on clone
 * - 60s timeout and 1MB buffer limit per operation
 */
export class RealGitOps implements GitOps {
  async clone(url: string, destDir: string, opts?: CloneOptions): Promise<void> {
    validateGitUrl(url);

    const depth = opts?.depth ?? 1;
    const singleBranch = opts?.singleBranch ?? true;

    const args: string[] = [
      'clone',
      `--depth=${depth}`,
      '--config',
      'core.hooksPath=/dev/null',
      '--config',
      'core.symlinks=false',
    ];

    if (singleBranch) {
      args.push('--single-branch');
    }

    if (opts?.branch) {
      args.push('--branch', opts.branch);
    }

    args.push(url, destDir);

    await this.run(args);
  }

  async fetch(repoDir: string): Promise<void> {
    await this.run(['fetch'], repoDir);
  }

  async checkout(repoDir: string, ref: string): Promise<void> {
    await this.run(['checkout', ref], repoDir);
  }

  async getRemoteUrl(repoDir: string): Promise<string> {
    const { stdout } = await this.run(['remote', 'get-url', 'origin'], repoDir);
    return stdout.trim();
  }

  async getCurrentRef(repoDir: string): Promise<string> {
    const { stdout } = await this.run(['rev-parse', 'HEAD'], repoDir);
    return stdout.trim();
  }

  async getDefaultBranch(repoDir: string): Promise<string> {
    const { stdout } = await this.run(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoDir);
    // Output is like "refs/remotes/origin/main" — extract last segment
    const trimmed = stdout.trim();
    const parts = trimmed.split('/');
    return parts[parts.length - 1]!;
  }

  async configUnset(repoDir: string, key: string): Promise<void> {
    await this.run(['config', '--unset', key], repoDir);
  }

  async configList(repoDir: string): Promise<Map<string, string>> {
    const { stdout } = await this.run(['config', '--list'], repoDir);
    const result = new Map<string, string>();

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const key = trimmed.substring(0, eqIdx);
      const value = trimmed.substring(eqIdx + 1);
      result.set(key, value);
    }

    return result;
  }

  /**
   * Execute a git command via execFile with timeout and buffer limits.
   *
   * @param args - Arguments to pass to git
   * @param cwd - Working directory (optional, used for repo-scoped commands)
   * @returns stdout and stderr
   * @throws Error with git stderr on failure
   */
  private async run(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFile('git', args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException & {
        stderr?: string;
        stdout?: string;
        killed?: boolean;
      };

      if (error.killed) {
        throw new Error(`Git operation timed out after ${GIT_TIMEOUT_MS}ms: git ${args.join(' ')}`);
      }

      const stderr = error.stderr ?? error.message ?? 'Unknown git error';
      throw new Error(`Git command failed: git ${args.join(' ')}\n${stderr}`);
    }
  }
}
