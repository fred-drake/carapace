/**
 * Container security verification tests (static analysis).
 *
 * Validates that the Dockerfile, docker-compose.yml, container runtime
 * adapters, and permission lockdown all enforce the security constraints
 * defined in docs/ARCHITECTURE.md §3.
 *
 * These tests run WITHOUT Docker — they analyze source artifacts directly.
 * Runtime probes that require a live container are in the .security.test.ts file.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  SECURITY_CONSTRAINTS,
  verifyDockerfile,
  verifyDockerCompose,
  verifyPermissionLockdown,
  verifyRuntimeAdapters,
  type VerificationResult,
} from './container-security.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '../..');

function readProjectFile(relativePath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf-8');
}

// ---------------------------------------------------------------------------
// Security constraints definition
// ---------------------------------------------------------------------------

describe('SECURITY_CONSTRAINTS', () => {
  it('defines all seven required constraints', () => {
    const ids = SECURITY_CONSTRAINTS.map((c) => c.id);
    expect(ids).toContain('read-only-rootfs');
    expect(ids).toContain('no-network');
    expect(ids).toContain('ipc-only-executable');
    expect(ids).toContain('settings-json-read-only');
    expect(ids).toContain('skills-claude-md-read-only');
    expect(ids).toContain('limited-writable-mounts');
    expect(ids).toContain('no-package-managers');
  });

  it('each constraint has id, name, description, and category', () => {
    for (const c of SECURITY_CONSTRAINTS) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.description).toBeTruthy();
      expect(c.category).toBeTruthy();
    }
  });

  it('categories are from the allowed set', () => {
    const validCategories = ['filesystem', 'network', 'execution', 'configuration'];
    for (const c of SECURITY_CONSTRAINTS) {
      expect(validCategories).toContain(c.category);
    }
  });
});

// ---------------------------------------------------------------------------
// Dockerfile verification
// ---------------------------------------------------------------------------

describe('verifyDockerfile', () => {
  const dockerfile = readProjectFile('Dockerfile');
  let results: VerificationResult[];

  // Run verification once
  results = verifyDockerfile(dockerfile);

  it('returns results for all Dockerfile checks', () => {
    expect(results.length).toBeGreaterThan(0);
  });

  it('verifies non-root USER directive', () => {
    const check = results.find((r) => r.check === 'non-root-user');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies ipc binary is created in PATH', () => {
    const check = results.find((r) => r.check === 'ipc-binary-in-path');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies writable directories are created for read-only root', () => {
    const check = results.find((r) => r.check === 'writable-dirs-created');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies entrypoint is set to entrypoint.sh', () => {
    const check = results.find((r) => r.check === 'entrypoint-set');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies no EXPOSE directive (no ports needed)', () => {
    const check = results.find((r) => r.check === 'no-expose');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies no CMD that could override entrypoint security', () => {
    const check = results.find((r) => r.check === 'no-cmd-override');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Docker Compose verification
// ---------------------------------------------------------------------------

describe('verifyDockerCompose', () => {
  const compose = readProjectFile('docker-compose.yml');
  let results: VerificationResult[];

  results = verifyDockerCompose(compose);

  it('returns results for all compose checks', () => {
    expect(results.length).toBeGreaterThan(0);
  });

  it('verifies agent service has read_only: true', () => {
    const check = results.find((r) => r.check === 'agent-read-only');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies network is internal (no external access)', () => {
    const check = results.find((r) => r.check === 'network-internal');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies skills are mounted read-only', () => {
    const check = results.find((r) => r.check === 'skills-read-only');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies tmpfs mounts have size limits', () => {
    const check = results.find((r) => r.check === 'tmpfs-size-limits');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Permission lockdown verification
// ---------------------------------------------------------------------------

describe('verifyPermissionLockdown', () => {
  let results: VerificationResult[];

  results = verifyPermissionLockdown();

  it('returns results for all lockdown checks', () => {
    expect(results.length).toBeGreaterThan(0);
  });

  it('verifies settings.json denies all Bash by default', () => {
    const check = results.find((r) => r.check === 'bash-denied');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies settings.json allows only ipc invocations', () => {
    const check = results.find((r) => r.check === 'ipc-allowed');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies no other allow rules exist', () => {
    const check = results.find((r) => r.check === 'no-extra-allows');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Runtime adapter verification
// ---------------------------------------------------------------------------

describe('verifyRuntimeAdapters', () => {
  let results: VerificationResult[];

  results = verifyRuntimeAdapters(PROJECT_ROOT);

  it('returns results for all runtime adapter checks', () => {
    expect(results.length).toBeGreaterThan(0);
  });

  it('verifies Docker adapter uses --read-only flag', () => {
    const check = results.find((r) => r.check === 'docker-read-only');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies Docker adapter uses --network none', () => {
    const check = results.find((r) => r.check === 'docker-network-none');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies Podman adapter uses --read-only flag', () => {
    const check = results.find((r) => r.check === 'podman-read-only');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies Podman adapter uses --network none', () => {
    const check = results.find((r) => r.check === 'podman-network-none');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it('verifies mount ordering: writable .claude/ before read-only overlays', () => {
    const check = results.find((r) => r.check === 'mount-ordering');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });
});
