import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createLogger,
  configureLogging,
  resetLogging,
  createSanitizingLogSink,
  NEVER_LOG_FIELDS,
  META_STRING_MAX_LENGTH,
  type LogEntry,
  type LogSink,
  type LogSanitizer,
} from './logger.js';

// ---------------------------------------------------------------------------
// Test sink that captures log entries
// ---------------------------------------------------------------------------

function createTestSink(): { sink: LogSink; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const sink: LogSink = (entry: LogEntry) => {
    entries.push(entry);
  };
  return { sink, entries };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Logger', () => {
  let sink: LogSink;
  let entries: LogEntry[];

  beforeEach(() => {
    const test = createTestSink();
    sink = test.sink;
    entries = test.entries;
    configureLogging({ level: 'debug', sink });
  });

  afterEach(() => {
    resetLogging();
  });

  // -----------------------------------------------------------------------
  // createLogger
  // -----------------------------------------------------------------------

  describe('createLogger', () => {
    it('creates a logger with the given component name', () => {
      const logger = createLogger('router');
      logger.info('hello');
      expect(entries).toHaveLength(1);
      expect(entries[0].component).toBe('router');
    });

    it('returns an object with debug, info, warn, error methods', () => {
      const logger = createLogger('test');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });
  });

  // -----------------------------------------------------------------------
  // Log entry structure
  // -----------------------------------------------------------------------

  describe('log entry structure', () => {
    it('uses ts and msg field names', () => {
      const logger = createLogger('core');
      logger.info('test message');

      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.level).toBe('info');
      expect(entry.component).toBe('core');
      expect(entry.msg).toBe('test message');
      expect(entry.ts).toBeDefined();
      // Old fields should not exist
      expect((entry as unknown as Record<string, unknown>).timestamp).toBeUndefined();
      expect((entry as unknown as Record<string, unknown>).message).toBeUndefined();
    });

    it('timestamp is ISO 8601 format', () => {
      const logger = createLogger('core');
      logger.info('test');

      const ts = entries[0].ts;
      expect(() => new Date(ts)).not.toThrow();
      expect(new Date(ts).toISOString()).toBe(ts);
    });

    it('includes optional metadata when provided', () => {
      const logger = createLogger('plugin');
      logger.info('loaded', { pluginName: 'echo', version: '1.0' });

      expect(entries[0].meta).toEqual({ pluginName: 'echo', version: '1.0' });
    });

    it('omits meta field when no metadata is provided', () => {
      const logger = createLogger('core');
      logger.info('simple message');

      expect(entries[0].meta).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Log levels
  // -----------------------------------------------------------------------

  describe('log levels', () => {
    it('logs at debug level', () => {
      const logger = createLogger('core');
      logger.debug('debug msg');
      expect(entries[0].level).toBe('debug');
    });

    it('logs at info level', () => {
      const logger = createLogger('core');
      logger.info('info msg');
      expect(entries[0].level).toBe('info');
    });

    it('logs at warn level', () => {
      const logger = createLogger('core');
      logger.warn('warn msg');
      expect(entries[0].level).toBe('warn');
    });

    it('logs at error level', () => {
      const logger = createLogger('core');
      logger.error('error msg');
      expect(entries[0].level).toBe('error');
    });
  });

  // -----------------------------------------------------------------------
  // Level filtering
  // -----------------------------------------------------------------------

  describe('level filtering', () => {
    it('filters out debug when level is info', () => {
      configureLogging({ level: 'info', sink });
      const logger = createLogger('core');

      logger.debug('should be filtered');
      logger.info('should appear');

      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('info');
    });

    it('filters out debug and info when level is warn', () => {
      configureLogging({ level: 'warn', sink });
      const logger = createLogger('core');

      logger.debug('filtered');
      logger.info('filtered');
      logger.warn('visible');
      logger.error('visible');

      expect(entries).toHaveLength(2);
      expect(entries[0].level).toBe('warn');
      expect(entries[1].level).toBe('error');
    });

    it('only shows error when level is error', () => {
      configureLogging({ level: 'error', sink });
      const logger = createLogger('core');

      logger.debug('filtered');
      logger.info('filtered');
      logger.warn('filtered');
      logger.error('visible');

      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('error');
    });

    it('shows all levels when level is debug', () => {
      configureLogging({ level: 'debug', sink });
      const logger = createLogger('core');

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(entries).toHaveLength(4);
    });
  });

  // -----------------------------------------------------------------------
  // configureLogging
  // -----------------------------------------------------------------------

  describe('configureLogging', () => {
    it('changes the global log level', () => {
      const logger = createLogger('core');

      configureLogging({ level: 'error', sink });
      logger.info('filtered');
      expect(entries).toHaveLength(0);

      configureLogging({ level: 'debug', sink });
      logger.info('visible');
      expect(entries).toHaveLength(1);
    });

    it('changes the global sink', () => {
      const altEntries: LogEntry[] = [];
      const altSink: LogSink = (entry) => altEntries.push(entry);

      configureLogging({ level: 'debug', sink: altSink });
      const logger = createLogger('core');
      logger.info('routed to alt');

      expect(entries).toHaveLength(0);
      expect(altEntries).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // resetLogging
  // -----------------------------------------------------------------------

  describe('resetLogging', () => {
    it('restores default log level (info)', () => {
      configureLogging({ level: 'debug', sink });
      const logger = createLogger('core');

      resetLogging();
      // Re-configure sink only (level should be default 'info')
      configureLogging({ sink });

      logger.debug('should be filtered at default info level');
      logger.info('should appear');

      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('info');
    });
  });

  // -----------------------------------------------------------------------
  // Child loggers
  // -----------------------------------------------------------------------

  describe('child loggers', () => {
    it('creates a child with a sub-component name', () => {
      const logger = createLogger('container');
      const child = logger.child('lifecycle');

      child.info('spawned');

      expect(entries[0].component).toBe('container:lifecycle');
    });

    it('child inherits the parent component prefix', () => {
      const logger = createLogger('core');
      const child = logger.child('router');
      const grandchild = child.child('pipeline');

      grandchild.warn('stage failed');

      expect(entries[0].component).toBe('core:router:pipeline');
    });

    it('child preserves bound context', () => {
      const logger = createLogger('server');
      const ctxLogger = logger.withContext({ correlation: 'corr-abc', group: 'email' });
      const child = ctxLogger.child('handler');

      child.info('processing');

      expect(entries[0].correlation).toBe('corr-abc');
      expect(entries[0].group).toBe('email');
      expect(entries[0].component).toBe('server:handler');
    });
  });

  // -----------------------------------------------------------------------
  // Error serialization
  // -----------------------------------------------------------------------

  describe('error serialization', () => {
    it('serializes Error objects in metadata', () => {
      const logger = createLogger('core');
      const err = new Error('something broke');

      logger.error('operation failed', { error: err });

      expect(entries[0].meta).toBeDefined();
      expect(entries[0].meta!.error).toEqual({
        name: 'Error',
        message: 'something broke',
        stack: expect.any(String),
      });
    });

    it('passes non-Error metadata through unchanged', () => {
      const logger = createLogger('core');
      logger.info('data', { count: 42, items: ['a', 'b'] });

      expect(entries[0].meta).toEqual({ count: 42, items: ['a', 'b'] });
    });
  });

  // -----------------------------------------------------------------------
  // JSON output format
  // -----------------------------------------------------------------------

  describe('JSON output', () => {
    it('defaultSink produces valid JSON on each line', () => {
      const lines: string[] = [];
      const jsonSink: LogSink = (entry) => {
        lines.push(JSON.stringify(entry));
      };
      configureLogging({ level: 'debug', sink: jsonSink });
      const logger = createLogger('test');

      logger.info('hello', { key: 'value' });

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.level).toBe('info');
      expect(parsed.component).toBe('test');
      expect(parsed.msg).toBe('hello');
      expect(parsed.meta.key).toBe('value');
    });
  });

  // -----------------------------------------------------------------------
  // NEVER_LOG_FIELDS
  // -----------------------------------------------------------------------

  describe('NEVER_LOG_FIELDS', () => {
    it('strips NEVER_LOG_FIELDS from metadata', () => {
      const logger = createLogger('core');
      logger.info('request', {
        stdinData: 'secret-key-value',
        apiKey: 'sk-abc123',
        normalField: 'visible',
      });

      expect(entries[0].meta).toEqual({ normalField: 'visible' });
    });

    it('strips all denied fields', () => {
      const logger = createLogger('core');
      logger.info('test', {
        api_key: 'key1',
        ANTHROPIC_API_KEY: 'key2',
        CLAUDE_CODE_OAUTH_TOKEN: 'key3',
        password: 'pass',
        secret: 'shh',
        token: 'tok',
        credential: 'cred',
        authorization: 'auth',
      });

      expect(entries[0].meta).toBeUndefined();
    });

    it('omits meta entirely when all fields are denied', () => {
      const logger = createLogger('core');
      logger.info('clean', { stdinData: 'secret' });

      expect(entries[0].meta).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Metadata string truncation
  // -----------------------------------------------------------------------

  describe('metadata string truncation', () => {
    it('truncates metadata strings exceeding 1024 chars', () => {
      const logger = createLogger('core');
      const longString = 'x'.repeat(2000);
      logger.info('data', { payload: longString });

      const value = entries[0].meta!.payload as string;
      expect(value.length).toBeLessThan(2000);
      expect(value).toContain('...[truncated]');
      expect(value.startsWith('x'.repeat(META_STRING_MAX_LENGTH))).toBe(true);
    });

    it('does not truncate strings at or below limit', () => {
      const logger = createLogger('core');
      const okString = 'y'.repeat(META_STRING_MAX_LENGTH);
      logger.info('data', { payload: okString });

      expect(entries[0].meta!.payload).toBe(okString);
    });
  });

  // -----------------------------------------------------------------------
  // withContext
  // -----------------------------------------------------------------------

  describe('withContext', () => {
    it('promotes correlation/group/topic/session to entry', () => {
      const logger = createLogger('router');
      const ctxLogger = logger.withContext({
        correlation: 'corr-001',
        topic: 'tool.invoke.echo',
        group: 'email',
        session: 'sess-123',
      });

      ctxLogger.info('request received');

      expect(entries[0].correlation).toBe('corr-001');
      expect(entries[0].topic).toBe('tool.invoke.echo');
      expect(entries[0].group).toBe('email');
      expect(entries[0].session).toBe('sess-123');
    });

    it('merges new context with existing context', () => {
      const logger = createLogger('router');
      const ctx1 = logger.withContext({ correlation: 'corr-001', group: 'email' });
      const ctx2 = ctx1.withContext({ topic: 'tool.invoke.echo' });

      ctx2.info('merged');

      expect(entries[0].correlation).toBe('corr-001');
      expect(entries[0].group).toBe('email');
      expect(entries[0].topic).toBe('tool.invoke.echo');
    });

    it('meta fields override bound context', () => {
      const logger = createLogger('router');
      const ctxLogger = logger.withContext({ correlation: 'bound-corr' });

      ctxLogger.info('override', { correlation: 'meta-corr' });

      expect(entries[0].correlation).toBe('meta-corr');
    });
  });

  // -----------------------------------------------------------------------
  // Promoted metadata fields
  // -----------------------------------------------------------------------

  describe('promoted metadata fields', () => {
    it('promotes duration_ms, ok, error_code to top-level', () => {
      const logger = createLogger('server');
      logger.info('request completed', {
        duration_ms: 42,
        ok: true,
        error_code: 'NONE',
      });

      expect(entries[0].duration_ms).toBe(42);
      expect(entries[0].ok).toBe(true);
      expect(entries[0].error_code).toBe('NONE');
      // These should not remain in meta
      expect(entries[0].meta).toBeUndefined();
    });

    it('promotes trace field to top-level', () => {
      const logger = createLogger('tracer');
      logger.info('traced', { trace: 'request_start' });

      expect(entries[0].trace).toBe('request_start');
      expect(entries[0].meta).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// SanitizingLogSink
// ---------------------------------------------------------------------------

describe('SanitizingLogSink', () => {
  let innerEntries: LogEntry[];
  let innerSink: LogSink;

  beforeEach(() => {
    innerEntries = [];
    innerSink = (entry) => innerEntries.push(entry);
  });

  it('redacts credential patterns in log entries', () => {
    const sanitizer: LogSanitizer = {
      sanitize: (value: unknown) => {
        const json = JSON.stringify(value);
        const redacted = json.replace(/sk-[A-Za-z0-9]+/g, '[REDACTED]');
        return { value: JSON.parse(redacted), redactedPaths: ['$.meta.key'] };
      },
    };

    const sink = createSanitizingLogSink(innerSink, sanitizer);
    sink({
      level: 'info',
      ts: new Date().toISOString(),
      component: 'test',
      msg: 'key is sk-abcdef123456',
    });

    expect(innerEntries).toHaveLength(1);
    expect(innerEntries[0].msg).toBe('key is [REDACTED]');
  });

  it('passes clean entries through unmodified', () => {
    const sanitizer: LogSanitizer = {
      sanitize: (value: unknown) => ({ value, redactedPaths: [] }),
    };

    const sink = createSanitizingLogSink(innerSink, sanitizer);
    sink({
      level: 'debug',
      ts: '2024-01-01T00:00:00.000Z',
      component: 'clean',
      msg: 'no secrets here',
    });

    expect(innerEntries).toHaveLength(1);
    expect(innerEntries[0].msg).toBe('no secrets here');
    expect(innerEntries[0].component).toBe('clean');
  });

  it('redacts credential patterns in metadata', () => {
    const sanitizer: LogSanitizer = {
      sanitize: (value: unknown) => {
        const json = JSON.stringify(value);
        const redacted = json.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]');
        return { value: JSON.parse(redacted), redactedPaths: ['$.meta.auth'] };
      },
    };

    const sink = createSanitizingLogSink(innerSink, sanitizer);
    sink({
      level: 'warn',
      ts: new Date().toISOString(),
      component: 'test',
      msg: 'auth check',
      meta: { auth: 'Bearer sk-secret123456' },
    });

    expect(innerEntries).toHaveLength(1);
    expect((innerEntries[0].meta as Record<string, unknown>)?.auth).toBe('Bearer [REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// ContainerLogRouter
// ---------------------------------------------------------------------------

describe('ContainerLogRouter', () => {
  let sink: LogSink;
  let entries: LogEntry[];

  beforeEach(() => {
    const test = createTestSink();
    sink = test.sink;
    entries = test.entries;
    configureLogging({ level: 'debug', sink });
  });

  afterEach(() => {
    resetLogging();
  });

  // Lazy import to test the container log routing
  async function getRouter() {
    const { ContainerLogRouter } = await import('./logger.js');
    return ContainerLogRouter;
  }

  it('routes stdout lines as info-level logs', async () => {
    const Router = await getRouter();
    const router = new Router('session-abc', 'email');

    router.routeStdout('Hello from container\n');

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('info');
    expect(entries[0].component).toBe('container:email:session-abc');
    expect(entries[0].msg).toBe('Hello from container');
  });

  it('routes stderr lines as warn-level logs', async () => {
    const Router = await getRouter();
    const router = new Router('session-abc', 'email');

    router.routeStderr('Warning: something happened\n');

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('warn');
    expect(entries[0].msg).toBe('Warning: something happened');
  });

  it('handles multi-line output by splitting into separate entries', async () => {
    const Router = await getRouter();
    const router = new Router('session-123', 'slack');

    router.routeStdout('line one\nline two\nline three\n');

    expect(entries).toHaveLength(3);
    expect(entries[0].msg).toBe('line one');
    expect(entries[1].msg).toBe('line two');
    expect(entries[2].msg).toBe('line three');
  });

  it('ignores empty lines', async () => {
    const Router = await getRouter();
    const router = new Router('session-123', 'test');

    router.routeStdout('\n\n');

    expect(entries).toHaveLength(0);
  });

  it('includes session ID and group in metadata', async () => {
    const Router = await getRouter();
    const router = new Router('session-abc', 'email');

    router.routeStdout('output\n');

    expect(entries[0].meta).toEqual({
      sessionId: 'session-abc',
      stream: 'stdout',
    });
    expect(entries[0].group).toBe('email');
  });

  it('marks stderr with stream: stderr in metadata', async () => {
    const Router = await getRouter();
    const router = new Router('session-abc', 'email');

    router.routeStderr('error output\n');

    expect(entries[0].meta!.stream).toBe('stderr');
  });
});

// ---------------------------------------------------------------------------
// createSessionLogSink
// ---------------------------------------------------------------------------

describe('createSessionLogSink', () => {
  it('creates parent directory and appends JSONL', async () => {
    const { createSessionLogSink } = await import('./logger.js');

    const written: string[] = [];
    const fakeFs = {
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn((_path: string, data: string) => written.push(data)),
    };

    const sink = createSessionLogSink('/data/logs/email/session-1.jsonl', fakeFs);

    expect(fakeFs.mkdirSync).toHaveBeenCalledWith('/data/logs/email', { recursive: true });

    const entry: LogEntry = {
      level: 'info',
      ts: new Date().toISOString(),
      component: 'test',
      msg: 'hello',
    };
    sink(entry);

    expect(written).toHaveLength(1);
    expect(written[0]).toBe(JSON.stringify(entry) + '\n');
  });

  it('stops writing after close()', async () => {
    const { createSessionLogSink } = await import('./logger.js');

    const written: string[] = [];
    const fakeFs = {
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn((_path: string, data: string) => written.push(data)),
    };

    const sink = createSessionLogSink('/data/logs/email/session-2.jsonl', fakeFs);

    sink({
      level: 'info',
      ts: new Date().toISOString(),
      component: 'test',
      msg: 'before close',
    });

    sink.close();

    sink({
      level: 'info',
      ts: new Date().toISOString(),
      component: 'test',
      msg: 'after close',
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('before close');
  });

  it('writes valid JSONL (each line is parseable JSON)', async () => {
    const { createSessionLogSink } = await import('./logger.js');

    const written: string[] = [];
    const fakeFs = {
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn((_path: string, data: string) => written.push(data)),
    };

    const sink = createSessionLogSink('/data/logs/slack/session-3.jsonl', fakeFs);

    sink({
      level: 'warn',
      ts: new Date().toISOString(),
      component: 'router',
      msg: 'rate limited',
      meta: { count: 42 },
    });

    const parsed = JSON.parse(written[0].trim());
    expect(parsed.level).toBe('warn');
    expect(parsed.msg).toBe('rate limited');
    expect(parsed.meta.count).toBe(42);
  });
});
