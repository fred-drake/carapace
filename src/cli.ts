/**
 * Carapace CLI entry point.
 *
 * Provides the `carapace` command with subcommands:
 *   - `start`  — Launch the system (init, detect runtime, write PID file).
 *   - `stop`   — Graceful shutdown via PID file signal.
 *   - `status` — Show whether Carapace is running.
 *   - `doctor` — Check dependencies and configuration.
 *
 * All external dependencies are injected via {@link CliDeps} for testability.
 * The real `main()` wires production dependencies and calls `runCommand()`.
 */

import { VERSION } from './index.js';
import type { ContainerRuntime } from './core/container/runtime.js';
import type { CarapaceConfig, DirectoryStructure } from './types/config.js';

// ---------------------------------------------------------------------------
// CLI dependency injection
// ---------------------------------------------------------------------------

/** Injectable dependencies for CLI commands. */
export interface CliDeps {
  /** Write to stdout. */
  stdout: (msg: string) => void;
  /** Write to stderr. */
  stderr: (msg: string) => void;
  /** Resolved CARAPACE_HOME path. */
  home: string;
  /** Node.js version string (e.g. "v22.5.0"). */
  nodeVersion: string;
  /** Host platform (e.g. "darwin", "linux"). */
  platform: string;
  /** Container runtimes to probe. */
  runtimes: ContainerRuntime[];
  /** Read the PID from the PID file, or null if absent. */
  readPidFile: () => number | null;
  /** Write a PID to the PID file. */
  writePidFile: (pid: number) => void;
  /** Remove the PID file. */
  removePidFile: () => void;
  /** Check whether a process with the given PID exists. */
  processExists: (pid: number) => boolean;
  /** Send a signal to a process. */
  sendSignal: (pid: number, signal: string) => void;
  /** Load and validate config from CARAPACE_HOME. */
  loadConfig: (home: string) => CarapaceConfig;
  /** Ensure directory structure exists under CARAPACE_HOME. */
  ensureDirs: (home: string) => DirectoryStructure;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Parsed CLI arguments. */
export interface ParsedArgs {
  command: string;
  flags: Record<string, boolean>;
}

/**
 * Parse process.argv into a command and flags.
 *
 * Expects argv in the form: [node, script, command?, ...flags]
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const flags: Record<string, boolean> = {};
  let command = '';

  for (const arg of args) {
    if (arg.startsWith('--')) {
      flags[arg.slice(2)] = true;
    } else if (!command) {
      command = arg;
    }
  }

  return { command, flags };
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

const USAGE = `Usage: carapace <command>

Commands:
  start    Launch the Carapace system
  stop     Gracefully shut down
  status   Show whether Carapace is running
  doctor   Check dependencies and configuration

Options:
  --version  Show version number
  --help     Show this help message`;

/**
 * Dispatch a command string to the appropriate handler.
 *
 * @returns Process exit code (0 = success, 1 = failure).
 */
export async function runCommand(command: string, deps: CliDeps): Promise<number> {
  if (command === '--version') {
    deps.stdout(VERSION);
    return 0;
  }

  if (command === '' || command === '--help') {
    deps.stdout(USAGE);
    return 0;
  }

  switch (command) {
    case 'start':
      return start(deps);
    case 'stop':
      return stop(deps);
    case 'status':
      return status(deps);
    case 'doctor':
      return doctor(deps);
    default:
      deps.stderr(`Unknown command: "${command}"\n`);
      deps.stdout(USAGE);
      return 1;
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * Check all prerequisites and report status.
 *
 * Checks:
 *   1. Node.js version >= 22
 *   2. At least one container runtime available
 *   3. CARAPACE_HOME directory structure valid
 *   4. config.toml parses successfully
 */
export async function doctor(deps: CliDeps): Promise<number> {
  const checks: CheckResult[] = [];

  // 1. Node.js version
  const nodeCheck = checkNodeVersion(deps.nodeVersion);
  checks.push(nodeCheck);
  if (nodeCheck.passed) {
    deps.stdout(`  PASS  Node.js ${deps.nodeVersion}`);
  } else {
    deps.stderr(`  FAIL  Node.js >= 22 required (found ${deps.nodeVersion})`);
  }

  // 2. Container runtime
  const runtimeCheck = await checkContainerRuntime(deps.runtimes);
  checks.push(runtimeCheck);
  if (runtimeCheck.passed) {
    deps.stdout(`  PASS  Container runtime: ${runtimeCheck.detail}`);
  } else {
    deps.stderr(`  FAIL  No container runtime found`);
  }

  // 3. Directory structure
  const dirCheck = checkDirectoryStructure(deps);
  checks.push(dirCheck);
  if (dirCheck.passed) {
    deps.stdout(`  PASS  CARAPACE_HOME directory structure (${deps.home})`);
  } else {
    deps.stderr(`  FAIL  CARAPACE_HOME: ${dirCheck.detail}`);
  }

  // 4. Config validation
  const configCheck = checkConfig(deps);
  checks.push(configCheck);
  if (configCheck.passed) {
    deps.stdout(`  PASS  config.toml valid`);
  } else {
    deps.stderr(`  FAIL  config: ${configCheck.detail}`);
  }

  // Summary
  const passed = checks.filter((c) => c.passed).length;
  const total = checks.length;
  const allPassed = passed === total;

  deps.stdout(`\n${passed}/${total} checks passed`);

  return allPassed ? 0 : 1;
}

function checkNodeVersion(versionString: string): CheckResult {
  const match = versionString.match(/^v?(\d+)/);
  const major = match ? parseInt(match[1], 10) : 0;
  return {
    name: 'node-version',
    passed: major >= 22,
    detail: versionString,
  };
}

async function checkContainerRuntime(runtimes: ContainerRuntime[]): Promise<CheckResult> {
  for (const rt of runtimes) {
    try {
      const available = await rt.isAvailable();
      if (available) {
        const version = await rt.version();
        return {
          name: 'container-runtime',
          passed: true,
          detail: `${rt.name} (${version})`,
        };
      }
    } catch {
      // Try next runtime
    }
  }

  return {
    name: 'container-runtime',
    passed: false,
    detail: 'none',
  };
}

function checkDirectoryStructure(deps: CliDeps): CheckResult {
  try {
    deps.ensureDirs(deps.home);
    return { name: 'directory-structure', passed: true, detail: deps.home };
  } catch (err) {
    return {
      name: 'directory-structure',
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkConfig(deps: CliDeps): CheckResult {
  try {
    deps.loadConfig(deps.home);
    return { name: 'config', passed: true, detail: 'valid' };
  } catch (err) {
    return {
      name: 'config',
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/**
 * Initialize and start the Carapace system.
 *
 * 1. Check for an already-running instance (PID file).
 * 2. Initialize CARAPACE_HOME directory structure.
 * 3. Load and validate configuration.
 * 4. Detect an available container runtime.
 * 5. Write PID file.
 */
export async function start(deps: CliDeps): Promise<number> {
  // Check if already running
  const existingPid = deps.readPidFile();
  if (existingPid !== null) {
    if (deps.processExists(existingPid)) {
      deps.stderr(`Carapace is already running (PID ${existingPid})`);
      return 1;
    }
    // Stale PID file — clean it up
    deps.removePidFile();
  }

  // Initialize directory structure
  deps.ensureDirs(deps.home);

  // Load config
  const config = deps.loadConfig(deps.home);

  // Detect container runtime
  let runtimeName = 'none';
  let found = false;
  for (const rt of deps.runtimes) {
    try {
      const available = await rt.isAvailable();
      if (available) {
        const version = await rt.version();
        runtimeName = `${rt.name} (${version})`;
        found = true;
        break;
      }
    } catch {
      // Try next
    }
  }

  if (!found) {
    deps.stderr('No container runtime found. Install Docker, Podman, or Apple Containers.');
    return 1;
  }

  // Write PID file
  deps.writePidFile(process.pid);

  deps.stdout(`Carapace started`);
  deps.stdout(`  Home:    ${deps.home}`);
  deps.stdout(`  Runtime: ${runtimeName}`);
  deps.stdout(`  Engine:  ${config.runtime.engine}`);

  return 0;
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

/**
 * Gracefully stop a running Carapace instance.
 *
 * Reads the PID file and sends SIGTERM to the process.
 */
export async function stop(deps: CliDeps): Promise<number> {
  const pid = deps.readPidFile();

  if (pid === null) {
    deps.stderr('Carapace is not running (no PID file)');
    return 1;
  }

  if (!deps.processExists(pid)) {
    deps.removePidFile();
    deps.stderr('Carapace is not running (stale PID file removed)');
    return 1;
  }

  deps.sendSignal(pid, 'SIGTERM');
  deps.stdout(`Sent shutdown signal to Carapace (PID ${pid})`);

  return 0;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Report whether Carapace is currently running.
 */
export async function status(deps: CliDeps): Promise<number> {
  const pid = deps.readPidFile();

  if (pid === null) {
    deps.stdout('Carapace is not running');
    return 1;
  }

  if (!deps.processExists(pid)) {
    deps.removePidFile();
    deps.stdout('Carapace is not running (stale PID file cleaned)');
    return 1;
  }

  deps.stdout(`Carapace is running (PID ${pid})`);

  return 0;
}
