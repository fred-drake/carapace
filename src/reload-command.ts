/**
 * Reload command — trigger plugin and skill hot-reload on a running server.
 *
 * Writes a trigger JSON file to the server's reload directory.
 * The server watches this directory and orchestrates the reload
 * (unload old plugins, re-discover, re-load, re-aggregate skills).
 *
 * Usage:
 *   carapace reload              # reload all plugins
 *   carapace reload my-plugin    # reload a specific plugin
 */

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/** Injectable dependencies for the reload command. */
export interface ReloadDeps {
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
  /** CARAPACE_HOME path. */
  home: string;
  /** Read the PID from the PID file, or null if absent. */
  readPidFile: () => number | null;
  /** Check whether a process with the given PID exists. */
  processExists: (pid: number) => boolean;
  /** Write string contents to a file. */
  writeFile: (path: string, content: string) => void;
  /** Create a directory (recursive). */
  ensureDir: (path: string) => void;
}

// ---------------------------------------------------------------------------
// Reload trigger
// ---------------------------------------------------------------------------

/** Well-known subdirectory under CARAPACE_HOME/run for reload trigger files. */
export const RELOAD_DIR_NAME = 'reload';

/** Shape of the trigger file written to disk. */
export interface ReloadTrigger {
  id: string;
  timestamp: string;
  plugin: string | null;
}

/**
 * Submit a reload trigger to the running Carapace server.
 *
 * Creates a JSON trigger file in the server's reload directory.
 * The server watches this directory and processes reload requests.
 *
 * @param deps - Injected dependencies.
 * @param pluginName - Optional plugin name to reload (null = reload all).
 * @returns Exit code (0 = success, 1 = failure).
 */
export function runReload(deps: ReloadDeps, pluginName?: string): number {
  // Check that Carapace is running
  const pid = deps.readPidFile();
  if (pid === null) {
    deps.stderr('Carapace is not running. Start it first: carapace start');
    return 1;
  }
  if (!deps.processExists(pid)) {
    deps.stderr('Carapace is not running (stale PID file). Start it first: carapace start');
    return 1;
  }

  // Build trigger payload
  const id = randomUUID();
  const trigger: ReloadTrigger = {
    id,
    timestamp: new Date().toISOString(),
    plugin: pluginName ?? null,
  };

  // Write to reload directory
  const reloadDir = join(deps.home, 'run', RELOAD_DIR_NAME);
  deps.ensureDir(reloadDir);

  const filePath = join(reloadDir, `${id}.json`);
  deps.writeFile(filePath, JSON.stringify(trigger));

  if (pluginName) {
    deps.stdout(`Reload requested for plugin "${pluginName}" (${id})`);
  } else {
    deps.stdout(`Reload requested for all plugins (${id})`);
  }

  return 0;
}
