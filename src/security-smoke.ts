/**
 * Install-time security smoke tests for Carapace.
 *
 * Runs five security verification checks post-install:
 *   1. Container network isolation (DNS + HTTP blocked)
 *   2. Container filesystem is read-only
 *   3. Only the `ipc` binary is executable
 *   4. Credential directory has correct permissions (0700)
 *   5. Container image digest matches pinned config value
 *
 * All I/O is injected via {@link SmokeTestDeps} for testability.
 * Results are structured pass/fail with remediation steps.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a single smoke check. */
export interface SmokeCheckResult {
  /** Identifier for this check. */
  name: string;
  /** Whether the check passed. */
  passed: boolean;
  /** Human-readable description of what was tested. */
  description: string;
  /** Remediation steps when the check fails. Undefined when passed. */
  remediation?: string;
}

/** Aggregate result of all smoke checks. */
export interface SmokeTestResult {
  /** True only if every individual check passed. */
  passed: boolean;
  /** ISO 8601 timestamp when the tests were run. */
  timestamp: string;
  /** Individual check results. */
  checks: SmokeCheckResult[];
}

/** Injectable dependencies for smoke tests. */
export interface SmokeTestDeps {
  /** Attempt DNS resolution. Returns true if name resolves (network reachable). */
  resolveDns: (hostname: string) => Promise<boolean>;
  /** Attempt HTTP GET. Returns true if request succeeds (network reachable). */
  httpGet: (url: string) => Promise<boolean>;

  /** Attempt to write a test file. Returns true if write succeeds (bad). */
  writeTestFile: (path: string) => boolean;

  /** Check if a file is executable. */
  isExecutable: (path: string) => boolean;

  /** Get file/directory permissions (lower 12 bits), or null if not found. */
  getPermissions: (path: string) => number | null;

  /** Get the digest of the currently running container image. */
  getRunningImageDigest: () => Promise<string | null>;
  /** Get the pinned image digest from config. */
  getPinnedImageDigest: () => string | null;

  /** Path to the credential directory. */
  credentialDir: string;
  /** Paths to check for executable permissions inside the container. */
  containerBinPaths: string[];
  /** Paths to attempt writes on (should all be read-only). */
  readOnlyTestPaths: string[];
}

// ---------------------------------------------------------------------------
// runSecuritySmoke()
// ---------------------------------------------------------------------------

/**
 * Run all five security smoke tests and return structured results.
 */
export async function runSecuritySmoke(deps: SmokeTestDeps): Promise<SmokeTestResult> {
  const checks = await Promise.all([
    checkNetworkIsolation(deps),
    checkFilesystemReadonly(deps),
    checkIpcBinaryExclusive(deps),
    checkCredentialPermissions(deps),
    checkImageDigest(deps),
  ]);

  return {
    passed: checks.every((c) => c.passed),
    timestamp: new Date().toISOString(),
    checks,
  };
}

// ---------------------------------------------------------------------------
// Check 1: Network isolation
// ---------------------------------------------------------------------------

async function checkNetworkIsolation(deps: SmokeTestDeps): Promise<SmokeCheckResult> {
  const name = 'container-network-isolation';
  const description = 'Container cannot reach external network (DNS + HTTP blocked)';

  let dnsReachable = false;
  let httpReachable = false;

  try {
    dnsReachable = await deps.resolveDns('dns.google');
  } catch {
    // Error means network is blocked — good
  }

  try {
    httpReachable = await deps.httpGet('https://connectivity-check.ubuntu.com/');
  } catch {
    // Error means network is blocked — good
  }

  const passed = !dnsReachable && !httpReachable;

  return {
    name,
    passed,
    description,
    remediation: passed
      ? undefined
      : 'Container has network access. Ensure the container is started with ' +
        '--network=none (Docker/Podman) or network isolation enabled (Apple Containers).',
  };
}

// ---------------------------------------------------------------------------
// Check 2: Filesystem read-only
// ---------------------------------------------------------------------------

async function checkFilesystemReadonly(deps: SmokeTestDeps): Promise<SmokeCheckResult> {
  const name = 'container-filesystem-readonly';
  const description = 'Container filesystem is read-only outside writable mounts';

  const writablePaths: string[] = [];
  for (const testPath of deps.readOnlyTestPaths) {
    if (deps.writeTestFile(testPath)) {
      writablePaths.push(testPath);
    }
  }

  const passed = writablePaths.length === 0;

  return {
    name,
    passed,
    description,
    remediation: passed
      ? undefined
      : `Container filesystem is writable at: ${writablePaths.join(', ')}. ` +
        'Ensure the container is started with --read-only flag.',
  };
}

// ---------------------------------------------------------------------------
// Check 3: IPC binary exclusive
// ---------------------------------------------------------------------------

async function checkIpcBinaryExclusive(deps: SmokeTestDeps): Promise<SmokeCheckResult> {
  const name = 'ipc-binary-exclusive';
  const description = 'Only the ipc binary is executable in the container';

  const unexpectedExecutables: string[] = [];
  for (const binPath of deps.containerBinPaths) {
    const isIpc = binPath.endsWith('/ipc');
    if (!isIpc && deps.isExecutable(binPath)) {
      unexpectedExecutables.push(binPath);
    }
  }

  const passed = unexpectedExecutables.length === 0;

  return {
    name,
    passed,
    description,
    remediation: passed
      ? undefined
      : `Unexpected executable binaries found: ${unexpectedExecutables.join(', ')}. ` +
        'Remove execute permissions from non-ipc binaries in the container image.',
  };
}

// ---------------------------------------------------------------------------
// Check 4: Credential directory permissions
// ---------------------------------------------------------------------------

async function checkCredentialPermissions(deps: SmokeTestDeps): Promise<SmokeCheckResult> {
  const name = 'credential-directory-permissions';
  const description = 'Credential directory has restrictive permissions (0700)';

  const perms = deps.getPermissions(deps.credentialDir);

  if (perms === null) {
    return {
      name,
      passed: false,
      description,
      remediation:
        `Credential directory does not exist: ${deps.credentialDir}. ` +
        `Create it with: mkdir -p ${deps.credentialDir} && chmod 700 ${deps.credentialDir}`,
    };
  }

  const mode = perms & 0o777;
  const passed = mode === 0o700;

  return {
    name,
    passed,
    description,
    remediation: passed
      ? undefined
      : `Credential directory has permissions ${mode.toString(8)} ` +
        `(expected 700). Fix with: chmod 700 ${deps.credentialDir}`,
  };
}

// ---------------------------------------------------------------------------
// Check 5: Image digest match
// ---------------------------------------------------------------------------

async function checkImageDigest(deps: SmokeTestDeps): Promise<SmokeCheckResult> {
  const name = 'image-digest-match';
  const description = 'Running container image digest matches pinned config value';

  let runningDigest: string | null = null;
  try {
    runningDigest = await deps.getRunningImageDigest();
  } catch {
    return {
      name,
      passed: false,
      description,
      remediation:
        'Could not retrieve running container image digest. ' +
        'Ensure the container runtime is accessible.',
    };
  }

  const pinnedDigest = deps.getPinnedImageDigest();

  if (runningDigest === null) {
    return {
      name,
      passed: false,
      description,
      remediation:
        'Running container image digest is unavailable. ' +
        'Ensure the container is running and inspect is accessible.',
    };
  }

  if (pinnedDigest === null) {
    return {
      name,
      passed: false,
      description,
      remediation:
        'No pinned image digest found in config. ' +
        'Set runtime.image to a digest-pinned reference in config.toml.',
    };
  }

  const passed = runningDigest === pinnedDigest;

  return {
    name,
    passed,
    description,
    remediation: passed
      ? undefined
      : `Image digest mismatch. Running: ${runningDigest}, Pinned: ${pinnedDigest}. ` +
        'Pull the correct image or update the pinned digest in config.toml.',
  };
}
