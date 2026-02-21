/**
 * Prompt command — submit a task prompt to a running Carapace server.
 *
 * Writes a `task.triggered` event file to the server's prompts directory.
 * The server watches this directory and dispatches incoming events through
 * the EventDispatcher → ContainerLifecycleManager pipeline.
 *
 * Usage:
 *   carapace prompt "summarize my emails"
 *   carapace prompt --group=email "check inbox"
 */

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type EventEnvelope } from './types/protocol.js';

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/** Injectable dependencies for the prompt command. */
export interface PromptDeps {
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
// Prompt submission
// ---------------------------------------------------------------------------

/** Well-known subdirectory under CARAPACE_HOME/run for prompt files. */
export const PROMPTS_DIR_NAME = 'prompts';

/**
 * Submit a prompt to the running Carapace server.
 *
 * Creates a task.triggered event file in the server's prompts directory.
 * The server watches this directory and dispatches events to the
 * EventDispatcher.
 *
 * @param deps - Injected dependencies.
 * @param promptText - The prompt text to submit.
 * @param group - Target group (default: "default").
 * @returns Exit code (0 = success, 1 = failure).
 */
export function runPrompt(deps: PromptDeps, promptText: string, group: string): number {
  // Validate prompt text
  if (!promptText) {
    deps.stderr('Usage: carapace prompt "your prompt text"');
    deps.stderr('  --group=NAME  Target group (default: "default")');
    return 1;
  }

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

  // Build event envelope
  const id = randomUUID();
  const envelope: EventEnvelope = {
    id,
    version: PROTOCOL_VERSION,
    type: 'event',
    topic: 'task.triggered',
    source: 'cli',
    correlation: null,
    timestamp: new Date().toISOString(),
    group,
    payload: { prompt: promptText },
  };

  // Write to prompts directory
  const promptsDir = join(deps.home, 'run', PROMPTS_DIR_NAME);
  deps.ensureDir(promptsDir);

  const filePath = join(promptsDir, `${id}.json`);
  deps.writeFile(filePath, JSON.stringify(envelope));

  deps.stdout(`Prompt submitted (${id})`);
  deps.stdout(`  Group: ${group}`);

  return 0;
}
