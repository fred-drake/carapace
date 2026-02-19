/**
 * GPG signing and verification for Carapace releases.
 *
 * Provides:
 * - {@link signFileGpg} — Create a detached ASCII-armored GPG signature.
 * - {@link verifyGpgSignature} — Verify a detached GPG signature.
 * - {@link exportPublicKey} — Export a GPG public key for publishing.
 * - {@link isGpgAvailable} — Check if the gpg binary is installed.
 *
 * All functions use injectable {@link GpgDeps} for testability. The verify
 * function returns `warn` (not `fail`) when gpg is absent — cosign is the
 * primary verification method; GPG is a supplemental check.
 *
 * SEC-20
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injectable dependencies for GPG operations. */
export interface GpgDeps {
  /** Execute a command and return exit code + output. */
  exec: (
    file: string,
    args: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Check if a file exists. */
  fileExists: (path: string) => boolean;
}

/** Result of signing a file with GPG. */
export interface GpgSignResult {
  /** Outcome: pass = signed, fail = error. */
  status: 'pass' | 'fail';
  /** Detail message. */
  detail: string;
  /** Path to the generated .asc signature file (only on pass). */
  signaturePath?: string;
  /** Remediation hint (only on fail). */
  fix?: string;
}

/** Result of verifying a GPG signature. */
export interface GpgVerifyResult {
  /** Outcome: pass = good signature, fail = bad/missing, warn = gpg absent. */
  status: 'pass' | 'fail' | 'warn';
  /** Detail message. */
  detail: string;
  /** Remediation hint (only on fail/warn). */
  fix?: string;
}

/** Result of exporting a public key. */
export interface GpgExportResult {
  /** Outcome: pass = exported, fail = error. */
  status: 'pass' | 'fail';
  /** Detail message. */
  detail: string;
  /** The ASCII-armored public key block (only on pass). */
  publicKey?: string;
  /** Remediation hint (only on fail). */
  fix?: string;
}

// ---------------------------------------------------------------------------
// signFileGpg
// ---------------------------------------------------------------------------

/**
 * Create a detached ASCII-armored GPG signature for a file.
 *
 * Produces `<filePath>.asc` alongside the original file.
 *
 * @param filePath - Absolute path to the file to sign.
 * @param keyId - GPG key ID or email to sign with.
 * @param deps - Injectable dependencies.
 */
export async function signFileGpg(
  filePath: string,
  keyId: string,
  deps: GpgDeps,
): Promise<GpgSignResult> {
  if (!deps.fileExists(filePath)) {
    return {
      status: 'fail',
      detail: `File not found: ${filePath}`,
      fix: 'Ensure the release tarball exists before signing.',
    };
  }

  try {
    const { exitCode, stderr } = await deps.exec('gpg', [
      '--batch',
      '--detach-sign',
      '--armor',
      '--local-user',
      keyId,
      filePath,
    ]);

    if (exitCode === 0) {
      return {
        status: 'pass',
        detail: `GPG signature created for ${filePath}`,
        signaturePath: `${filePath}.asc`,
      };
    }

    return {
      status: 'fail',
      detail: `GPG signing failed: ${stderr.trim() || 'unknown error'}`,
      fix: `Ensure the GPG key "${keyId}" is available in the keyring and has no passphrase (for CI), or use gpg-agent.`,
    };
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'fail',
        detail: 'gpg binary not found',
        fix: 'Install GnuPG: https://gnupg.org/download/',
      };
    }

    return {
      status: 'fail',
      detail: `GPG signing error: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Check gpg installation and key availability.',
    };
  }
}

// ---------------------------------------------------------------------------
// verifyGpgSignature
// ---------------------------------------------------------------------------

/**
 * Verify a detached GPG signature against a file.
 *
 * Returns `warn` (not `fail`) when gpg is absent, since cosign is the
 * primary verification method and GPG is supplemental.
 *
 * @param filePath - Path to the file that was signed.
 * @param signaturePath - Path to the detached .asc signature.
 * @param deps - Injectable dependencies.
 */
export async function verifyGpgSignature(
  filePath: string,
  signaturePath: string,
  deps: GpgDeps,
): Promise<GpgVerifyResult> {
  if (!deps.fileExists(filePath)) {
    return {
      status: 'fail',
      detail: `File not found: ${filePath}`,
      fix: 'Re-download the release artifact.',
    };
  }

  if (!deps.fileExists(signaturePath)) {
    return {
      status: 'fail',
      detail: `Signature file not found: ${signaturePath}`,
      fix: 'Download the .asc signature file from the release page.',
    };
  }

  try {
    const { exitCode, stderr } = await deps.exec('gpg', [
      '--batch',
      '--verify',
      signaturePath,
      filePath,
    ]);

    if (exitCode === 0) {
      return {
        status: 'pass',
        detail: `GPG signature verified: ${stderr.trim() || 'Good signature'}`,
      };
    }

    return {
      status: 'fail',
      detail: `GPG signature verification failed: ${stderr.trim() || 'bad signature'}`,
      fix: 'The GPG signature is invalid. Re-download the release and signature from the official release page.',
    };
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'warn',
        detail: 'gpg binary not found — GPG signature verification skipped',
        fix: 'Install GPG for signature verification: https://gnupg.org/download/',
      };
    }

    return {
      status: 'fail',
      detail: `GPG verification error: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Check gpg installation and try again.',
    };
  }
}

// ---------------------------------------------------------------------------
// exportPublicKey
// ---------------------------------------------------------------------------

/**
 * Export a GPG public key in ASCII-armored format.
 *
 * Used to publish the project signing key in the repository and on keyservers.
 *
 * @param keyId - GPG key ID or email to export.
 * @param deps - Injectable dependencies.
 */
export async function exportPublicKey(keyId: string, deps: GpgDeps): Promise<GpgExportResult> {
  try {
    const { exitCode, stdout, stderr } = await deps.exec('gpg', ['--export', '--armor', keyId]);

    if (exitCode !== 0) {
      return {
        status: 'fail',
        detail: `GPG key export failed: ${stderr.trim() || 'key not found or nothing exported'}`,
        fix: `Ensure the key "${keyId}" exists in the keyring: gpg --list-keys ${keyId}`,
      };
    }

    if (!stdout || stdout.trim().length === 0) {
      return {
        status: 'fail',
        detail: `No key data exported for "${keyId}" — empty output`,
        fix: `Ensure the key "${keyId}" exists in the keyring: gpg --list-keys ${keyId}`,
      };
    }

    return {
      status: 'pass',
      detail: `Public key exported for "${keyId}"`,
      publicKey: stdout,
    };
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'fail',
        detail: 'gpg binary not found',
        fix: 'Install GnuPG: https://gnupg.org/download/',
      };
    }

    return {
      status: 'fail',
      detail: `GPG export error: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Check gpg installation and try again.',
    };
  }
}

// ---------------------------------------------------------------------------
// isGpgAvailable
// ---------------------------------------------------------------------------

/**
 * Check whether the gpg binary is installed and functional.
 */
export async function isGpgAvailable(deps: GpgDeps): Promise<boolean> {
  try {
    const { exitCode } = await deps.exec('gpg', ['--version']);
    return exitCode === 0;
  } catch {
    return false;
  }
}
