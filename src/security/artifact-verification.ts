/**
 * Release artifact verification library for Carapace.
 *
 * Provides reusable verification functions for:
 * - SHA-256 checksum verification (tarballs)
 * - Cosign signature verification (container images)
 * - Container image digest comparison (pinned config value)
 *
 * All functions return structured `VerificationResult` with pass/fail/warn
 * status, detail message, and actionable remediation on failure.
 *
 * Used by: install script (DEVOPS-16), update command (DX-09),
 * `carapace doctor` (DEVOPS-05).
 *
 * SEC-16
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of an artifact verification check. */
export interface VerificationResult {
  /** Check outcome. */
  status: 'pass' | 'fail' | 'warn';
  /** Detail message (hash values, error reason, etc.). */
  detail: string;
  /** Actionable fix suggestion (only present on failure/warning). */
  fix?: string;
}

/**
 * Injectable exec function for shelling out to cosign.
 *
 * Returns the exit code, stdout, and stderr of the process.
 * Throws on ENOENT (binary not found) or other exec errors.
 */
export type ExecFn = (
  file: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// computeSha256
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hash of a file.
 *
 * @param filePath - Absolute path to the file.
 * @returns Hex-encoded SHA-256 hash string.
 * @throws If the file does not exist or cannot be read.
 */
export function computeSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// verifySha256Checksum
// ---------------------------------------------------------------------------

/**
 * Verify a file's SHA-256 checksum against an expected value.
 *
 * @param filePath - Path to the file to verify.
 * @param expectedHash - Expected hex-encoded SHA-256 hash.
 * @returns Structured verification result.
 */
export function verifySha256Checksum(filePath: string, expectedHash: string): VerificationResult {
  if (!expectedHash) {
    return {
      status: 'fail',
      detail: 'Expected checksum is empty',
      fix: 'Provide a valid SHA-256 checksum from the release manifest',
    };
  }

  if (!existsSync(filePath)) {
    return {
      status: 'fail',
      detail: `File not found: ${filePath}`,
      fix: 'Re-download the artifact from the release page',
    };
  }

  let actualHash: string;
  try {
    actualHash = computeSha256(filePath);
  } catch (err) {
    return {
      status: 'fail',
      detail: `Failed to compute checksum: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Ensure the file is readable and try again',
    };
  }

  if (actualHash === expectedHash) {
    return {
      status: 'pass',
      detail: `SHA-256 verified: ${expectedHash.slice(0, 16)}...`,
    };
  }

  return {
    status: 'fail',
    detail:
      `Checksum mismatch — expected ${expectedHash.slice(0, 16)}..., ` +
      `got ${actualHash.slice(0, 16)}...`,
    fix: 'Re-download the artifact. If the mismatch persists, the release may have been tampered with.',
  };
}

// ---------------------------------------------------------------------------
// verifyCosignSignature
// ---------------------------------------------------------------------------

/**
 * Verify a container image's cosign signature.
 *
 * Shells out to `cosign verify` with keyless verification (Sigstore).
 * Handles missing cosign binary gracefully (returns warn, not fail).
 *
 * @param imageRef - Full image reference (e.g. `ghcr.io/org/image:tag`).
 * @param exec - Injectable exec function for testability.
 * @returns Structured verification result.
 */
export async function verifyCosignSignature(
  imageRef: string,
  exec: ExecFn,
): Promise<VerificationResult> {
  try {
    const { exitCode, stderr } = await exec('cosign', [
      'verify',
      '--certificate-identity-regexp',
      '.*',
      '--certificate-oidc-issuer-regexp',
      '.*',
      imageRef,
    ]);

    if (exitCode === 0) {
      return {
        status: 'pass',
        detail: `Cosign signature verified for ${imageRef}`,
      };
    }

    return {
      status: 'fail',
      detail: `Cosign signature verification failed: ${stderr.trim() || 'no matching signatures'}`,
      fix: 'The container image signature is invalid or missing. Re-pull the image from the official registry.',
    };
  } catch (err) {
    // Handle missing cosign binary gracefully
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'warn',
        detail: 'cosign binary not found — signature verification skipped',
        fix: 'Install cosign for container image signature verification: https://docs.sigstore.dev/cosign/system_config/installation/',
      };
    }

    return {
      status: 'fail',
      detail: `Cosign verification error: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Check cosign installation and try again',
    };
  }
}

// ---------------------------------------------------------------------------
// verifyImageDigest
// ---------------------------------------------------------------------------

/**
 * Compare a container image's actual digest against a pinned expected value.
 *
 * @param actualDigest - The digest of the pulled image (e.g. `sha256:abc...`).
 * @param expectedDigest - The pinned digest from config (e.g. `sha256:abc...`).
 * @returns Structured verification result.
 */
export function verifyImageDigest(
  actualDigest: string,
  expectedDigest: string,
): VerificationResult {
  if (!expectedDigest) {
    return {
      status: 'fail',
      detail: 'Pinned digest is missing — no expected value to compare against',
      fix: 'Set a pinned image digest in config.toml under [runtime] image field',
    };
  }

  if (!actualDigest) {
    return {
      status: 'fail',
      detail: 'Actual image digest is empty — could not determine pulled image digest',
      fix: 'Re-pull the container image and retry verification',
    };
  }

  if (actualDigest === expectedDigest) {
    return {
      status: 'pass',
      detail: `Image digest match: ${actualDigest}`,
    };
  }

  return {
    status: 'fail',
    detail: `Image digest mismatch — expected ${expectedDigest}, ` + `got ${actualDigest}`,
    fix: 'Re-pull the image from the official registry. If the mismatch persists, update the pinned digest with `carapace update`.',
  };
}
