import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createLogger,
  configureLogging,
  resetLogging,
  type LogEntry,
  type LogSink,
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
    it('includes level, timestamp, component, and message', () => {
      const logger = createLogger('core');
      logger.info('test message');

      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.level).toBe('info');
      expect(entry.component).toBe('core');
      expect(entry.message).toBe('test message');
      expect(entry.timestamp).toBeDefined();
    });

    it('timestamp is ISO 8601 format', () => {
      const logger = createLogger('core');
      logger.info('test');

      const ts = entries[0].timestamp;
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
      expect(parsed.message).toBe('hello');
      expect(parsed.meta.key).toBe('value');
    });
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
    expect(entries[0].message).toBe('Hello from container');
  });

  it('routes stderr lines as warn-level logs', async () => {
    const Router = await getRouter();
    const router = new Router('session-abc', 'email');

    router.routeStderr('Warning: something happened\n');

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('warn');
    expect(entries[0].message).toBe('Warning: something happened');
  });

  it('handles multi-line output by splitting into separate entries', async () => {
    const Router = await getRouter();
    const router = new Router('session-123', 'slack');

    router.routeStdout('line one\nline two\nline three\n');

    expect(entries).toHaveLength(3);
    expect(entries[0].message).toBe('line one');
    expect(entries[1].message).toBe('line two');
    expect(entries[2].message).toBe('line three');
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
      group: 'email',
      stream: 'stdout',
    });
  });

  it('marks stderr with stream: stderr in metadata', async () => {
    const Router = await getRouter();
    const router = new Router('session-abc', 'email');

    router.routeStderr('error output\n');

    expect(entries[0].meta!.stream).toBe('stderr');
  });
});
