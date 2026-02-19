/**
 * Health check system for Carapace.
 *
 * Provides individual check functions and a runner that evaluates all
 * system prerequisites. Each check returns a structured result with
 * pass/fail status, a detail message, and a fix suggestion on failure.
 *
 * Used by `carapace doctor` (DEVOPS-05) and referenced by SEC-18
 * (credential directory) and future diagnostic commands.
 *
 * All external I/O is injected via {@link HealthCheckDeps} for testability.
 */

import type { ContainerRuntime } from './container/runtime.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a single health check. */
export interface HealthCheckResult {
  /** Machine-readable check identifier. */
  name: string;
  /** Human-readable check label for display. */
  label: string;
  /** Check outcome. */
  status: 'pass' | 'fail' | 'warn';
  /** Detail message (version string, error reason, etc.). */
  detail: string;
  /** Actionable fix suggestion (only present on failure). */
  fix?: string;
}

/** Injectable exec function for checking CLI tools. */
export type ExecFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Injectable module resolver for checking library availability. */
export type ResolveModuleFn = (module: string) => string;

/** Injectable dependencies for the health check runner. */
export interface HealthCheckDeps {
  nodeVersion: string;
  runtimes: ContainerRuntime[];
  exec: ExecFn;
  resolveModule: ResolveModuleFn;
  pluginDirs: string[];
  socketPath: string;
  dirExists: (path: string) => boolean;
  isWritable: (path: string) => boolean;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** Check that Node.js version is >= 22. */
export function checkNodeVersion(versionString: string): HealthCheckResult {
  const match = versionString.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return {
      name: 'node-version',
      label: 'Node.js',
      status: 'fail',
      detail: `Unrecognized version: ${versionString}`,
      fix: 'Install Node.js 22 or later: https://nodejs.org/',
    };
  }

  const major = parseInt(match[1], 10);
  if (major >= 22) {
    return {
      name: 'node-version',
      label: 'Node.js',
      status: 'pass',
      detail: `v${match[1]}.${match[2]}.${match[3]}`,
    };
  }

  return {
    name: 'node-version',
    label: 'Node.js',
    status: 'fail',
    detail: `v${match[1]}.${match[2]}.${match[3]} (requires >= 22)`,
    fix: 'Upgrade to Node.js 22 or later: https://nodejs.org/',
  };
}

/** Check that at least one container runtime is available. */
export async function checkContainerRuntime(
  runtimes: ContainerRuntime[],
): Promise<HealthCheckResult> {
  for (const rt of runtimes) {
    try {
      const available = await rt.isAvailable();
      if (available) {
        const version = await rt.version();
        return {
          name: 'container-runtime',
          label: 'Container runtime',
          status: 'pass',
          detail: `${rt.name} (${version})`,
        };
      }
    } catch {
      // Try next runtime
    }
  }

  return {
    name: 'container-runtime',
    label: 'Container runtime',
    status: 'fail',
    detail: 'No container runtime found',
    fix: 'Install Docker (docker.com), Podman (podman.io), or use Apple Containers on macOS 26+',
  };
}

/** Check that pnpm is installed and accessible. */
export async function checkPnpm(exec: ExecFn): Promise<HealthCheckResult> {
  try {
    const { stdout } = await exec('pnpm', ['--version']);
    const version = stdout.trim();
    return {
      name: 'pnpm',
      label: 'pnpm',
      status: 'pass',
      detail: `v${version}`,
    };
  } catch {
    return {
      name: 'pnpm',
      label: 'pnpm',
      status: 'fail',
      detail: 'Not found',
      fix: 'Install pnpm: npm install -g pnpm (or use corepack enable)',
    };
  }
}

/** Check that ZeroMQ native library is available. */
export function checkZeromq(resolve: ResolveModuleFn): HealthCheckResult {
  try {
    resolve('zeromq');
    return {
      name: 'zeromq',
      label: 'ZeroMQ library',
      status: 'pass',
      detail: 'Available',
    };
  } catch {
    return {
      name: 'zeromq',
      label: 'ZeroMQ library',
      status: 'fail',
      detail: 'Not found',
      fix: 'Install ZeroMQ: pnpm add zeromq (requires libzmq system library)',
    };
  }
}

/** Check that SQLite (better-sqlite3) is available. */
export function checkSqlite(resolve: ResolveModuleFn): HealthCheckResult {
  try {
    resolve('better-sqlite3');
    return {
      name: 'sqlite',
      label: 'SQLite (better-sqlite3)',
      status: 'pass',
      detail: 'Available',
    };
  } catch {
    return {
      name: 'sqlite',
      label: 'SQLite (better-sqlite3)',
      status: 'fail',
      detail: 'Not found',
      fix: 'Install better-sqlite3: pnpm add better-sqlite3',
    };
  }
}

/** Check that configured plugin directories exist. */
export function checkPluginDirs(
  dirs: string[],
  dirExists: (path: string) => boolean,
): HealthCheckResult {
  if (dirs.length === 0) {
    return {
      name: 'plugin-dirs',
      label: 'Plugin directories',
      status: 'pass',
      detail: 'OK (no extra plugin directories configured)',
    };
  }

  const missing = dirs.filter((d) => !dirExists(d));
  if (missing.length === 0) {
    return {
      name: 'plugin-dirs',
      label: 'Plugin directories',
      status: 'pass',
      detail: `All ${dirs.length} directories exist`,
    };
  }

  return {
    name: 'plugin-dirs',
    label: 'Plugin directories',
    status: 'fail',
    detail: `Missing: ${missing.join(', ')}`,
    fix: `Create missing directories: mkdir -p ${missing.join(' ')}`,
  };
}

/** Check that the socket path is writable. */
export function checkSocketPath(
  socketPath: string,
  isWritable: (path: string) => boolean,
): HealthCheckResult {
  if (isWritable(socketPath)) {
    return {
      name: 'socket-path',
      label: 'Socket path',
      status: 'pass',
      detail: socketPath,
    };
  }

  return {
    name: 'socket-path',
    label: 'Socket path',
    status: 'fail',
    detail: `Not writable: ${socketPath}`,
    fix: `Fix permissions: chmod 700 ${socketPath} (or check parent directory permissions)`,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Run all health checks and return results. */
export async function runAllChecks(deps: HealthCheckDeps): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  results.push(checkNodeVersion(deps.nodeVersion));
  results.push(await checkContainerRuntime(deps.runtimes));
  results.push(await checkPnpm(deps.exec));
  results.push(checkZeromq(deps.resolveModule));
  results.push(checkSqlite(deps.resolveModule));
  results.push(checkPluginDirs(deps.pluginDirs, deps.dirExists));
  results.push(checkSocketPath(deps.socketPath, deps.isWritable));

  return results;
}
