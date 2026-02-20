/**
 * Production entry point for Carapace.
 *
 * Wires real dependencies (filesystem, process, container runtimes)
 * into CliDeps and dispatches to the CLI command handler.
 *
 * Usage:
 *   node dist/main.js doctor
 *   node dist/main.js start
 *   node dist/main.js stop
 */

import {
  readFileSync,
  existsSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  statSync,
  rmSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

import { parseArgs, runCommand } from './cli.js';
import type { CliDeps } from './cli.js';
import { resolveHome, ensureDirectoryStructure } from './types/config.js';
import { loadConfig } from './core/config-loader.js';
import { DockerRuntime } from './core/container/docker-runtime.js';
import { PodmanRuntime } from './core/container/podman-runtime.js';
import { AppleContainerRuntime } from './core/container/apple-container-runtime.js';
import { Server } from './core/server.js';
import type { ServerConfig, ServerDeps } from './core/server.js';
import { ZmqSocketFactory } from './core/zmq-socket-factory.js';

// ---------------------------------------------------------------------------
// PID file helpers
// ---------------------------------------------------------------------------

function pidFilePath(home: string): string {
  return join(home, 'run', 'carapace.pid');
}

function readPidFile(home: string): number | null {
  const path = pidFilePath(home);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf-8').trim();
  const pid = parseInt(content, 10);
  return Number.isNaN(pid) ? null : pid;
}

function writePidFile(home: string, pid: number): void {
  writeFileSync(pidFilePath(home), `${pid}\n`, 'utf-8');
}

function removePidFile(home: string): void {
  const path = pidFilePath(home);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function fileMode(path: string): number | null {
  try {
    return statSync(path).mode;
  } catch {
    return null;
  }
}

function dirSize(path: string): number {
  try {
    let total = 0;
    const entries = readdirSync(path, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(full);
      } else {
        total += statSync(full).size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function exec(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const stdout = execFileSync(file, [...args], { encoding: 'utf-8', timeout: 10_000 });
    return Promise.resolve({ stdout, stderr: '' });
  } catch (err: unknown) {
    return Promise.reject(err);
  }
}

const esmRequire = createRequire(import.meta.url);

function resolveModule(name: string): string {
  return esmRequire.resolve(name);
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

async function promptString(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function promptSecret(prompt: string): Promise<string> {
  // For now, same as promptString — proper masking needs raw mode
  return promptString(prompt);
}

async function confirm(prompt: string): Promise<boolean> {
  const answer = await promptString(`${prompt} (y/N) `);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

// ---------------------------------------------------------------------------
// Server factory for start command
// ---------------------------------------------------------------------------

function createStartServer(home: string): {
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const socketDir = join(home, 'run', 'sockets');
  const pluginsDir = join(home, 'plugins');

  const config: ServerConfig = {
    socketDir,
    pluginsDir,
  };

  const deps: ServerDeps = {
    socketFactory: new ZmqSocketFactory(),
    output: (msg: string) => process.stdout.write(`${msg}\n`),
  };

  const server = new Server(config, deps);
  return server;
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

/**
 * Production main() — wires real deps and dispatches commands.
 *
 * @param argv - Process arguments (defaults to process.argv).
 * @returns Exit code (0 = success, non-zero = failure).
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  const { command: parsedCommand, subcommand, flags } = parseArgs(argv);
  const home = resolveHome();

  // Translate flags to pseudo-commands for runCommand compatibility
  let command = parsedCommand;
  if (!command && flags['version']) {
    command = '--version';
  } else if (!command && flags['help']) {
    command = '--help';
  }

  const deps: CliDeps = {
    stdout: (msg: string) => process.stdout.write(`${msg}\n`),
    stderr: (msg: string) => process.stderr.write(`${msg}\n`),
    home,
    nodeVersion: process.version,
    platform: process.platform,
    runtimes: [new DockerRuntime(), new PodmanRuntime(), new AppleContainerRuntime()],
    readPidFile: () => readPidFile(home),
    writePidFile: (pid: number) => writePidFile(home, pid),
    removePidFile: () => removePidFile(home),
    processExists,
    sendSignal: (pid: number, signal: string) => process.kill(pid, signal),
    loadConfig: (h: string) => loadConfig(h),
    ensureDirs: (h: string) => ensureDirectoryStructure(h),
    exec,
    resolveModule,
    pluginDirs: [],
    socketPath: join(home, 'run', 'sockets'),
    dirExists,
    isWritable,
    fileMode,
    userHome: homedir(),
    dirSize,
    removeDir: (path: string) => rmSync(path, { recursive: true, force: true }),
    readFile: (path: string) => readFileSync(path, 'utf-8'),
    writeFile: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
    shellConfigPaths: () => {
      const h = homedir();
      return [
        join(h, '.bashrc'),
        join(h, '.zshrc'),
        join(h, '.profile'),
        join(h, '.bash_profile'),
      ].filter(existsSync);
    },
    listDir: (path: string) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    confirm,
    promptSecret,
    promptString,
    validateApiKey: async () => ({ valid: true }),
    fileExists: (path: string) => existsSync(path),
    writeFileSecure: (path: string, content: string, mode: number) => {
      writeFileSync(path, content, { mode });
    },
    fileStat: (path: string) => {
      try {
        const s = statSync(path);
        return { mtime: s.mtime };
      } catch {
        return null;
      }
    },
    startServer: () => createStartServer(home),
  };

  return runCommand(command, deps, flags, subcommand);
}

// ---------------------------------------------------------------------------
// Entry point — run when executed directly
// ---------------------------------------------------------------------------

/* c8 ignore next 3 */
main().then((code) => {
  process.exitCode = code;
});
