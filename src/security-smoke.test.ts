import { describe, it, expect, vi } from 'vitest';
import {
  runSecuritySmoke,
  type SmokeTestDeps,
  type SmokeTestResult,
  type SmokeCheckResult,
} from './security-smoke.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeps(overrides?: Partial<SmokeTestDeps>): SmokeTestDeps {
  return {
    // Network isolation: attempt DNS resolve and HTTP fetch
    resolveDns: vi.fn<(hostname: string) => Promise<boolean>>().mockResolvedValue(false),
    httpGet: vi.fn<(url: string) => Promise<boolean>>().mockResolvedValue(false),

    // Filesystem read-only: attempt to write outside writable mounts
    writeTestFile: vi.fn<(path: string) => boolean>().mockReturnValue(false),

    // IPC binary check: list executables and check if only ipc is executable
    isExecutable: vi.fn<(path: string) => boolean>().mockImplementation((p) => p.endsWith('/ipc')),

    // Credential directory permissions
    getPermissions: vi.fn<(path: string) => number | null>().mockReturnValue(0o700),

    // Image digest verification
    getRunningImageDigest: vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValue('sha256:abc123def456'),
    getPinnedImageDigest: vi.fn<() => string | null>().mockReturnValue('sha256:abc123def456'),

    // Path configuration
    credentialDir: '/home/test/.carapace/credentials',
    containerBinPaths: ['/usr/local/bin/ipc', '/usr/local/bin/node', '/usr/bin/sh'],
    readOnlyTestPaths: ['/etc/test-write', '/usr/test-write', '/opt/test-write'],

    ...overrides,
  };
}

function findCheck(result: SmokeTestResult, name: string): SmokeCheckResult {
  const check = result.checks.find((c) => c.name === name);
  if (!check) {
    throw new Error(`Check "${name}" not found in results`);
  }
  return check;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SecuritySmoke', () => {
  // -------------------------------------------------------------------------
  // Overall structure
  // -------------------------------------------------------------------------

  describe('result structure', () => {
    it('returns results with all 5 checks', async () => {
      const deps = createDeps();
      const result = await runSecuritySmoke(deps);

      expect(result.checks).toHaveLength(5);
      expect(result.checks.map((c) => c.name).sort()).toEqual([
        'container-filesystem-readonly',
        'container-network-isolation',
        'credential-directory-permissions',
        'image-digest-match',
        'ipc-binary-exclusive',
      ]);
    });

    it('sets passed=true when all checks pass', async () => {
      const deps = createDeps();
      const result = await runSecuritySmoke(deps);

      expect(result.passed).toBe(true);
    });

    it('sets passed=false when any check fails', async () => {
      const deps = createDeps({
        resolveDns: vi.fn().mockResolvedValue(true), // network reachable = fail
      });
      const result = await runSecuritySmoke(deps);

      expect(result.passed).toBe(false);
    });

    it('includes a timestamp in ISO 8601 format', async () => {
      const deps = createDeps();
      const result = await runSecuritySmoke(deps);

      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // -------------------------------------------------------------------------
  // Check 1: Network isolation
  // -------------------------------------------------------------------------

  describe('container-network-isolation', () => {
    it('passes when DNS and HTTP both fail (network blocked)', async () => {
      const deps = createDeps({
        resolveDns: vi.fn().mockResolvedValue(false),
        httpGet: vi.fn().mockResolvedValue(false),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'container-network-isolation');
      expect(check.passed).toBe(true);
    });

    it('fails when DNS resolves (network reachable)', async () => {
      const deps = createDeps({
        resolveDns: vi.fn().mockResolvedValue(true),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'container-network-isolation');
      expect(check.passed).toBe(false);
      expect(check.remediation).toBeDefined();
      expect(check.remediation!.length).toBeGreaterThan(0);
    });

    it('fails when HTTP succeeds (network reachable)', async () => {
      const deps = createDeps({
        resolveDns: vi.fn().mockResolvedValue(false),
        httpGet: vi.fn().mockResolvedValue(true),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'container-network-isolation');
      expect(check.passed).toBe(false);
    });

    it('includes remediation when failing', async () => {
      const deps = createDeps({
        resolveDns: vi.fn().mockResolvedValue(true),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'container-network-isolation');
      expect(check.remediation).toMatch(/network/i);
    });
  });

  // -------------------------------------------------------------------------
  // Check 2: Filesystem read-only
  // -------------------------------------------------------------------------

  describe('container-filesystem-readonly', () => {
    it('passes when writes fail on all test paths', async () => {
      const deps = createDeps({
        writeTestFile: vi.fn().mockReturnValue(false),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'container-filesystem-readonly');
      expect(check.passed).toBe(true);
    });

    it('fails when any write succeeds', async () => {
      const deps = createDeps({
        writeTestFile: vi.fn().mockImplementation((p: string) => p === '/etc/test-write'),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'container-filesystem-readonly');
      expect(check.passed).toBe(false);
    });

    it('tests all configured read-only paths', async () => {
      const writeFn = vi.fn().mockReturnValue(false);
      const deps = createDeps({
        writeTestFile: writeFn,
        readOnlyTestPaths: ['/path-a', '/path-b', '/path-c'],
      });
      await runSecuritySmoke(deps);

      expect(writeFn).toHaveBeenCalledTimes(3);
      expect(writeFn).toHaveBeenCalledWith('/path-a');
      expect(writeFn).toHaveBeenCalledWith('/path-b');
      expect(writeFn).toHaveBeenCalledWith('/path-c');
    });

    it('includes remediation when failing', async () => {
      const deps = createDeps({
        writeTestFile: vi.fn().mockReturnValue(true),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'container-filesystem-readonly');
      expect(check.remediation).toMatch(/read.only/i);
    });
  });

  // -------------------------------------------------------------------------
  // Check 3: IPC binary exclusive
  // -------------------------------------------------------------------------

  describe('ipc-binary-exclusive', () => {
    it('passes when only ipc is executable', async () => {
      const deps = createDeps({
        isExecutable: vi.fn().mockImplementation((p: string) => p.endsWith('/ipc')),
        containerBinPaths: ['/usr/local/bin/ipc', '/usr/local/bin/node', '/usr/bin/sh'],
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'ipc-binary-exclusive');
      expect(check.passed).toBe(true);
    });

    it('fails when non-ipc binaries are executable', async () => {
      const deps = createDeps({
        isExecutable: vi.fn().mockReturnValue(true), // all executable
        containerBinPaths: ['/usr/local/bin/ipc', '/usr/local/bin/node'],
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'ipc-binary-exclusive');
      expect(check.passed).toBe(false);
    });

    it('passes when ipc is not in the list but nothing else is executable', async () => {
      const deps = createDeps({
        isExecutable: vi.fn().mockReturnValue(false),
        containerBinPaths: ['/usr/local/bin/node', '/usr/bin/sh'],
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'ipc-binary-exclusive');
      expect(check.passed).toBe(true);
    });

    it('includes remediation listing unexpected executables', async () => {
      const deps = createDeps({
        isExecutable: vi.fn().mockReturnValue(true),
        containerBinPaths: ['/usr/local/bin/ipc', '/usr/local/bin/node', '/usr/bin/curl'],
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'ipc-binary-exclusive');
      expect(check.passed).toBe(false);
      expect(check.remediation).toMatch(/node|curl/);
    });
  });

  // -------------------------------------------------------------------------
  // Check 4: Credential directory permissions
  // -------------------------------------------------------------------------

  describe('credential-directory-permissions', () => {
    it('passes when permissions are 0700', async () => {
      const deps = createDeps({
        getPermissions: vi.fn().mockReturnValue(0o700),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'credential-directory-permissions');
      expect(check.passed).toBe(true);
    });

    it('fails when permissions are too permissive', async () => {
      const deps = createDeps({
        getPermissions: vi.fn().mockReturnValue(0o755),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'credential-directory-permissions');
      expect(check.passed).toBe(false);
    });

    it('fails when credential directory does not exist', async () => {
      const deps = createDeps({
        getPermissions: vi.fn().mockReturnValue(null),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'credential-directory-permissions');
      expect(check.passed).toBe(false);
    });

    it('includes remediation with chmod command', async () => {
      const deps = createDeps({
        getPermissions: vi.fn().mockReturnValue(0o755),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'credential-directory-permissions');
      expect(check.remediation).toMatch(/chmod\s+700/);
    });

    it('includes remediation to create directory when missing', async () => {
      const deps = createDeps({
        getPermissions: vi.fn().mockReturnValue(null),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'credential-directory-permissions');
      expect(check.remediation).toMatch(/mkdir|create/i);
    });
  });

  // -------------------------------------------------------------------------
  // Check 5: Image digest match
  // -------------------------------------------------------------------------

  describe('image-digest-match', () => {
    it('passes when running digest matches pinned digest', async () => {
      const deps = createDeps({
        getRunningImageDigest: vi.fn().mockResolvedValue('sha256:abc123'),
        getPinnedImageDigest: vi.fn().mockReturnValue('sha256:abc123'),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'image-digest-match');
      expect(check.passed).toBe(true);
    });

    it('fails when digests do not match', async () => {
      const deps = createDeps({
        getRunningImageDigest: vi.fn().mockResolvedValue('sha256:abc123'),
        getPinnedImageDigest: vi.fn().mockReturnValue('sha256:different'),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'image-digest-match');
      expect(check.passed).toBe(false);
    });

    it('fails when running digest is unavailable', async () => {
      const deps = createDeps({
        getRunningImageDigest: vi.fn().mockResolvedValue(null),
        getPinnedImageDigest: vi.fn().mockReturnValue('sha256:abc123'),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'image-digest-match');
      expect(check.passed).toBe(false);
    });

    it('fails when pinned digest is unavailable', async () => {
      const deps = createDeps({
        getRunningImageDigest: vi.fn().mockResolvedValue('sha256:abc123'),
        getPinnedImageDigest: vi.fn().mockReturnValue(null),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'image-digest-match');
      expect(check.passed).toBe(false);
    });

    it('includes remediation with digest mismatch details', async () => {
      const deps = createDeps({
        getRunningImageDigest: vi.fn().mockResolvedValue('sha256:running'),
        getPinnedImageDigest: vi.fn().mockReturnValue('sha256:pinned'),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'image-digest-match');
      expect(check.remediation).toMatch(/digest/i);
    });

    it('includes remediation when running digest unavailable', async () => {
      const deps = createDeps({
        getRunningImageDigest: vi.fn().mockResolvedValue(null),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'image-digest-match');
      expect(check.remediation).toMatch(/container|image/i);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles errors in individual checks gracefully', async () => {
      const deps = createDeps({
        resolveDns: vi.fn().mockRejectedValue(new Error('DNS lookup failed')),
      });
      const result = await runSecuritySmoke(deps);

      // Network check should still produce a result (pass, since error = network blocked)
      const check = findCheck(result, 'container-network-isolation');
      expect(check.passed).toBe(true);
    });

    it('treats DNS/HTTP errors as network being blocked (pass)', async () => {
      const deps = createDeps({
        resolveDns: vi.fn().mockRejectedValue(new Error('ENOTFOUND')),
        httpGet: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'container-network-isolation');
      expect(check.passed).toBe(true);
    });

    it('handles image digest check errors as failure', async () => {
      const deps = createDeps({
        getRunningImageDigest: vi.fn().mockRejectedValue(new Error('docker inspect failed')),
      });
      const result = await runSecuritySmoke(deps);

      const check = findCheck(result, 'image-digest-match');
      expect(check.passed).toBe(false);
    });
  });
});
