/**
 * Git repository sanitizer for the Carapace plugin installer.
 *
 * After cloning a plugin repository, sanitizeClonedRepo() removes git hooks,
 * strips dangerous config keys, rejects repos with submodules, and detects
 * symlinks in the working tree. This hardens cloned repos before the
 * installer copies plugin files into the trusted host environment.
 *
 * All filesystem and git operations use injectable interfaces so that
 * unit tests never touch the real filesystem or invoke git.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

/**
 * Filesystem abstraction for sanitizer operations. Allows unit tests
 * to inject mocks instead of using the real filesystem.
 */
export interface SanitizerFs {
  readdir(dir: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  access(path: string): Promise<boolean>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
}

/**
 * Git operations abstraction for sanitizer. Uses a subset of the
 * GitOps interface — only configList and configUnset are needed.
 */
export interface SanitizerGit {
  configList(repoDir: string): Promise<Map<string, string>>;
  configUnset(repoDir: string, key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// SanitizationResult
// ---------------------------------------------------------------------------

/**
 * Result of sanitizing a cloned repository. Callers should check
 * `rejected` — if true, the repo must not be installed and
 * `rejectionReasons` explains why.
 */
export interface SanitizationResult {
  hooksRemoved: number;
  configKeysStripped: string[];
  rejected: boolean;
  rejectionReasons: string[];
}

// ---------------------------------------------------------------------------
// Dangerous config key patterns
// ---------------------------------------------------------------------------

/**
 * Exact config keys that are dangerous and must be stripped.
 */
const DANGEROUS_EXACT_KEYS: ReadonlySet<string> = new Set([
  'core.fsmonitor',
  'core.hookspath',
  'core.sshcommand',
  'core.pager',
  'core.editor',
  'diff.external',
  'credential.helper',
]);

/**
 * Regex patterns for dangerous config keys that use wildcard subsections.
 * filter.*.clean, filter.*.smudge, filter.*.process — any filter subsection
 * with these specific leaf keys.
 */
const DANGEROUS_PATTERN_KEYS: ReadonlyArray<RegExp> = [
  /^filter\.[^.]+\.clean$/,
  /^filter\.[^.]+\.smudge$/,
  /^filter\.[^.]+\.process$/,
];

/**
 * Check whether a git config key is dangerous and should be stripped.
 * Comparison is case-insensitive because git config keys are case-insensitive.
 */
function isDangerousConfigKey(key: string): boolean {
  const lower = key.toLowerCase();

  if (DANGEROUS_EXACT_KEYS.has(lower)) {
    return true;
  }

  for (const pattern of DANGEROUS_PATTERN_KEYS) {
    if (pattern.test(lower)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// sanitizeClonedRepo
// ---------------------------------------------------------------------------

/**
 * Sanitize a freshly cloned git repository by removing hooks, stripping
 * dangerous config, rejecting submodules, and detecting symlinks.
 *
 * @param repoDir - Absolute path to the cloned repository root
 * @param fsOps - Injectable filesystem operations
 * @param git - Injectable git operations
 * @returns SanitizationResult describing what was done and whether the repo is rejected
 */
export async function sanitizeClonedRepo(
  repoDir: string,
  fsOps: SanitizerFs,
  git: SanitizerGit,
): Promise<SanitizationResult> {
  const result: SanitizationResult = {
    hooksRemoved: 0,
    configKeysStripped: [],
    rejected: false,
    rejectionReasons: [],
  };

  // Phase 1: Remove hooks
  await removeHooks(repoDir, fsOps, result);

  // Phase 2: Scan and strip dangerous git config
  await stripDangerousConfig(repoDir, git, result);

  // Phase 3: Reject .gitmodules
  await rejectGitmodules(repoDir, fsOps, result);

  // Phase 4: Scan for symlinks
  await scanForSymlinks(repoDir, fsOps, result);

  return result;
}

// ---------------------------------------------------------------------------
// Phase 1: Remove hooks
// ---------------------------------------------------------------------------

async function removeHooks(
  repoDir: string,
  fsOps: SanitizerFs,
  result: SanitizationResult,
): Promise<void> {
  const hooksDir = path.join(repoDir, '.git', 'hooks');

  let entries: string[];
  try {
    entries = await fsOps.readdir(hooksDir);
  } catch {
    // Hooks directory doesn't exist or isn't readable — nothing to do
    return;
  }

  for (const entry of entries) {
    const hookPath = path.join(hooksDir, entry);
    await fsOps.unlink(hookPath);
    result.hooksRemoved++;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Strip dangerous git config
// ---------------------------------------------------------------------------

async function stripDangerousConfig(
  repoDir: string,
  git: SanitizerGit,
  result: SanitizationResult,
): Promise<void> {
  const config = await git.configList(repoDir);

  for (const [key] of config) {
    if (isDangerousConfigKey(key)) {
      await git.configUnset(repoDir, key);
      result.configKeysStripped.push(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Reject .gitmodules
// ---------------------------------------------------------------------------

async function rejectGitmodules(
  repoDir: string,
  fsOps: SanitizerFs,
  result: SanitizationResult,
): Promise<void> {
  const gitmodulesPath = path.join(repoDir, '.gitmodules');
  const exists = await fsOps.access(gitmodulesPath);

  if (exists) {
    result.rejected = true;
    result.rejectionReasons.push('Repository contains .gitmodules (submodules not allowed)');
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Scan for symlinks
// ---------------------------------------------------------------------------

async function scanForSymlinks(
  repoDir: string,
  fsOps: SanitizerFs,
  result: SanitizationResult,
): Promise<void> {
  const symlinks = await findSymlinksRecursive(repoDir, repoDir, fsOps);

  if (symlinks.length > 0) {
    result.rejected = true;
    const paths = symlinks.map((s) => path.relative(repoDir, s)).join(', ');
    result.rejectionReasons.push(`Repository contains symlinks: ${paths}`);
  }
}

/**
 * Recursively walk a directory tree, skipping .git/, and collect
 * paths that are symbolic links.
 */
async function findSymlinksRecursive(
  rootDir: string,
  currentDir: string,
  fsOps: SanitizerFs,
): Promise<string[]> {
  const symlinks: string[] = [];

  let entries: string[];
  try {
    entries = await fsOps.readdir(currentDir);
  } catch {
    return symlinks;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry);

    // Skip the .git directory at the repo root
    if (currentDir === rootDir && entry === '.git') {
      continue;
    }

    const stat = await fsOps.lstat(fullPath);

    if (stat.isSymbolicLink()) {
      symlinks.push(fullPath);
    } else {
      // Recurse into subdirectories (non-symlink only)
      // We attempt readdir; if it fails (because it's a file), we just skip
      const nested = await findSymlinksRecursive(rootDir, fullPath, fsOps);
      symlinks.push(...nested);
    }
  }

  return symlinks;
}

// ---------------------------------------------------------------------------
// RealSanitizerFs
// ---------------------------------------------------------------------------

/**
 * Production implementation of SanitizerFs wrapping Node.js fs/promises.
 */
export class RealSanitizerFs implements SanitizerFs {
  async readdir(dir: string): Promise<string[]> {
    return fs.readdir(dir);
  }

  async unlink(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  async access(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async lstat(filePath: string): Promise<{ isSymbolicLink(): boolean }> {
    return fs.lstat(filePath);
  }
}
