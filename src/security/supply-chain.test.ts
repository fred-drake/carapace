/**
 * Tests for the supply chain security module.
 *
 * Covers: lockfile integrity verification, secret pattern detection,
 * audit severity parsing, and CI gate logic.
 *
 * SEC-09
 */

import { describe, it, expect } from 'vitest';
import {
  verifyLockfileIntegrity,
  detectSecretPatterns,
  parseAuditSeverity,
  shouldBlockMerge,
  SECRET_PATTERNS,
  type AuditFinding,
  type SecretDetection,
} from './supply-chain.js';

// ---------------------------------------------------------------------------
// verifyLockfileIntegrity
// ---------------------------------------------------------------------------

describe('verifyLockfileIntegrity', () => {
  it('should pass when lockfile and package.json are consistent', () => {
    const packageJson = JSON.stringify({
      dependencies: { 'smol-toml': '^1.6.0' },
      devDependencies: { vitest: '^3.0.0' },
    });
    const lockfileContent =
      'lockfileVersion: "9.0"\nimporters:\n  .:\n    dependencies:\n      smol-toml:\n        specifier: "^1.6.0"\n    devDependencies:\n      vitest:\n        specifier: "^3.0.0"';

    const result = verifyLockfileIntegrity(packageJson, lockfileContent);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('should fail when lockfile is missing (empty string)', () => {
    const packageJson = JSON.stringify({ dependencies: { foo: '^1.0.0' } });
    const result = verifyLockfileIntegrity(packageJson, '');
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('missing') || i.includes('empty'))).toBe(true);
  });

  it('should fail when package.json has dependency not in lockfile', () => {
    const packageJson = JSON.stringify({
      dependencies: { 'smol-toml': '^1.6.0', 'not-in-lock': '^2.0.0' },
    });
    const lockfileContent =
      'lockfileVersion: "9.0"\nimporters:\n  .:\n    dependencies:\n      smol-toml:\n        specifier: "^1.6.0"';

    const result = verifyLockfileIntegrity(packageJson, lockfileContent);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('not-in-lock'))).toBe(true);
  });

  it('should fail when specifier in lockfile does not match package.json', () => {
    const packageJson = JSON.stringify({
      dependencies: { 'smol-toml': '^2.0.0' },
    });
    const lockfileContent =
      'lockfileVersion: "9.0"\nimporters:\n  .:\n    dependencies:\n      smol-toml:\n        specifier: "^1.6.0"';

    const result = verifyLockfileIntegrity(packageJson, lockfileContent);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('smol-toml') && i.includes('mismatch'))).toBe(true);
  });

  it('should check devDependencies as well', () => {
    const packageJson = JSON.stringify({
      devDependencies: { vitest: '^3.0.0', 'missing-dev': '^1.0.0' },
    });
    const lockfileContent =
      'lockfileVersion: "9.0"\nimporters:\n  .:\n    devDependencies:\n      vitest:\n        specifier: "^3.0.0"';

    const result = verifyLockfileIntegrity(packageJson, lockfileContent);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('missing-dev'))).toBe(true);
  });

  it('should handle package.json with no dependencies', () => {
    const packageJson = JSON.stringify({ name: 'test', version: '1.0.0' });
    const lockfileContent = 'lockfileVersion: "9.0"\nimporters:\n  .:';

    const result = verifyLockfileIntegrity(packageJson, lockfileContent);
    expect(result.valid).toBe(true);
  });

  it('should handle malformed package.json', () => {
    const result = verifyLockfileIntegrity('not json', 'lockfileVersion: "9.0"');
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('parse') || i.includes('invalid'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectSecretPatterns
// ---------------------------------------------------------------------------

describe('detectSecretPatterns', () => {
  it('should detect Bearer tokens', () => {
    const content = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123';
    const detections = detectSecretPatterns(content, 'config.ts');
    expect(detections.length).toBeGreaterThan(0);
    expect(detections.some((d) => d.pattern.includes('Bearer'))).toBe(true);
  });

  it('should detect AWS access keys', () => {
    const content = 'const key = "AKIAIOSFODNN7EXAMPLE"';
    const detections = detectSecretPatterns(content, 'config.ts');
    expect(detections.length).toBeGreaterThan(0);
    expect(detections.some((d) => d.pattern.includes('AWS'))).toBe(true);
  });

  it('should detect generic API keys (sk- prefix)', () => {
    const content = 'api_key = "sk-proj-abc123def456ghi789"';
    const detections = detectSecretPatterns(content, 'secrets.ts');
    expect(detections.length).toBeGreaterThan(0);
  });

  it('should detect GitHub tokens', () => {
    const content = 'token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"';
    const detections = detectSecretPatterns(content, 'auth.ts');
    expect(detections.length).toBeGreaterThan(0);
    expect(detections.some((d) => d.pattern.includes('GitHub'))).toBe(true);
  });

  it('should detect private keys', () => {
    const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS';
    const detections = detectSecretPatterns(content, 'key.pem');
    expect(detections.length).toBeGreaterThan(0);
    expect(detections.some((d) => d.pattern.includes('private key'))).toBe(true);
  });

  it('should return empty array for safe content', () => {
    const content = 'const greeting = "Hello, world!";';
    const detections = detectSecretPatterns(content, 'hello.ts');
    expect(detections).toHaveLength(0);
  });

  it('should include file path in detections', () => {
    const content = 'Bearer eyJhbGciOiJIUzI1NiJ9.test';
    const detections = detectSecretPatterns(content, 'src/config.ts');
    expect(detections.every((d) => d.file === 'src/config.ts')).toBe(true);
  });

  it('should detect connection strings', () => {
    const content = 'const db = "postgresql://user:password@host:5432/db"';
    const detections = detectSecretPatterns(content, 'db.ts');
    expect(detections.length).toBeGreaterThan(0);
  });

  it('should have SECRET_PATTERNS exported', () => {
    expect(SECRET_PATTERNS).toBeDefined();
    expect(Array.isArray(SECRET_PATTERNS)).toBe(true);
    expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
  });

  it('should include line number in detections', () => {
    const content = 'line1\nline2\nBearer eyJhbGciOiJIUzI1NiJ9.test\nline4';
    const detections = detectSecretPatterns(content, 'test.ts');
    expect(detections.length).toBeGreaterThan(0);
    expect(detections[0].line).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// parseAuditSeverity
// ---------------------------------------------------------------------------

describe('parseAuditSeverity', () => {
  it('should parse critical findings', () => {
    const findings = parseAuditSeverity([
      {
        severity: 'critical',
        package: 'bad-pkg',
        title: 'RCE vulnerability',
        url: 'https://example.com',
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].package).toBe('bad-pkg');
  });

  it('should parse high findings', () => {
    const findings = parseAuditSeverity([
      { severity: 'high', package: 'risky-pkg', title: 'XSS', url: 'https://example.com' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
  });

  it('should filter to only critical and high by default', () => {
    const findings = parseAuditSeverity([
      { severity: 'critical', package: 'a', title: 'RCE', url: '' },
      { severity: 'high', package: 'b', title: 'XSS', url: '' },
      { severity: 'moderate', package: 'c', title: 'DoS', url: '' },
      { severity: 'low', package: 'd', title: 'Info', url: '' },
    ]);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.severity)).toEqual(['critical', 'high']);
  });

  it('should allow custom minimum severity', () => {
    const findings = parseAuditSeverity(
      [
        { severity: 'critical', package: 'a', title: 'RCE', url: '' },
        { severity: 'high', package: 'b', title: 'XSS', url: '' },
        { severity: 'moderate', package: 'c', title: 'DoS', url: '' },
        { severity: 'low', package: 'd', title: 'Info', url: '' },
      ],
      'moderate',
    );
    expect(findings).toHaveLength(3);
  });

  it('should return empty array for no findings', () => {
    expect(parseAuditSeverity([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// shouldBlockMerge
// ---------------------------------------------------------------------------

describe('shouldBlockMerge', () => {
  it('should block on critical findings', () => {
    const findings: AuditFinding[] = [
      { severity: 'critical', package: 'bad', title: 'RCE', url: '' },
    ];
    expect(shouldBlockMerge(findings)).toBe(true);
  });

  it('should block on high findings', () => {
    const findings: AuditFinding[] = [
      { severity: 'high', package: 'risky', title: 'XSS', url: '' },
    ];
    expect(shouldBlockMerge(findings)).toBe(true);
  });

  it('should not block on moderate findings only', () => {
    const findings: AuditFinding[] = [
      { severity: 'moderate', package: 'ok', title: 'DoS', url: '' },
    ];
    expect(shouldBlockMerge(findings)).toBe(false);
  });

  it('should not block on empty findings', () => {
    expect(shouldBlockMerge([])).toBe(false);
  });

  it('should block if mix includes high or critical', () => {
    const findings: AuditFinding[] = [
      { severity: 'low', package: 'fine', title: 'Info', url: '' },
      { severity: 'high', package: 'risky', title: 'XSS', url: '' },
    ];
    expect(shouldBlockMerge(findings)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SecretDetection type shape
// ---------------------------------------------------------------------------

describe('SecretDetection type', () => {
  it('should have required fields', () => {
    const detection: SecretDetection = {
      file: 'test.ts',
      line: 1,
      pattern: 'Bearer token',
      match: 'Bearer eyJ...',
    };
    expect(detection.file).toBe('test.ts');
    expect(detection.line).toBe(1);
    expect(detection.pattern).toBe('Bearer token');
    expect(detection.match).toBe('Bearer eyJ...');
  });
});
