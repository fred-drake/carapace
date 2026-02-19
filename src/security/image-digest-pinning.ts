/**
 * Container image digest pinning for Carapace.
 *
 * Enforces that container images are referenced by digest (`image@sha256:...`)
 * rather than by mutable tags. On every container pull, verifies that the
 * pulled image digest matches the pinned value in config.toml.
 *
 * Security model: fail-closed. If the digest doesn't match or can't be
 * verified, the container will not be started. Tag-only references are
 * rejected outright with guidance to use digest pinning.
 *
 * Integrates with `carapace doctor` via the health check interface.
 */

import type { HealthCheckResult } from '../core/health-checks.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed container image reference. */
export interface ImageReference {
  /** Registry hostname (e.g. 'ghcr.io', 'localhost:5000'). */
  registry: string | undefined;
  /** Repository path (e.g. 'fred-drake/carapace-agent'). */
  repository: string;
  /** Tag (e.g. 'latest', 'v1.0'). Undefined if not present. */
  tag: string | undefined;
  /** Digest (e.g. 'sha256:abcdef...'). Undefined if not present. */
  digest: string | undefined;
  /** True if the reference includes a digest (regardless of tag). */
  isDigestPinned: boolean;
}

/** Result of image reference validation. */
export interface ImageReferenceValidation {
  /** True if the reference is acceptable for use. */
  valid: boolean;
  /** Error message when invalid. */
  error?: string;
}

/** Result of digest verification after pull. */
export interface DigestVerificationResult {
  /** True if the pulled digest matches the pinned digest. */
  verified: boolean;
  /** The digest pinned in config. */
  pinnedDigest?: string;
  /** The digest of the actually pulled image. */
  pulledDigest?: string;
  /** Error message on verification failure. */
  error?: string;
}

/** Injectable dependencies for digest verification. */
export interface ImageDigestDeps {
  /**
   * Inspect a local image and return its digest.
   * Returns the full `sha256:...` string, or a `registry/repo@sha256:...`
   * RepoDigests-style string (the digest portion is extracted automatically).
   */
  inspectImageDigest: (image: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// SHA-256 digest format
// ---------------------------------------------------------------------------

/** A valid sha256 digest is exactly 64 hex characters after the prefix. */
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// parseImageReference
// ---------------------------------------------------------------------------

/**
 * Parse a container image reference into its components.
 *
 * Supports formats:
 * - `registry/repo@sha256:...` (digest-pinned)
 * - `registry/repo:tag` (tag-only)
 * - `registry/repo:tag@sha256:...` (tag + digest)
 * - `repo` (bare name, no registry)
 * - `registry:port/repo` (registry with port)
 */
export function parseImageReference(ref: string): ImageReference {
  let remaining = ref;
  let digest: string | undefined;
  let tag: string | undefined;
  let registry: string | undefined;

  // Extract digest (after @)
  const atIdx = remaining.indexOf('@');
  if (atIdx !== -1) {
    digest = remaining.slice(atIdx + 1);
    remaining = remaining.slice(0, atIdx);
  }

  // Extract tag (after last :, but only if no port-like pattern)
  // A registry with port looks like "localhost:5000/..." so we need
  // to find the colon after the last slash
  const lastSlash = remaining.lastIndexOf('/');
  const colonIdx = remaining.indexOf(':', lastSlash + 1);
  if (colonIdx !== -1) {
    tag = remaining.slice(colonIdx + 1);
    remaining = remaining.slice(0, colonIdx);
  }

  // Determine registry vs repository
  // A registry contains a dot or colon (port), or is "localhost"
  const firstSlash = remaining.indexOf('/');
  if (firstSlash !== -1) {
    const possibleRegistry = remaining.slice(0, firstSlash);
    if (
      possibleRegistry.includes('.') ||
      possibleRegistry.includes(':') ||
      possibleRegistry === 'localhost'
    ) {
      registry = possibleRegistry;
      remaining = remaining.slice(firstSlash + 1);
    }
  }

  return {
    registry,
    repository: remaining,
    tag,
    digest,
    isDigestPinned: digest !== undefined,
  };
}

// ---------------------------------------------------------------------------
// validateImageReference
// ---------------------------------------------------------------------------

/**
 * Validate that an image reference is digest-pinned and well-formed.
 *
 * Rejects:
 * - Tag-only references (e.g. `image:latest`)
 * - Bare image names (e.g. `ubuntu`)
 * - References with non-sha256 digests
 * - References with malformed sha256 digests
 *
 * Provides actionable guidance in error messages.
 */
export function validateImageReference(ref: string): ImageReferenceValidation {
  const parsed = parseImageReference(ref);

  if (!parsed.isDigestPinned) {
    return {
      valid: false,
      error:
        `Image reference must be digest-pinned (e.g. image@sha256:...). ` +
        `Got: "${ref}". ` +
        `Fix: Use \`docker inspect --format='{{index .RepoDigests 0}}' ${ref}\` ` +
        `to get the digest, then set runtime.image to the image@sha256:... form.`,
    };
  }

  // Validate digest format
  if (!parsed.digest!.startsWith('sha256:')) {
    return {
      valid: false,
      error:
        `Only sha256 digests are supported. ` +
        `Got: "${parsed.digest}". ` +
        `Fix: Use a sha256 digest (e.g. image@sha256:<64-hex-chars>).`,
    };
  }

  if (!SHA256_DIGEST_PATTERN.test(parsed.digest!)) {
    return {
      valid: false,
      error:
        `Invalid sha256 digest format. ` +
        `Expected sha256: followed by exactly 64 hex characters. ` +
        `Got: "${parsed.digest}".`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyImageDigest
// ---------------------------------------------------------------------------

/**
 * Verify that a locally pulled image matches its pinned digest.
 *
 * Fail-closed: returns `verified: false` on any error condition:
 * - Image reference not digest-pinned
 * - Image not found locally
 * - Digest mismatch
 * - Empty or unreadable digest
 */
export async function verifyImageDigest(
  imageRef: string,
  deps: ImageDigestDeps,
): Promise<DigestVerificationResult> {
  const parsed = parseImageReference(imageRef);

  if (!parsed.isDigestPinned || !parsed.digest) {
    return {
      verified: false,
      error:
        `Image reference is not digest-pinned. ` + `Use image@sha256:... format in runtime.image.`,
    };
  }

  const pinnedDigest = parsed.digest;

  let pulledDigestRaw: string;
  try {
    pulledDigestRaw = await deps.inspectImageDigest(imageRef);
  } catch (err) {
    return {
      verified: false,
      pinnedDigest,
      error: `Failed to inspect image digest: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!pulledDigestRaw || pulledDigestRaw.trim().length === 0) {
    return {
      verified: false,
      pinnedDigest,
      error: 'Digest verification failed: could not determine pulled image digest.',
    };
  }

  // Extract digest from RepoDigests format ("registry/repo@sha256:...")
  const pulledDigest = extractDigest(pulledDigestRaw.trim());

  if (pulledDigest === pinnedDigest) {
    return {
      verified: true,
      pinnedDigest,
      pulledDigest,
    };
  }

  return {
    verified: false,
    pinnedDigest,
    pulledDigest,
    error:
      `Image digest mismatch. ` +
      `Pinned: ${pinnedDigest.slice(0, 24)}... ` +
      `Pulled: ${pulledDigest.slice(0, 24)}... ` +
      `The image may have been tampered with or the pin is outdated.`,
  };
}

// ---------------------------------------------------------------------------
// checkImageDigest (health check integration)
// ---------------------------------------------------------------------------

/**
 * Health check for `carapace doctor` that verifies image digest pinning.
 *
 * Outcomes:
 * - **pass**: Image is digest-pinned and digest matches.
 * - **warn**: No image configured, or image is not digest-pinned.
 * - **fail**: Digest mismatch or verification error.
 */
export async function checkImageDigest(
  imageRef: string | undefined,
  deps: ImageDigestDeps,
): Promise<HealthCheckResult> {
  if (!imageRef) {
    return {
      name: 'image-digest',
      label: 'Image digest pinning',
      status: 'warn',
      detail: 'No image configured in runtime.image',
      fix: 'Set runtime.image to a digest-pinned reference (e.g. image@sha256:...)',
    };
  }

  const parsed = parseImageReference(imageRef);

  if (!parsed.isDigestPinned) {
    return {
      name: 'image-digest',
      label: 'Image digest pinning',
      status: 'warn',
      detail: `Image is not digest-pinned: ${imageRef}`,
      fix:
        `Pin by digest: Use \`docker inspect --format='{{index .RepoDigests 0}}' ${imageRef}\` ` +
        `to get the digest, then set runtime.image to the image@sha256:... form.`,
    };
  }

  const verification = await verifyImageDigest(imageRef, deps);

  if (verification.verified) {
    // Show truncated digest for readability
    const shortDigest = verification.pinnedDigest!.slice(0, 23);
    return {
      name: 'image-digest',
      label: 'Image digest pinning',
      status: 'pass',
      detail: `Digest verified: ${shortDigest}...`,
    };
  }

  return {
    name: 'image-digest',
    label: 'Image digest pinning',
    status: 'fail',
    detail: verification.error ?? 'Digest verification failed',
    fix: 'Pull the correct image and update runtime.image with the new digest.',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the `sha256:...` digest from a string that may be in
 * RepoDigests format (`registry/repo@sha256:...`).
 */
function extractDigest(value: string): string {
  const atIdx = value.lastIndexOf('@');
  if (atIdx !== -1) {
    return value.slice(atIdx + 1);
  }
  return value;
}
