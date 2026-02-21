/**
 * Structured JSON logging for Carapace.
 *
 * Provides component-scoped loggers with level filtering, injectable
 * sinks for testing, and a container log router that maps container
 * stdout/stderr to host-side structured logs.
 *
 * All log output is JSON-formatted with level, ts, component,
 * and msg fields. Correlation fields are promoted to top-level
 * for LLM-friendly structured output.
 *
 * @example
 * ```ts
 * const logger = createLogger('router');
 * logger.info('request received', { topic: 'echo.run' });
 * // → {"level":"info","ts":"...","component":"router","msg":"request received","meta":{"topic":"echo.run"}}
 * ```
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Log severity levels in ascending order. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A structured log entry. */
export interface LogEntry {
  level: LogLevel;
  ts: string;
  component: string;
  msg: string;
  correlation?: string;
  topic?: string;
  group?: string;
  session?: string;
  duration_ms?: number;
  ok?: boolean;
  error_code?: string;
  trace?: string;
  meta?: Record<string, unknown>;
}

/** A function that consumes a log entry (output destination). */
export type LogSink = (entry: LogEntry) => void;

/** Context fields that are automatically promoted to every log entry. */
export interface LogContext {
  correlation?: string;
  topic?: string;
  group?: string;
  session?: string;
}

/** A structured logger scoped to a component. */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(subComponent: string): Logger;
  withContext(ctx: LogContext): Logger;
}

// ---------------------------------------------------------------------------
// Level ordering
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let globalLevel: LogLevel = 'info';
let globalSink: LogSink = defaultSink;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configure the global logging level and/or sink. */
export function configureLogging(options: { level?: LogLevel; sink?: LogSink }): void {
  if (options.level !== undefined) {
    globalLevel = options.level;
  }
  if (options.sink !== undefined) {
    globalSink = options.sink;
  }
}

/** Reset logging to defaults (level: info, sink: stdout JSON). */
export function resetLogging(): void {
  globalLevel = 'info';
  globalSink = defaultSink;
}

// ---------------------------------------------------------------------------
// Default sink (stdout JSON)
// ---------------------------------------------------------------------------

function defaultSink(entry: LogEntry): void {
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ---------------------------------------------------------------------------
// NEVER_LOG_FIELDS — deny-listed metadata keys
// ---------------------------------------------------------------------------

/** Metadata keys that must never appear in log output. */
export const NEVER_LOG_FIELDS = new Set([
  'stdinData',
  'apiKey',
  'api_key',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'password',
  'secret',
  'token',
  'credential',
  'authorization',
]);

/** Maximum length for string values in metadata before truncation. */
export const META_STRING_MAX_LENGTH = 1024;

// ---------------------------------------------------------------------------
// Metadata sanitization
// ---------------------------------------------------------------------------

/**
 * Strip denied keys, truncate long strings, and serialize Errors in metadata.
 */
function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (NEVER_LOG_FIELDS.has(key)) continue;

    if (value instanceof Error) {
      result[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    } else if (typeof value === 'string' && value.length > META_STRING_MAX_LENGTH) {
      result[key] = value.slice(0, META_STRING_MAX_LENGTH) + '...[truncated]';
    } else {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------
// createLogger
// ---------------------------------------------------------------------------

/**
 * Create a structured logger scoped to a component.
 *
 * @param component - Component name (e.g. `'router'`, `'container:lifecycle'`).
 * @param boundContext - Optional context fields promoted to every entry.
 * @returns A {@link Logger} that emits entries to the global sink.
 */
export function createLogger(component: string, boundContext?: LogContext): Logger {
  function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[globalLevel]) return;

    const entry: LogEntry = {
      level,
      ts: new Date().toISOString(),
      component,
      msg: message,
    };

    // Apply bound context fields
    if (boundContext) {
      if (boundContext.correlation) entry.correlation = boundContext.correlation;
      if (boundContext.topic) entry.topic = boundContext.topic;
      if (boundContext.group) entry.group = boundContext.group;
      if (boundContext.session) entry.session = boundContext.session;
    }

    // Promote well-known fields from meta to top-level
    if (meta) {
      if (meta.duration_ms !== undefined) entry.duration_ms = meta.duration_ms as number;
      if (meta.ok !== undefined) entry.ok = meta.ok as boolean;
      if (meta.error_code !== undefined) entry.error_code = meta.error_code as string;
      if (meta.trace !== undefined) entry.trace = meta.trace as string;
      if (meta.correlation !== undefined) entry.correlation = meta.correlation as string;
      if (meta.topic !== undefined) entry.topic = meta.topic as string;
      if (meta.group !== undefined) entry.group = meta.group as string;
      if (meta.session !== undefined) entry.session = meta.session as string;
    }

    const sanitized = sanitizeMeta(meta);
    if (sanitized !== undefined) {
      // Remove promoted fields from meta to avoid duplication
      const remaining: Record<string, unknown> = {};
      const promotedKeys = new Set([
        'duration_ms',
        'ok',
        'error_code',
        'trace',
        'correlation',
        'topic',
        'group',
        'session',
      ]);
      for (const [key, value] of Object.entries(sanitized)) {
        if (!promotedKeys.has(key)) {
          remaining[key] = value;
        }
      }
      if (Object.keys(remaining).length > 0) {
        entry.meta = remaining;
      }
    }

    globalSink(entry);
  }

  return {
    debug: (message, meta) => log('debug', message, meta),
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta),
    child: (subComponent) => createLogger(`${component}:${subComponent}`, boundContext),
    withContext: (ctx) => {
      const merged: LogContext = { ...boundContext, ...ctx };
      return createLogger(component, merged);
    },
  };
}

// ---------------------------------------------------------------------------
// SanitizingLogSink
// ---------------------------------------------------------------------------

/**
 * Structural interface for a sanitizer — avoids importing ResponseSanitizer
 * directly to prevent circular dependencies.
 */
export interface LogSanitizer {
  sanitize(value: unknown): { value: unknown; redactedPaths: string[] };
}

/**
 * Create a LogSink that runs entries through a sanitizer before forwarding
 * to the inner sink. Defense-in-depth: catches credential patterns that
 * slip past NEVER_LOG_FIELDS.
 */
export function createSanitizingLogSink(innerSink: LogSink, sanitizer: LogSanitizer): LogSink {
  return (entry: LogEntry) => {
    const { value } = sanitizer.sanitize(entry);
    innerSink(value as LogEntry);
  };
}

// ---------------------------------------------------------------------------
// ContainerLogRouter
// ---------------------------------------------------------------------------

/**
 * Routes container stdout/stderr to host-side structured logs.
 *
 * Each line of output becomes a separate log entry tagged with the
 * session ID, group, and stream (stdout/stderr).
 */
export class ContainerLogRouter {
  private readonly logger: Logger;
  private readonly sessionId: string;
  private readonly group: string;

  constructor(sessionId: string, group: string) {
    this.sessionId = sessionId;
    this.group = group;
    this.logger = createLogger(`container:${group}:${sessionId}`);
  }

  /** Route container stdout data to info-level logs. */
  routeStdout(data: string): void {
    this.routeLines(data, 'stdout', 'info');
  }

  /** Route container stderr data to warn-level logs. */
  routeStderr(data: string): void {
    this.routeLines(data, 'stderr', 'warn');
  }

  private routeLines(data: string, stream: string, level: LogLevel): void {
    const lines = data.split('\n').filter((line) => line.length > 0);
    for (const line of lines) {
      this.logger[level](line, {
        sessionId: this.sessionId,
        group: this.group,
        stream,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// SessionLogSink — per-session JSONL log files
// ---------------------------------------------------------------------------

/** A LogSink that appends JSONL to a file, with a close() method. */
export interface SessionLogSink extends LogSink {
  (entry: LogEntry): void;
  close(): void;
}

/**
 * Create a LogSink that appends JSONL to a file at the given path.
 *
 * Used for per-session log files at `data/logs/{group}/{sessionId}.jsonl`.
 * Created when a container is spawned, closed on shutdown.
 *
 * @param filePath - Absolute path to the JSONL log file.
 * @param fs - Optional filesystem abstraction for testing.
 */
export function createSessionLogSink(
  filePath: string,
  fs?: {
    mkdirSync: (path: string, options: { recursive: boolean }) => void;
    appendFileSync: (path: string, data: string) => void;
  },
): SessionLogSink {
  const fsMkdir = fs?.mkdirSync ?? mkdirSync;
  const fsAppend = fs?.appendFileSync ?? appendFileSync;

  // Ensure parent directory exists
  fsMkdir(dirname(filePath), { recursive: true });

  let closed = false;

  const sink = ((entry: LogEntry): void => {
    if (closed) return;
    fsAppend(filePath, JSON.stringify(entry) + '\n');
  }) as SessionLogSink;

  sink.close = () => {
    closed = true;
  };

  return sink;
}
