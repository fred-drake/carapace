/**
 * Credential directory security model for Carapace.
 *
 * Enforces security invariants on the `$CARAPACE_HOME/credentials/` directory:
 * - Directory permissions: 0700 (owner-only)
 * - File permissions: 0600 (owner-only read/write)
 * - No symlinks (directory or file level)
 * - Ownership validation (must be current user)
 * - Root warning
 * - Doctor integration via HealthCheckResult
 *
 * Verification runs on every startup (not just install) to detect
 * post-installation permission drift or tampering.
 *
 * SEC-18
 */

import {
  existsSync,
  statSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import type { HealthCheckResult } from '../core/health-checks.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Required permission mode for the credentials directory. */
export const CREDENTIAL_DIR_MODE = 0o700;

/** Required permission mode for credential files. */
export const CREDENTIAL_FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of verifying the credential directory security posture. */
export interface CredentialDirVerification {
  /** Whether the directory passes all security checks. */
  valid: boolean;
  /** List of security issues found. */
  issues: string[];
  /** Octal permission mode of the directory (or null if not found). */
  dirMode: number | null;
  /** Whether the directory is owned by the current process user. */
  ownedByCurrentUser: boolean;
}

// ---------------------------------------------------------------------------
// verifyCredentialDirectory
// ---------------------------------------------------------------------------

/**
 * Verify the security posture of the credential directory.
 *
 * Checks:
 * 1. Directory exists and is a real directory (not a symlink)
 * 2. Directory permissions are exactly 0700
 * 3. Directory is owned by the current user
 * 4. All files within have 0600 permissions
 * 5. No symlinks inside the directory
 * 6. Nested subdirectories also have 0700 permissions
 */
export function verifyCredentialDirectory(credDir: string): CredentialDirVerification {
  const issues: string[] = [];
  let dirMode: number | null = null;
  let ownedByCurrentUser = false;

  // Check existence
  if (!existsSync(credDir)) {
    return {
      valid: false,
      issues: ['Credential directory does not exist: ' + credDir],
      dirMode: null,
      ownedByCurrentUser: false,
    };
  }

  // Check it's not a symlink (use lstat to detect symlinks)
  const lstat = lstatSync(credDir);
  if (lstat.isSymbolicLink()) {
    return {
      valid: false,
      issues: ['Credential directory is a symlink — symlinks are not allowed for security'],
      dirMode: null,
      ownedByCurrentUser: false,
    };
  }

  // Check it's actually a directory
  if (!lstat.isDirectory()) {
    return {
      valid: false,
      issues: ['Credential path is not a directory: ' + credDir],
      dirMode: null,
      ownedByCurrentUser: false,
    };
  }

  // Check directory permissions
  dirMode = lstat.mode & 0o777;
  if (dirMode !== CREDENTIAL_DIR_MODE) {
    issues.push(
      `Credential directory has insecure permission mode ${octal(dirMode)} ` +
        `(expected ${octal(CREDENTIAL_DIR_MODE)})`,
    );
  }

  // Check ownership
  ownedByCurrentUser = lstat.uid === process.getuid?.();
  if (!ownedByCurrentUser) {
    issues.push(
      `Credential directory is not owned by the current user ` +
        `(uid ${lstat.uid}, expected ${process.getuid?.()})`,
    );
  }

  // Scan contents recursively
  scanDirectory(credDir, credDir, issues);

  return {
    valid: issues.length === 0,
    issues,
    dirMode,
    ownedByCurrentUser,
  };
}

/**
 * Recursively scan a directory for permission and symlink issues.
 */
function scanDirectory(baseDir: string, dir: string, issues: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = fullPath.slice(baseDir.length + 1);
    const entryLstat = lstatSync(fullPath);

    // Reject symlinks
    if (entryLstat.isSymbolicLink()) {
      issues.push(`Credential entry "${relativePath}" is a symlink — symlinks are not allowed`);
      continue;
    }

    if (entryLstat.isFile()) {
      // Check file permissions
      const fileMode = entryLstat.mode & 0o777;
      if (fileMode !== CREDENTIAL_FILE_MODE) {
        issues.push(
          `Credential file "${relativePath}" has insecure permission mode ${octal(fileMode)} ` +
            `(expected ${octal(CREDENTIAL_FILE_MODE)})`,
        );
      }
    } else if (entryLstat.isDirectory()) {
      // Check subdirectory permissions (must also be 0700)
      const subDirMode = entryLstat.mode & 0o777;
      if (subDirMode !== CREDENTIAL_DIR_MODE) {
        issues.push(
          `Credential subdirectory "${relativePath}" has insecure permission mode ${octal(subDirMode)} ` +
            `(expected ${octal(CREDENTIAL_DIR_MODE)})`,
        );
      }
      // Recurse into subdirectory
      scanDirectory(baseDir, fullPath, issues);
    }
  }
}

/** Format a mode as an octal string (e.g. "0755"). */
function octal(mode: number): string {
  return '0' + mode.toString(8);
}

// ---------------------------------------------------------------------------
// writeCredentialFile
// ---------------------------------------------------------------------------

/**
 * Write a credential file with secure permissions (0600).
 *
 * Security checks:
 * - Rejects paths that resolve outside the credential directory
 * - Rejects writing through symlinks
 * - Sets file permissions to 0600 after write
 *
 * @param filePath - Absolute path to the credential file.
 * @param content - The credential content to write.
 * @param credDir - Optional credential directory root for containment validation.
 */
export function writeCredentialFile(filePath: string, content: string, credDir?: string): void {
  const resolved = resolve(filePath);

  // Reject path traversal — resolved path must be inside credDir
  if (credDir) {
    const resolvedRoot = resolve(credDir);
    if (!resolved.startsWith(resolvedRoot + '/') && resolved !== resolvedRoot) {
      throw new Error(
        `Path traversal detected: "${filePath}" resolves outside credential directory "${credDir}"`,
      );
    }
  }

  // Reject writing through symlinks
  if (existsSync(resolved)) {
    const entryLstat = lstatSync(resolved);
    if (entryLstat.isSymbolicLink()) {
      throw new Error(`Refusing to write credential file through symlink: ${filePath}`);
    }
  }

  writeFileSync(resolved, content, { mode: CREDENTIAL_FILE_MODE });
  // Explicit chmod to ensure mode is applied (umask can interfere)
  chmodSync(resolved, CREDENTIAL_FILE_MODE);
}

// ---------------------------------------------------------------------------
// readCredentialFile
// ---------------------------------------------------------------------------

/**
 * Read a credential file, rejecting symlinks.
 *
 * @param filePath - Absolute path to the credential file.
 * @returns The credential content.
 */
export function readCredentialFile(filePath: string): string {
  const resolved = resolve(filePath);

  if (!existsSync(resolved)) {
    throw new Error(`Credential file not found: ${filePath}`);
  }

  const entryLstat = lstatSync(resolved);
  if (entryLstat.isSymbolicLink()) {
    throw new Error(`Refusing to read credential file through symlink: ${filePath}`);
  }

  return readFileSync(resolved, 'utf-8');
}

// ---------------------------------------------------------------------------
// checkCredentialSecurity (doctor integration)
// ---------------------------------------------------------------------------

/**
 * Health check for credential directory security.
 *
 * Returns a `HealthCheckResult` compatible with the doctor system
 * (DEVOPS-05). Checks directory existence, permissions, file permissions,
 * and symlink presence.
 */
export function checkCredentialSecurity(credDir: string): HealthCheckResult {
  const verification = verifyCredentialDirectory(credDir);

  if (verification.valid) {
    return {
      name: 'credential-dir',
      label: 'Credential directory',
      status: 'pass',
      detail: `Permissions ${octal(verification.dirMode!)} — all files secure`,
    };
  }

  return {
    name: 'credential-dir',
    label: 'Credential directory',
    status: 'fail',
    detail: verification.issues.join('; '),
    fix: `Fix with: chmod 700 ${credDir} && find ${credDir} -type f -exec chmod 600 {} +`,
  };
}

// ---------------------------------------------------------------------------
// checkRunningAsRoot
// ---------------------------------------------------------------------------

/**
 * Health check that warns if the process is running as root.
 *
 * Running Carapace as root is a security risk because the credential
 * directory ownership becomes root-owned, and container escape gains
 * full system privileges.
 *
 * @param uid - The effective user ID (typically from `process.getuid()`).
 */
export function checkRunningAsRoot(uid: number): HealthCheckResult {
  if (uid === 0) {
    return {
      name: 'root-check',
      label: 'Running as non-root',
      status: 'warn',
      detail: 'Carapace is running as root — this is a security risk',
      fix: 'Run Carapace as a non-root user to limit credential exposure and container escape risk',
    };
  }

  return {
    name: 'root-check',
    label: 'Running as non-root',
    status: 'pass',
    detail: `Running as uid ${uid}`,
  };
}
