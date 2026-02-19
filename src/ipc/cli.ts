/**
 * IPC CLI argument parser and output formatter.
 *
 * Provides the parsing and formatting logic for the `ipc` binary.
 * Separated from the binary entry point so it can be tested without
 * spawning a process.
 *
 * Usage: ipc <topic> <arguments-json>
 */

import type { ResponseEnvelope } from '../types/protocol.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed CLI arguments. */
export interface CliArgs {
  topic: string;
  arguments: Record<string, unknown>;
}

/** Result of parsing CLI arguments. */
export type ParseResult = { ok: true; value: CliArgs } | { ok: false; error: string };

/** Formatted output for the process. */
export interface CliOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

/**
 * Parse process.argv-style arguments into a topic and arguments object.
 *
 * Expects: [node, script, topic, arguments-json]
 *
 * @param argv - The process.argv array.
 * @returns A ParseResult indicating success or a descriptive error.
 */
export function parseCliArgs(argv: string[]): ParseResult {
  const topic = argv[2];
  const argsJson = argv[3];

  if (!topic || !argsJson) {
    return {
      ok: false,
      error: 'Usage: ipc <topic> <arguments-json>',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return {
      ok: false,
      error: `Invalid JSON in arguments: ${argsJson}`,
    };
  }

  if (
    parsed === null ||
    parsed === undefined ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return {
      ok: false,
      error: 'Arguments must be a JSON object (not array, string, or null)',
    };
  }

  return {
    ok: true,
    value: {
      topic,
      arguments: parsed as Record<string, unknown>,
    },
  };
}

// ---------------------------------------------------------------------------
// formatOutput
// ---------------------------------------------------------------------------

/**
 * Format a response envelope into CLI output.
 *
 * - Success (no error): print result JSON to stdout, exit 0.
 * - Error: print error JSON to stderr, exit 1.
 *
 * @param response - The response envelope from the host.
 * @returns A CliOutput with exit code and stdout/stderr strings.
 */
export function formatOutput(response: ResponseEnvelope): CliOutput {
  if (response.payload.error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: JSON.stringify(response.payload.error),
    };
  }

  return {
    exitCode: 0,
    stdout: JSON.stringify(response.payload.result),
    stderr: '',
  };
}
