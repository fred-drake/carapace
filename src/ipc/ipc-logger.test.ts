import { describe, it, expect } from 'vitest';
import { createIpcLogger, type IpcLogEntry } from './ipc-logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectLogs(
  component: string,
  debugEnabled: boolean,
): { logger: ReturnType<typeof createIpcLogger>; entries: IpcLogEntry[] } {
  const entries: IpcLogEntry[] = [];
  const logger = createIpcLogger(component, {
    debugEnabled,
    sink: (entry) => entries.push(entry),
  });
  return { logger, entries };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IpcLogger', () => {
  describe('output format', () => {
    it('produces structured JSON entries with required fields', () => {
      const { logger, entries } = collectLogs('ipc', true);

      logger.info('test message', { extra: 'data' });

      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.level).toBe('info');
      expect(entry.component).toBe('ipc');
      expect(entry.msg).toBe('test message');
      expect(entry.extra).toBe('data');
      expect(entry.ts).toBeDefined();
      expect(Date.parse(entry.ts)).not.toBeNaN();
    });

    it('includes metadata fields at top level of entry', () => {
      const { logger, entries } = collectLogs('ipc-client', true);

      logger.debug('sending', { correlation: 'abc-123', topic: 'tool.invoke.test' });

      expect(entries).toHaveLength(1);
      expect(entries[0].correlation).toBe('abc-123');
      expect(entries[0].topic).toBe('tool.invoke.test');
    });
  });

  describe('level gating with CARAPACE_DEBUG=1', () => {
    it('emits all levels when debug is enabled', () => {
      const { logger, entries } = collectLogs('ipc', true);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(entries).toHaveLength(4);
      expect(entries.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error']);
    });

    it('only emits error when debug is disabled', () => {
      const { logger, entries } = collectLogs('ipc', false);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('error');
      expect(entries[0].msg).toBe('e');
    });
  });

  describe('error always emitted', () => {
    it('error logs are never suppressed regardless of debug setting', () => {
      const { logger, entries } = collectLogs('ipc', false);

      logger.error('critical failure', { code: 'IPC_ERROR' });

      expect(entries).toHaveLength(1);
      expect(entries[0].msg).toBe('critical failure');
      expect(entries[0].code).toBe('IPC_ERROR');
    });
  });

  describe('component naming', () => {
    it('uses the provided component name in all entries', () => {
      const { logger, entries } = collectLogs('custom-component', true);

      logger.info('test');
      logger.warn('test');

      for (const entry of entries) {
        expect(entry.component).toBe('custom-component');
      }
    });
  });

  describe('no metadata', () => {
    it('works without metadata argument', () => {
      const { logger, entries } = collectLogs('ipc', true);

      logger.info('no meta');

      expect(entries).toHaveLength(1);
      expect(entries[0].msg).toBe('no meta');
      // Only base fields should be present
      expect(Object.keys(entries[0]).sort()).toEqual(['component', 'level', 'msg', 'ts']);
    });
  });
});
