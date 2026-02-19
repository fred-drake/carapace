/**
 * Tests for the release artifact verification library.
 *
 * Covers: SHA-256 checksum verification, cosign signature verification,
 * container image digest comparison, structured results with remediation,
 * graceful handling of missing cosign binary.
 *
 * SEC-16
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  verifySha256Checksum,
  verifyCosignSignature,
  verifyImageDigest,
  computeSha256,
  type VerificationResult,
  type ExecFn,
} from './artifact-verification.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `carapace-sec16-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// VerificationResult shape
// ---------------------------------------------------------------------------

describe('VerificationResult type', () => {
  it('should have required fields for pass', () => {
    const result: VerificationResult = {
      status: 'pass',
      detail: 'Checksum matches',
    };
    expect(result.status).toBe('pass');
    expect(result.detail).toBe('Checksum matches');
    expect(result.fix).toBeUndefined();
  });

  it('should have fix field for fail', () => {
    const result: VerificationResult = {
      status: 'fail',
      detail: 'Checksum mismatch',
      fix: 'Re-download the artifact',
    };
    expect(result.status).toBe('fail');
    expect(result.fix).toBeDefined();
  });

  it('should support warn status', () => {
    const result: VerificationResult = {
      status: 'warn',
      detail: 'cosign not installed',
      fix: 'Install cosign for signature verification',
    };
    expect(result.status).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// computeSha256
// ---------------------------------------------------------------------------

describe('computeSha256', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should compute correct SHA-256 hash for a file', () => {
    const content = 'hello world tarball content';
    const filePath = join(tempDir, 'test.tar.gz');
    writeFileSync(filePath, content);

    const hash = computeSha256(filePath);
    expect(hash).toBe(sha256(content));
  });

  it('should produce different hashes for different content', () => {
    const file1 = join(tempDir, 'file1.tar.gz');
    const file2 = join(tempDir, 'file2.tar.gz');
    writeFileSync(file1, 'content-a');
    writeFileSync(file2, 'content-b');

    expect(computeSha256(file1)).not.toBe(computeSha256(file2));
  });

  it('should throw for nonexistent file', () => {
    expect(() => computeSha256(join(tempDir, 'nonexistent.tar.gz'))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// verifySha256Checksum
// ---------------------------------------------------------------------------

describe('verifySha256Checksum', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should pass for matching checksum', () => {
    const content = 'valid tarball content';
    const filePath = join(tempDir, 'artifact.tar.gz');
    writeFileSync(filePath, content);
    const expected = sha256(content);

    const result = verifySha256Checksum(filePath, expected);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain(expected.slice(0, 16));
  });

  it('should fail for mismatched checksum', () => {
    const content = 'valid content';
    const filePath = join(tempDir, 'artifact.tar.gz');
    writeFileSync(filePath, content);
    const wrong = sha256('tampered content');

    const result = verifySha256Checksum(filePath, wrong);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('mismatch');
    expect(result.fix).toBeDefined();
  });

  it('should fail for nonexistent file', () => {
    const result = verifySha256Checksum(join(tempDir, 'missing.tar.gz'), 'abc123');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not found');
    expect(result.fix).toBeDefined();
  });

  it('should include expected and actual hashes in failure detail', () => {
    const content = 'original';
    const filePath = join(tempDir, 'test.tar.gz');
    writeFileSync(filePath, content);
    const expected = sha256('tampered');
    const actual = sha256(content);

    const result = verifySha256Checksum(filePath, expected);
    expect(result.detail).toContain(expected.slice(0, 16));
    expect(result.detail).toContain(actual.slice(0, 16));
  });

  it('should include remediation steps in failure', () => {
    const filePath = join(tempDir, 'test.tar.gz');
    writeFileSync(filePath, 'content');

    const result = verifySha256Checksum(filePath, sha256('wrong'));
    expect(result.fix).toContain('download');
  });

  it('should handle empty expected hash', () => {
    const filePath = join(tempDir, 'test.tar.gz');
    writeFileSync(filePath, 'content');

    const result = verifySha256Checksum(filePath, '');
    expect(result.status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// verifyCosignSignature
// ---------------------------------------------------------------------------

describe('verifyCosignSignature', () => {
  const makeExec =
    (exitCode: number, stdout = '', stderr = ''): ExecFn =>
    async () => ({ exitCode, stdout, stderr });

  it('should pass when cosign verify succeeds', async () => {
    const exec = makeExec(
      0,
      'Verification for ghcr.io/fred-drake/carapace-agent --\nThe following checks were performed:\n- The cosign claims were validated',
    );
    const result = await verifyCosignSignature('ghcr.io/fred-drake/carapace-agent:latest', exec);
    expect(result.status).toBe('pass');
  });

  it('should fail when cosign verify fails', async () => {
    const exec = makeExec(1, '', 'Error: no matching signatures');
    const result = await verifyCosignSignature('ghcr.io/fred-drake/carapace-agent:latest', exec);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('signature');
    expect(result.fix).toBeDefined();
  });

  it('should warn when cosign binary is not found', async () => {
    const exec: ExecFn = async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    const result = await verifyCosignSignature('ghcr.io/fred-drake/carapace-agent:latest', exec);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('cosign');
    expect(result.fix).toContain('install');
  });

  it('should fail on unexpected exec error', async () => {
    const exec: ExecFn = async () => {
      throw new Error('Permission denied');
    };
    const result = await verifyCosignSignature('ghcr.io/fred-drake/carapace-agent:latest', exec);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Permission denied');
  });

  it('should include the image reference in pass detail', async () => {
    const exec = makeExec(0, 'Verified OK');
    const image = 'ghcr.io/fred-drake/carapace-agent@sha256:abc123';
    const result = await verifyCosignSignature(image, exec);
    expect(result.detail).toContain(image);
  });

  it('should include remediation for failed verification', async () => {
    const exec = makeExec(1, '', 'no matching signatures: no valid signatures found');
    const result = await verifyCosignSignature('ghcr.io/fred-drake/carapace-agent:latest', exec);
    expect(result.fix).toBeDefined();
    expect(result.fix!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// verifyImageDigest
// ---------------------------------------------------------------------------

describe('verifyImageDigest', () => {
  it('should pass when digests match', () => {
    const digest = 'sha256:abc123def456789012345678901234567890123456789012345678901234';
    const result = verifyImageDigest(digest, digest);
    expect(result.status).toBe('pass');
  });

  it('should fail when digests do not match', () => {
    const expected = 'sha256:aaaa';
    const actual = 'sha256:bbbb';
    const result = verifyImageDigest(actual, expected);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('mismatch');
    expect(result.fix).toBeDefined();
  });

  it('should include both digests in failure detail', () => {
    const expected = 'sha256:expected123';
    const actual = 'sha256:actual456';
    const result = verifyImageDigest(actual, expected);
    expect(result.detail).toContain('expected123');
    expect(result.detail).toContain('actual456');
  });

  it('should fail if expected digest is empty', () => {
    const result = verifyImageDigest('sha256:abc', '');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('missing');
  });

  it('should fail if actual digest is empty', () => {
    const result = verifyImageDigest('', 'sha256:abc');
    expect(result.status).toBe('fail');
  });

  it('should include remediation for digest mismatch', () => {
    const result = verifyImageDigest('sha256:aaa', 'sha256:bbb');
    expect(result.fix).toContain('pull');
  });

  it('should be case-sensitive', () => {
    const lower = 'sha256:abcdef';
    const upper = 'sha256:ABCDEF';
    const result = verifyImageDigest(lower, upper);
    expect(result.status).toBe('fail');
  });

  it('should pass for identical long digest strings', () => {
    const digest = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const result = verifyImageDigest(digest, digest);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('match');
  });
});
