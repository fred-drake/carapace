/**
 * Structured JSON logging for Carapace.
 *
 * Provides component-scoped loggers with level filtering, injectable
 * sinks for testing, and a container log router that maps container
 * stdout/stderr to host-side structured logs.
 *
 * All log output is JSON-formatted with level, timestamp, component,
 * and message fields. Metadata is included when provided.
 *
 * @example
 * ```ts
 * const logger = createLogger('router');
 * logger.info('request received', { topic: 'echo.run' });
 * // → {"level":"info","timestamp":"...","component":"router","message":"request received","meta":{"topic":"echo.run"}}
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Log severity levels in ascending order. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A structured log entry. */
export interface LogEntry {
  level: LogLevel;
  timestamp: string;
  component: string;
  message: string;
  meta?: Record<string, unknown>;
}

/** A function that consumes a log entry (output destination). */
export type LogSink = (entry: LogEntry) => void;

/** A structured logger scoped to a component. */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(subComponent: string): Logger;
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
// Error serialization
// ---------------------------------------------------------------------------

function serializeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      result[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// createLogger
// ---------------------------------------------------------------------------

/**
 * Create a structured logger scoped to a component.
 *
 * @param component - Component name (e.g. `'router'`, `'container:lifecycle'`).
 * @returns A {@link Logger} that emits entries to the global sink.
 */
export function createLogger(component: string): Logger {
  function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[globalLevel]) return;

    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      component,
      message,
    };

    const serialized = serializeMeta(meta);
    if (serialized !== undefined) {
      entry.meta = serialized;
    }

    globalSink(entry);
  }

  return {
    debug: (message, meta) => log('debug', message, meta),
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta),
    child: (subComponent) => createLogger(`${component}:${subComponent}`),
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
