/**
 * IPC binary logger — minimal stderr-only logging for the container side.
 *
 * Intentionally separate from host-side `logger.ts`:
 *   - Different process (container vs host)
 *   - Different output target (stderr vs stdout)
 *   - Simpler needs (no child/withContext — single binary, short-lived)
 *
 * All output goes to **stderr** because stdout is the result channel.
 * Debug/info/warn levels are gated behind the `CARAPACE_DEBUG=1` env var.
 * Errors are always emitted.
 *
 * Security: log argument keys only (`Object.keys(args)`), never values.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IpcLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface IpcLogEntry {
  level: IpcLogLevel;
  ts: string;
  component: string;
  msg: string;
  [key: string]: unknown;
}

/** Writable target — allows test injection instead of real stderr. */
export type IpcLogSink = (entry: IpcLogEntry) => void;

// ---------------------------------------------------------------------------
// Level ordering
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<IpcLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ---------------------------------------------------------------------------
// IpcLogger
// ---------------------------------------------------------------------------

export interface IpcLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Create an IPC logger that writes structured JSON lines to stderr.
 *
 * @param component - Logger component name (e.g. 'ipc', 'ipc-client').
 * @param options - Optional overrides for testing.
 */
export function createIpcLogger(
  component: string,
  options?: {
    /** Override the debug-enabled check (defaults to CARAPACE_DEBUG=1). */
    debugEnabled?: boolean;
    /** Override the output sink (defaults to stderr). */
    sink?: IpcLogSink;
  },
): IpcLogger {
  const debugEnabled = options?.debugEnabled ?? process.env['CARAPACE_DEBUG'] === '1';
  const minLevel: IpcLogLevel = debugEnabled ? 'debug' : 'error';
  const sink: IpcLogSink =
    options?.sink ?? ((entry) => process.stderr.write(JSON.stringify(entry) + '\n'));

  function log(level: IpcLogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    const entry: IpcLogEntry = {
      level,
      ts: new Date().toISOString(),
      component,
      msg,
      ...meta,
    };

    sink(entry);
  }

  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
  };
}
