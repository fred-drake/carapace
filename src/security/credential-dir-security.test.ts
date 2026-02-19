/**
 * Tests for the credential directory security model.
 *
 * Covers: directory permissions (0700), file permissions (0600),
 * symlink rejection, ownership validation, root warning, and
 * doctor integration via health check interface.
 *
 * SEC-18
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
  rmSync,
  statSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  verifyCredentialDirectory,
  writeCredentialFile,
  readCredentialFile,
  checkCredentialSecurity,
  checkRunningAsRoot,
  CREDENTIAL_DIR_MODE,
  CREDENTIAL_FILE_MODE,
  type CredentialDirVerification,
} from './credential-dir-security.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `carapace-sec18-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('credential directory security constants', () => {
  it('should define directory mode as 0700', () => {
    expect(CREDENTIAL_DIR_MODE).toBe(0o700);
  });

  it('should define file mode as 0600', () => {
    expect(CREDENTIAL_FILE_MODE).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// verifyCredentialDirectory
// ---------------------------------------------------------------------------

describe('verifyCredentialDirectory', () => {
  let tempRoot: string;
  let credDir: string;

  beforeEach(() => {
    tempRoot = makeTempDir();
    credDir = join(tempRoot, 'credentials');
    mkdirSync(credDir, { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('should pass for a properly secured credential directory', () => {
    const result = verifyCredentialDirectory(credDir);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('should detect directory with overly permissive mode (0755)', () => {
    chmodSync(credDir, 0o755);
    const result = verifyCredentialDirectory(credDir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('permission'))).toBe(true);
  });

  it('should detect directory with world-readable mode (0744)', () => {
    chmodSync(credDir, 0o744);
    const result = verifyCredentialDirectory(credDir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('permission'))).toBe(true);
  });

  it('should detect directory with group-readable mode (0740)', () => {
    chmodSync(credDir, 0o740);
    const result = verifyCredentialDirectory(credDir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('permission'))).toBe(true);
  });

  it('should handle nonexistent directory', () => {
    const missing = join(tempRoot, 'missing-creds');
    const result = verifyCredentialDirectory(missing);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('not exist') || i.includes('not found'))).toBe(
      true,
    );
  });

  it('should reject symlink as credential directory', () => {
    const realDir = join(tempRoot, 'real-creds');
    mkdirSync(realDir, { mode: 0o700 });
    const linkDir = join(tempRoot, 'linked-creds');
    symlinkSync(realDir, linkDir);

    const result = verifyCredentialDirectory(linkDir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('symlink'))).toBe(true);
  });

  it('should detect insecure files inside credential directory', () => {
    const insecureFile = join(credDir, 'api-key.txt');
    writeFileSync(insecureFile, 'secret-value', { mode: 0o644 });

    const result = verifyCredentialDirectory(credDir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('api-key.txt'))).toBe(true);
  });

  it('should pass when all files have 0600 permissions', () => {
    writeFileSync(join(credDir, 'token.txt'), 'secret', { mode: 0o600 });
    writeFileSync(join(credDir, 'key.pem'), 'private-key', { mode: 0o600 });

    const result = verifyCredentialDirectory(credDir);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('should reject symlink files inside credential directory', () => {
    const realFile = join(tempRoot, 'real-secret.txt');
    writeFileSync(realFile, 'secret', { mode: 0o600 });
    const linkFile = join(credDir, 'linked-secret.txt');
    symlinkSync(realFile, linkFile);

    const result = verifyCredentialDirectory(credDir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('symlink'))).toBe(true);
  });

  it('should detect world-readable files (0644)', () => {
    writeFileSync(join(credDir, 'exposed.key'), 'secret', { mode: 0o644 });

    const result = verifyCredentialDirectory(credDir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('exposed.key'))).toBe(true);
  });

  it('should detect group-readable files (0640)', () => {
    writeFileSync(join(credDir, 'group-read.key'), 'secret', { mode: 0o640 });

    const result = verifyCredentialDirectory(credDir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('group-read.key'))).toBe(true);
  });

  it('should return all issues when multiple problems exist', () => {
    chmodSync(credDir, 0o755);
    writeFileSync(join(credDir, 'insecure.key'), 'secret', { mode: 0o644 });

    const result = verifyCredentialDirectory(credDir);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('should include the CredentialDirVerification shape', () => {
    const result = verifyCredentialDirectory(credDir);
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('dirMode');
    expect(Array.isArray(result.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeCredentialFile
// ---------------------------------------------------------------------------

describe('writeCredentialFile', () => {
  let tempRoot: string;
  let credDir: string;

  beforeEach(() => {
    tempRoot = makeTempDir();
    credDir = join(tempRoot, 'credentials');
    mkdirSync(credDir, { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('should write a file with 0600 permissions', () => {
    const filePath = join(credDir, 'api-token.txt');
    writeCredentialFile(filePath, 'my-secret-token');

    const stat = statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('should write the correct content', () => {
    const filePath = join(credDir, 'test-credential.txt');
    const content = 'sk-abc123';
    writeCredentialFile(filePath, content);

    const written = readCredentialFile(filePath);
    expect(written).toBe(content);
  });

  it('should overwrite existing file while maintaining 0600', () => {
    const filePath = join(credDir, 'overwrite-test.txt');
    writeCredentialFile(filePath, 'first-value');
    writeCredentialFile(filePath, 'second-value');

    const stat = statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readCredentialFile(filePath)).toBe('second-value');
  });

  it('should reject path traversal attempts', () => {
    const malicious = join(credDir, '..', 'escaped.txt');
    expect(() => writeCredentialFile(malicious, 'escape', credDir)).toThrow(/traversal/i);
  });

  it('should reject symlink targets', () => {
    const realFile = join(tempRoot, 'real-target.txt');
    writeFileSync(realFile, 'original', { mode: 0o600 });
    const linkPath = join(credDir, 'link-target.txt');
    symlinkSync(realFile, linkPath);

    expect(() => writeCredentialFile(linkPath, 'overwrite-via-symlink')).toThrow(/symlink/i);
  });
});

// ---------------------------------------------------------------------------
// readCredentialFile
// ---------------------------------------------------------------------------

describe('readCredentialFile', () => {
  let tempRoot: string;
  let credDir: string;

  beforeEach(() => {
    tempRoot = makeTempDir();
    credDir = join(tempRoot, 'credentials');
    mkdirSync(credDir, { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('should read a credential file', () => {
    const filePath = join(credDir, 'read-test.txt');
    writeFileSync(filePath, 'my-credential', { mode: 0o600 });

    const content = readCredentialFile(filePath);
    expect(content).toBe('my-credential');
  });

  it('should reject reading through symlinks', () => {
    const realFile = join(tempRoot, 'real-cred.txt');
    writeFileSync(realFile, 'secret', { mode: 0o600 });
    const linkFile = join(credDir, 'symlink-cred.txt');
    symlinkSync(realFile, linkFile);

    expect(() => readCredentialFile(linkFile)).toThrow(/symlink/i);
  });

  it('should throw for nonexistent file', () => {
    expect(() => readCredentialFile(join(credDir, 'nope.txt'))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// checkCredentialSecurity (doctor integration)
// ---------------------------------------------------------------------------

describe('checkCredentialSecurity', () => {
  let tempRoot: string;
  let credDir: string;

  beforeEach(() => {
    tempRoot = makeTempDir();
    credDir = join(tempRoot, 'credentials');
    mkdirSync(credDir, { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('should return pass for a secure credential directory', () => {
    const result = checkCredentialSecurity(credDir);
    expect(result.name).toBe('credential-dir');
    expect(result.status).toBe('pass');
  });

  it('should return fail for insecure permissions', () => {
    chmodSync(credDir, 0o755);
    const result = checkCredentialSecurity(credDir);
    expect(result.name).toBe('credential-dir');
    expect(result.status).toBe('fail');
    expect(result.fix).toBeDefined();
  });

  it('should return fail for nonexistent directory', () => {
    const result = checkCredentialSecurity(join(tempRoot, 'missing'));
    expect(result.status).toBe('fail');
    expect(result.fix).toBeDefined();
  });

  it('should return fail when credential files have bad permissions', () => {
    writeFileSync(join(credDir, 'leaked.key'), 'secret', { mode: 0o644 });
    const result = checkCredentialSecurity(credDir);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('leaked.key');
  });

  it('should conform to HealthCheckResult interface', () => {
    const result = checkCredentialSecurity(credDir);
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('label');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('detail');
    expect(['pass', 'fail', 'warn']).toContain(result.status);
  });

  it('should include fix suggestion with chmod command', () => {
    chmodSync(credDir, 0o755);
    const result = checkCredentialSecurity(credDir);
    expect(result.fix).toContain('chmod');
  });
});

// ---------------------------------------------------------------------------
// checkRunningAsRoot
// ---------------------------------------------------------------------------

describe('checkRunningAsRoot', () => {
  it('should return warn when uid is 0', () => {
    const result = checkRunningAsRoot(0);
    expect(result.status).toBe('warn');
    expect(result.name).toBe('root-check');
    expect(result.detail).toContain('root');
  });

  it('should return pass when uid is non-zero', () => {
    const result = checkRunningAsRoot(1000);
    expect(result.status).toBe('pass');
    expect(result.name).toBe('root-check');
  });

  it('should return pass for typical user uid', () => {
    const result = checkRunningAsRoot(501);
    expect(result.status).toBe('pass');
  });

  it('should include a fix suggestion when running as root', () => {
    const result = checkRunningAsRoot(0);
    expect(result.fix).toBeDefined();
    expect(result.fix).toContain('root');
  });

  it('should conform to HealthCheckResult interface', () => {
    const result = checkRunningAsRoot(1000);
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('label');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('detail');
  });
});

// ---------------------------------------------------------------------------
// Ownership validation
// ---------------------------------------------------------------------------

describe('verifyCredentialDirectory ownership', () => {
  let tempRoot: string;
  let credDir: string;

  beforeEach(() => {
    tempRoot = makeTempDir();
    credDir = join(tempRoot, 'credentials');
    mkdirSync(credDir, { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('should include ownership info in verification result', () => {
    const result = verifyCredentialDirectory(credDir);
    expect(result).toHaveProperty('ownedByCurrentUser');
  });

  it('should report owned by current user for directories we created', () => {
    const result = verifyCredentialDirectory(credDir);
    expect(result.ownedByCurrentUser).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('credential directory edge cases', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('should handle credential directory that is a regular file', () => {
    const notADir = join(tempRoot, 'credentials');
    writeFileSync(notADir, 'not a directory');

    const result = verifyCredentialDirectory(notADir);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.includes('directory') || i.includes('not a directory')),
    ).toBe(true);
  });

  it('should handle empty credential directory', () => {
    const credDir = join(tempRoot, 'credentials');
    mkdirSync(credDir, { mode: 0o700 });

    const result = verifyCredentialDirectory(credDir);
    expect(result.valid).toBe(true);
  });

  it('should handle nested directories inside credentials (reject or scan)', () => {
    const credDir = join(tempRoot, 'credentials');
    mkdirSync(credDir, { mode: 0o700 });
    const subDir = join(credDir, 'provider');
    mkdirSync(subDir, { mode: 0o700 });
    writeFileSync(join(subDir, 'key.pem'), 'secret', { mode: 0o600 });

    const result = verifyCredentialDirectory(credDir);
    // Nested dirs with proper permissions should not cause issues
    expect(result.valid).toBe(true);
  });

  it('should detect insecure nested subdirectories', () => {
    const credDir = join(tempRoot, 'credentials');
    mkdirSync(credDir, { mode: 0o700 });
    const subDir = join(credDir, 'provider');
    mkdirSync(subDir, { mode: 0o755 });

    const result = verifyCredentialDirectory(credDir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('provider'))).toBe(true);
  });
});
