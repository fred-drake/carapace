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
  /** Return the octal permission mode of a path (e.g. 0o700), or null if not found. */
  fileMode: (path: string) => number | null;
  /** List files in a directory, or empty array if it doesn't exist. */
  listDir: (path: string) => string[];
  /** Host platform (e.g. "darwin", "linux"). */
  platform: string;
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

/** Check that the socket directory has 0700 permissions (owner-only). */
export function checkSocketPermissions(
  socketPath: string,
  fileMode: (path: string) => number | null,
): HealthCheckResult {
  const mode = fileMode(socketPath);
  if (mode === null) {
    return {
      name: 'socket-permissions',
      label: 'Socket permissions',
      status: 'warn',
      detail: `Cannot read permissions: ${socketPath}`,
      fix: `Ensure directory exists: mkdir -p ${socketPath} && chmod 700 ${socketPath}`,
    };
  }

  const perms = mode & 0o777;
  if (perms === 0o700) {
    return {
      name: 'socket-permissions',
      label: 'Socket permissions',
      status: 'pass',
      detail: `0${perms.toString(8)} (owner-only)`,
    };
  }

  return {
    name: 'socket-permissions',
    label: 'Socket permissions',
    status: 'fail',
    detail: `0${perms.toString(8)} (expected 0700)`,
    fix: `Fix permissions: chmod 700 ${socketPath}`,
  };
}

/** Check for stale socket files left by crashed sessions. */
export function checkStaleSockets(
  socketPath: string,
  listDir: (path: string) => string[],
): HealthCheckResult {
  const files = listDir(socketPath);
  const sockFiles = files.filter((f) => f.endsWith('.sock'));

  if (sockFiles.length === 0) {
    return {
      name: 'stale-sockets',
      label: 'Stale sockets',
      status: 'pass',
      detail: 'No stale socket files',
    };
  }

  return {
    name: 'stale-sockets',
    label: 'Stale sockets',
    status: 'warn',
    detail: `${sockFiles.length} stale socket file(s): ${sockFiles.join(', ')}`,
    fix:
      'These will be cleaned up on next start, or remove manually: rm ' +
      sockFiles.map((f) => `${socketPath}/${f}`).join(' '),
  };
}

/**
 * Check that socket file paths won't exceed the Unix domain socket limit.
 * macOS: 104 bytes, Linux: 108 bytes. The longest socket path is
 * {socketPath}/{sessionId}-request.sock — we check with a realistic
 * session ID length.
 */
export function checkSocketPathLength(socketPath: string, platform: string): HealthCheckResult {
  const limit = platform === 'darwin' ? 104 : 108;
  // Worst-case session ID: "session-" + UUID (36 chars) + "-request.sock" (13 chars)
  const worstCaseSuffix = '/session-01234567-89ab-cdef-0123-456789abcdef-request.sock';
  const worstCasePath = socketPath + worstCaseSuffix;

  if (worstCasePath.length <= limit) {
    return {
      name: 'socket-path-length',
      label: 'Socket path length',
      status: 'pass',
      detail: `${socketPath.length} chars (limit ${limit} for ${platform})`,
    };
  }

  const maxSocketDir = limit - worstCaseSuffix.length;
  return {
    name: 'socket-path-length',
    label: 'Socket path length',
    status: 'fail',
    detail: `${socketPath.length} chars — socket paths will exceed ${limit}-byte ${platform} limit`,
    fix: `Move CARAPACE_HOME to a shorter path (socket dir must be under ${maxSocketDir} chars)`,
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
  results.push(checkSocketPermissions(deps.socketPath, deps.fileMode));
  results.push(checkStaleSockets(deps.socketPath, deps.listDir));
  results.push(checkSocketPathLength(deps.socketPath, deps.platform));

  return results;
}
