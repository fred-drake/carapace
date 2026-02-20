/**
 * Carapace CLI entry point.
 *
 * Provides the `carapace` command with subcommands:
 *   - `start`  — Launch the system (init, detect runtime, write PID file).
 *   - `stop`   — Graceful shutdown via PID file signal.
 *   - `status` — Show whether Carapace is running.
 *   - `doctor` — Check dependencies and configuration.
 *   - `uninstall` — Remove Carapace installation.
 *   - `auth`      — Manage credentials (api-key, login, status).
 *
 * All external dependencies are injected via {@link CliDeps} for testability.
 * The real `main()` wires production dependencies and calls `runCommand()`.
 */

import { VERSION } from './index.js';
import type { ContainerRuntime } from './core/container/runtime.js';
import type { CarapaceConfig, DirectoryStructure } from './types/config.js';
import { runAllChecks, type ExecFn, type ResolveModuleFn } from './core/health-checks.js';
import { runUninstall, type UninstallDeps } from './uninstall.js';
import {
  runAuthApiKey,
  runAuthLogin,
  runAuthStatus,
  type AuthDeps,
  type ValidationResult,
  type CredentialInfo,
} from './auth-command.js';
import { isImageCurrent } from './core/image-identity.js';

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
  /** Execute a CLI tool (for health checks). */
  exec: ExecFn;
  /** Resolve a Node.js module path (for health checks). */
  resolveModule: ResolveModuleFn;
  /** Extra plugin directories to verify (from config). */
  pluginDirs: string[];
  /** Unix socket path to verify writability. */
  socketPath: string;
  /** Check if a directory exists. */
  dirExists: (path: string) => boolean;
  /** Check if a path is writable. */
  isWritable: (path: string) => boolean;
  /** Return the octal permission mode of a path, or null if not found. */
  fileMode: (path: string) => number | null;
  /** User's home directory. */
  userHome: string;
  /** Get total size of a directory in bytes. */
  dirSize: (path: string) => number;
  /** Remove a directory recursively. */
  removeDir: (path: string) => void;
  /** Read file contents as string. */
  readFile: (path: string) => string;
  /** Write string contents to a file. */
  writeFile: (path: string, content: string) => void;
  /** Return candidate shell config file paths. */
  shellConfigPaths: () => string[];
  /** List entries in a directory (basenames only). */
  listDir: (path: string) => string[];
  /** Ask user for confirmation. Returns true if confirmed. */
  confirm: (prompt: string) => Promise<boolean>;
  /** Prompt for a secret value (masked input). */
  promptSecret: (prompt: string) => Promise<string>;
  /** Prompt for a string value (visible input). */
  promptString: (prompt: string) => Promise<string>;
  /** Validate an Anthropic API key. */
  validateApiKey: (key: string) => Promise<ValidationResult>;
  /** Check if a file exists. */
  fileExists: (path: string) => boolean;
  /** Write file with specific permissions. */
  writeFileSecure: (path: string, content: string, mode: number) => void;
  /** Get file stat info, or null if not found. */
  fileStat: (path: string) => CredentialInfo | null;
  /** Create a server instance for the start command. Optional — omit in tests. */
  startServer?: () => { start: () => Promise<void>; stop: () => Promise<void> };
  /** Resolve current git SHA. */
  resolveGitSha?: () => Promise<string>;
  /** Inspect OCI labels on an image. */
  inspectImageLabels?: (image: string) => Promise<Record<string, string>>;
  /** Build the container image. */
  buildImage?: (contextDir: string) => Promise<{
    tag: string;
    gitSha: string;
    claudeVersion: string;
    carapaceVersion: string;
    buildDate: string;
  }>;
  /** Path to the project root (build context). */
  projectRoot?: string;
  /** Default image name to check/use. */
  imageName?: string;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Parsed CLI arguments. */
export interface ParsedArgs {
  command: string;
  subcommand: string;
  flags: Record<string, boolean>;
}

/**
 * Parse process.argv into a command, optional subcommand, and flags.
 *
 * Expects argv in the form: [node, script, command?, subcommand?, ...flags]
 * For commands with subcommands (e.g. `auth api-key`), both are captured.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const flags: Record<string, boolean> = {};
  let command = '';
  let subcommand = '';

  for (const arg of args) {
    if (arg.startsWith('--')) {
      flags[arg.slice(2)] = true;
    } else if (!command) {
      command = arg;
    } else if (!subcommand) {
      subcommand = arg;
    }
  }

  return { command, subcommand, flags };
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

const USAGE = `Usage: carapace <command>

Commands:
  start            Launch the Carapace system
  stop             Gracefully shut down
  status           Show whether Carapace is running
  doctor           Check dependencies and configuration
  uninstall        Remove Carapace installation
  auth api-key     Configure Anthropic API key
  auth login       Configure OAuth token
  auth status      Show credential status

Options:
  --version    Show version number
  --help       Show this help message
  --yes        Skip confirmation prompts (uninstall)
  --dry-run    Show what would be done without acting (uninstall)`;

/**
 * Dispatch a command string to the appropriate handler.
 *
 * @returns Process exit code (0 = success, 1 = failure).
 */
export async function runCommand(
  command: string,
  deps: CliDeps,
  flags?: Record<string, boolean>,
  subcommand?: string,
): Promise<number> {
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
    case 'uninstall':
      return uninstall(deps, flags ?? {});
    case 'auth':
      return auth(deps, subcommand ?? '');
    default:
      deps.stderr(`Unknown command: "${command}"\n`);
      deps.stdout(USAGE);
      return 1;
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/**
 * Check all prerequisites and report status.
 *
 * Delegates to the health-checks module for individual checks, then
 * displays results with fix suggestions for any failures.
 */
export async function doctor(deps: CliDeps): Promise<number> {
  // Ensure directory structure exists before checking writability
  deps.ensureDirs(deps.home);

  const results = await runAllChecks({
    nodeVersion: deps.nodeVersion,
    runtimes: deps.runtimes,
    exec: deps.exec,
    resolveModule: deps.resolveModule,
    pluginDirs: deps.pluginDirs,
    socketPath: deps.socketPath,
    dirExists: deps.dirExists,
    isWritable: deps.isWritable,
    fileMode: deps.fileMode,
    listDir: deps.listDir,
    platform: deps.platform,
  });

  for (const result of results) {
    if (result.status === 'pass') {
      deps.stdout(`  PASS  ${result.label}: ${result.detail}`);
    } else if (result.status === 'warn') {
      deps.stderr(`  WARN  ${result.label}: ${result.detail}`);
      if (result.fix) {
        deps.stderr(`        Fix: ${result.fix}`);
      }
    } else {
      deps.stderr(`  FAIL  ${result.label}: ${result.detail}`);
      if (result.fix) {
        deps.stderr(`        Fix: ${result.fix}`);
      }
    }
  }

  // Summary
  const passed = results.filter((r) => r.status === 'pass').length;
  const total = results.length;
  const allPassed = passed === total;

  deps.stdout(`\n${passed}/${total} checks passed`);

  return allPassed ? 0 : 1;
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
 * 6. Start the server (if startServer dep is provided).
 * 7. Block until SIGINT/SIGTERM (server mode).
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

  // Image staleness check
  const skipBuild = process.env.SKIP_IMAGE_BUILD === '1';

  if (
    deps.imageName &&
    deps.inspectImageLabels &&
    deps.resolveGitSha &&
    deps.buildImage &&
    deps.projectRoot
  ) {
    if (skipBuild) {
      deps.stdout('Skipping image build check (SKIP_IMAGE_BUILD=1)');
      // Verify image at least exists
      const runtime = deps.runtimes.find((r) => r.name);
      if (runtime) {
        try {
          const exists = await runtime.imageExists(deps.imageName);
          if (!exists) {
            deps.stderr(
              'No container image found. Run `carapace update` or unset SKIP_IMAGE_BUILD.',
            );
            return 1;
          }
        } catch {
          // Can't check — proceed anyway
        }
      }
    } else {
      try {
        const currentSha = await deps.resolveGitSha();
        let needsBuild = false;

        try {
          const labels = await deps.inspectImageLabels(deps.imageName);
          if (!isImageCurrent(labels, currentSha)) {
            deps.stdout('Image stale, rebuilding...');
            needsBuild = true;
          }
        } catch {
          // Image doesn't exist or can't be inspected
          deps.stdout('Container image not found, building...');
          needsBuild = true;
        }

        if (needsBuild) {
          try {
            const identity = await deps.buildImage(deps.projectRoot);
            deps.stdout(`Image built: ${identity.tag}`);
          } catch (err) {
            deps.stderr(`Image build failed: ${err instanceof Error ? err.message : String(err)}`);
            return 1;
          }
        }
      } catch (err) {
        // Git SHA resolution failed — skip staleness check
        deps.stderr(
          `Warning: Could not check image staleness: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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

  // Start server if factory is provided (production mode)
  if (deps.startServer) {
    const server = deps.startServer();
    await server.start();

    // Block until SIGINT or SIGTERM
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        void server.stop().then(() => {
          deps.removePidFile();
          resolve();
        });
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  }

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
const AUTH_USAGE = `Usage: carapace auth <subcommand>

Subcommands:
  api-key    Configure Anthropic API key
  login      Configure OAuth token
  status     Show credential status`;

/**
 * Dispatch auth subcommands.
 */
export async function auth(deps: CliDeps, subcommand: string): Promise<number> {
  const authDeps: AuthDeps = {
    stdout: deps.stdout,
    stderr: deps.stderr,
    home: deps.home,
    promptSecret: deps.promptSecret,
    promptString: deps.promptString,
    validateApiKey: deps.validateApiKey,
    fileExists: deps.fileExists,
    readFile: deps.readFile,
    writeFileSecure: deps.writeFileSecure,
    fileStat: deps.fileStat,
  };

  switch (subcommand) {
    case 'api-key':
      return runAuthApiKey(authDeps);
    case 'login':
      return runAuthLogin(authDeps);
    case 'status':
      return runAuthStatus(authDeps);
    default:
      if (subcommand) {
        deps.stderr(`Unknown auth subcommand: "${subcommand}"\n`);
      }
      deps.stdout(AUTH_USAGE);
      return subcommand ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

/**
 * Remove the Carapace installation.
 *
 * Bridges CliDeps to UninstallDeps and delegates to runUninstall().
 */
export async function uninstall(deps: CliDeps, flags: Record<string, boolean>): Promise<number> {
  const uninstallDeps: UninstallDeps = {
    stdout: deps.stdout,
    stderr: deps.stderr,
    home: deps.home,
    userHome: deps.userHome,
    readPidFile: deps.readPidFile,
    processExists: deps.processExists,
    confirm: deps.confirm,
    dirExists: deps.dirExists,
    dirSize: deps.dirSize,
    removeDir: deps.removeDir,
    readFile: deps.readFile,
    writeFile: deps.writeFile,
    shellConfigPaths: deps.shellConfigPaths,
    listDir: deps.listDir,
  };

  return runUninstall(uninstallDeps, {
    yes: flags['yes'] === true,
    dryRun: flags['dry-run'] === true,
  });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

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
