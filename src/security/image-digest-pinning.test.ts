import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseImageReference,
  verifyImageDigest,
  checkImageDigest,
  validateImageReference,
  type ImageDigestDeps,
} from './image-digest-pinning.js';

// ---------------------------------------------------------------------------
// parseImageReference
// ---------------------------------------------------------------------------

describe('parseImageReference', () => {
  it('parses a digest-pinned reference', () => {
    const ref = parseImageReference(
      'ghcr.io/fred-drake/carapace-agent@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    );

    expect(ref.registry).toBe('ghcr.io');
    expect(ref.repository).toBe('fred-drake/carapace-agent');
    expect(ref.tag).toBeUndefined();
    expect(ref.digest).toBe(
      'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    );
    expect(ref.isDigestPinned).toBe(true);
  });

  it('parses a tag-only reference', () => {
    const ref = parseImageReference('ghcr.io/fred-drake/carapace-agent:latest');

    expect(ref.registry).toBe('ghcr.io');
    expect(ref.repository).toBe('fred-drake/carapace-agent');
    expect(ref.tag).toBe('latest');
    expect(ref.digest).toBeUndefined();
    expect(ref.isDigestPinned).toBe(false);
  });

  it('parses a reference with tag and digest', () => {
    const ref = parseImageReference(
      'ghcr.io/fred-drake/carapace-agent:v1.0@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    );

    expect(ref.tag).toBe('v1.0');
    expect(ref.digest).toBe(
      'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    );
    expect(ref.isDigestPinned).toBe(true);
  });

  it('parses a Docker Hub reference (no registry)', () => {
    const ref = parseImageReference('library/ubuntu:22.04');

    expect(ref.registry).toBeUndefined();
    expect(ref.repository).toBe('library/ubuntu');
    expect(ref.tag).toBe('22.04');
    expect(ref.isDigestPinned).toBe(false);
  });

  it('parses a simple image name with no tag or digest', () => {
    const ref = parseImageReference('ubuntu');

    expect(ref.registry).toBeUndefined();
    expect(ref.repository).toBe('ubuntu');
    expect(ref.tag).toBeUndefined();
    expect(ref.digest).toBeUndefined();
    expect(ref.isDigestPinned).toBe(false);
  });

  it('parses registry with port', () => {
    const ref = parseImageReference(
      'localhost:5000/myimage@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    );

    expect(ref.registry).toBe('localhost:5000');
    expect(ref.repository).toBe('myimage');
    expect(ref.isDigestPinned).toBe(true);
  });

  it('handles image reference with only sha256 digest', () => {
    const ref = parseImageReference(
      'myimage@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    );

    expect(ref.repository).toBe('myimage');
    expect(ref.isDigestPinned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateImageReference
// ---------------------------------------------------------------------------

describe('validateImageReference', () => {
  it('accepts digest-pinned references', () => {
    const result = validateImageReference(
      'ghcr.io/fred-drake/carapace-agent@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    );

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects tag-only references with guidance', () => {
    const result = validateImageReference('ghcr.io/fred-drake/carapace-agent:latest');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('digest-pinned');
    expect(result.error).toContain('@sha256:');
  });

  it('rejects bare image names with guidance', () => {
    const result = validateImageReference('ubuntu');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('digest-pinned');
  });

  it('accepts tag+digest references (digest takes precedence)', () => {
    const result = validateImageReference(
      'ghcr.io/fred-drake/carapace-agent:v1.0@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    );

    expect(result.valid).toBe(true);
  });

  it('rejects references with invalid digest format', () => {
    const result = validateImageReference('ghcr.io/fred-drake/carapace-agent@sha256:tooshort');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('sha256');
  });

  it('rejects references with non-sha256 algorithm', () => {
    const result = validateImageReference(
      'ghcr.io/fred-drake/carapace-agent@md5:abcdef1234567890abcdef1234567890',
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain('sha256');
  });
});

// ---------------------------------------------------------------------------
// verifyImageDigest
// ---------------------------------------------------------------------------

describe('verifyImageDigest', () => {
  const VALID_DIGEST = 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const PINNED_IMAGE = `ghcr.io/fred-drake/carapace-agent@${VALID_DIGEST}`;

  function createDeps(overrides?: Partial<ImageDigestDeps>): ImageDigestDeps {
    return {
      inspectImageDigest: vi.fn().mockResolvedValue(VALID_DIGEST),
      ...overrides,
    };
  }

  it('passes when pulled digest matches pinned digest', async () => {
    const deps = createDeps();

    const result = await verifyImageDigest(PINNED_IMAGE, deps);

    expect(result.verified).toBe(true);
    expect(result.pinnedDigest).toBe(VALID_DIGEST);
    expect(result.pulledDigest).toBe(VALID_DIGEST);
  });

  it('fails when pulled digest does not match pinned digest', async () => {
    const mismatchedDigest =
      'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const deps = createDeps({
      inspectImageDigest: vi.fn().mockResolvedValue(mismatchedDigest),
    });

    const result = await verifyImageDigest(PINNED_IMAGE, deps);

    expect(result.verified).toBe(false);
    expect(result.pinnedDigest).toBe(VALID_DIGEST);
    expect(result.pulledDigest).toBe(mismatchedDigest);
    expect(result.error).toContain('mismatch');
  });

  it('fails when image reference is not digest-pinned', async () => {
    const deps = createDeps();

    const result = await verifyImageDigest('ghcr.io/fred-drake/carapace-agent:latest', deps);

    expect(result.verified).toBe(false);
    expect(result.error).toContain('digest-pinned');
  });

  it('fails when image inspect throws', async () => {
    const deps = createDeps({
      inspectImageDigest: vi.fn().mockRejectedValue(new Error('image not found')),
    });

    const result = await verifyImageDigest(PINNED_IMAGE, deps);

    expect(result.verified).toBe(false);
    expect(result.error).toContain('image not found');
  });

  it('fails when inspect returns empty digest', async () => {
    const deps = createDeps({
      inspectImageDigest: vi.fn().mockResolvedValue(''),
    });

    const result = await verifyImageDigest(PINNED_IMAGE, deps);

    expect(result.verified).toBe(false);
    expect(result.error).toContain('could not determine');
  });

  it('strips RepoDigests prefix for comparison', async () => {
    // Docker inspect returns "registry/repo@sha256:..." in RepoDigests
    const deps = createDeps({
      inspectImageDigest: vi
        .fn()
        .mockResolvedValue(`ghcr.io/fred-drake/carapace-agent@${VALID_DIGEST}`),
    });

    const result = await verifyImageDigest(PINNED_IMAGE, deps);

    expect(result.verified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkImageDigest (health check integration)
// ---------------------------------------------------------------------------

describe('checkImageDigest', () => {
  const VALID_DIGEST = 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const PINNED_IMAGE = `ghcr.io/fred-drake/carapace-agent@${VALID_DIGEST}`;

  function createDeps(overrides?: Partial<ImageDigestDeps>): ImageDigestDeps {
    return {
      inspectImageDigest: vi.fn().mockResolvedValue(VALID_DIGEST),
      ...overrides,
    };
  }

  it('returns pass when digest matches', async () => {
    const deps = createDeps();

    const result = await checkImageDigest(PINNED_IMAGE, deps);

    expect(result.name).toBe('image-digest');
    expect(result.status).toBe('pass');
    expect(result.detail).toContain(VALID_DIGEST.slice(0, 16));
  });

  it('returns fail when digest does not match', async () => {
    const mismatchedDigest =
      'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const deps = createDeps({
      inspectImageDigest: vi.fn().mockResolvedValue(mismatchedDigest),
    });

    const result = await checkImageDigest(PINNED_IMAGE, deps);

    expect(result.name).toBe('image-digest');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('mismatch');
    expect(result.fix).toBeDefined();
  });

  it('returns warn when image is not digest-pinned', async () => {
    const deps = createDeps();

    const result = await checkImageDigest('ghcr.io/fred-drake/carapace-agent:latest', deps);

    expect(result.name).toBe('image-digest');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('not digest-pinned');
    expect(result.fix).toContain('@sha256:');
  });

  it('returns fail when inspect throws', async () => {
    const deps = createDeps({
      inspectImageDigest: vi.fn().mockRejectedValue(new Error('not found')),
    });

    const result = await checkImageDigest(PINNED_IMAGE, deps);

    expect(result.name).toBe('image-digest');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not found');
  });

  it('returns warn when no image is configured', async () => {
    const deps = createDeps();

    const result = await checkImageDigest(undefined, deps);

    expect(result.name).toBe('image-digest');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('No image configured');
  });
});
