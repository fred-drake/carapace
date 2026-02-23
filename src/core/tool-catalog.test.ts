import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolCatalog } from './tool-catalog.js';
import type { ToolHandler } from './tool-catalog.js';
import { createToolDeclaration } from '../testing/factories.js';
import { configureLogging, resetLogging, type LogEntry, type LogSink } from './logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopHandler: ToolHandler = async () => ({ ok: true });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolCatalog', () => {
  describe('register and get', () => {
    it('registers a tool and retrieves it by name', () => {
      const catalog = new ToolCatalog();
      const tool = createToolDeclaration({ name: 'my_tool' });

      catalog.register(tool, noopHandler);

      const entry = catalog.get('my_tool');
      expect(entry).toBeDefined();
      expect(entry!.tool).toEqual(tool);
      expect(entry!.handler).toBe(noopHandler);
    });
  });

  describe('has', () => {
    it('returns true for a registered tool', () => {
      const catalog = new ToolCatalog();
      const tool = createToolDeclaration({ name: 'existing_tool' });
      catalog.register(tool, noopHandler);

      expect(catalog.has('existing_tool')).toBe(true);
    });

    it('returns false for an unknown tool', () => {
      const catalog = new ToolCatalog();

      expect(catalog.has('nonexistent')).toBe(false);
    });
  });

  describe('list', () => {
    it('returns all registered tool declarations', () => {
      const catalog = new ToolCatalog();
      const tool1 = createToolDeclaration({ name: 'tool_a' });
      const tool2 = createToolDeclaration({ name: 'tool_b' });
      catalog.register(tool1, noopHandler);
      catalog.register(tool2, noopHandler);

      const tools = catalog.list();
      expect(tools).toHaveLength(2);
      expect(tools).toContainEqual(tool1);
      expect(tools).toContainEqual(tool2);
    });

    it('returns an empty array when no tools are registered', () => {
      const catalog = new ToolCatalog();

      expect(catalog.list()).toEqual([]);
    });
  });

  describe('duplicate registration', () => {
    it('throws when registering a tool with the same name twice', () => {
      const catalog = new ToolCatalog();
      const tool = createToolDeclaration({ name: 'dup_tool' });
      catalog.register(tool, noopHandler);

      expect(() => catalog.register(tool, noopHandler)).toThrow(
        'Tool already registered: "dup_tool"',
      );
    });
  });

  describe('unregister', () => {
    it('removes a registered tool and returns true', () => {
      const catalog = new ToolCatalog();
      const tool = createToolDeclaration({ name: 'removable_tool' });
      catalog.register(tool, noopHandler);

      const result = catalog.unregister('removable_tool');

      expect(result).toBe(true);
      expect(catalog.has('removable_tool')).toBe(false);
      expect(catalog.get('removable_tool')).toBeUndefined();
    });

    it('returns false for a tool that does not exist', () => {
      const catalog = new ToolCatalog();

      expect(catalog.unregister('nonexistent')).toBe(false);
    });

    it('allows re-registration after unregister', () => {
      const catalog = new ToolCatalog();
      const tool = createToolDeclaration({ name: 'reregister_tool' });
      catalog.register(tool, noopHandler);
      catalog.unregister('reregister_tool');

      // Should not throw
      catalog.register(tool, noopHandler);
      expect(catalog.has('reregister_tool')).toBe(true);
    });
  });

  describe('get unknown', () => {
    it('returns undefined for an unregistered tool name', () => {
      const catalog = new ToolCatalog();

      expect(catalog.get('unknown')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Logging
  // -----------------------------------------------------------------------

  describe('logging', () => {
    let logEntries: LogEntry[];

    beforeEach(() => {
      logEntries = [];
      const logSink: LogSink = (entry) => logEntries.push(entry);
      configureLogging({ level: 'debug', sink: logSink });
    });

    afterEach(() => {
      resetLogging();
    });

    it('logs tool registered on register()', () => {
      const catalog = new ToolCatalog();
      const tool = createToolDeclaration({ name: 'log_tool' });

      catalog.register(tool, noopHandler);

      const regLog = logEntries.find((e) => e.msg === 'tool registered');
      expect(regLog).toBeDefined();
      expect(regLog!.meta?.toolName).toBe('log_tool');
    });

    it('uses tool-catalog component name', () => {
      const catalog = new ToolCatalog();
      const tool = createToolDeclaration({ name: 'comp_tool' });

      catalog.register(tool, noopHandler);

      const regLog = logEntries.find((e) => e.msg === 'tool registered');
      expect(regLog).toBeDefined();
      expect(regLog!.component).toBe('tool-catalog');
    });

    it('logs tool unregistered on unregister()', () => {
      const catalog = new ToolCatalog();
      const tool = createToolDeclaration({ name: 'unreg_tool' });
      catalog.register(tool, noopHandler);

      catalog.unregister('unreg_tool');

      const unregLog = logEntries.find((e) => e.msg === 'tool unregistered');
      expect(unregLog).toBeDefined();
      expect(unregLog!.meta?.toolName).toBe('unreg_tool');
    });

    it('does not log when unregistering a nonexistent tool', () => {
      const catalog = new ToolCatalog();

      catalog.unregister('ghost');

      const unregLog = logEntries.find((e) => e.msg === 'tool unregistered');
      expect(unregLog).toBeUndefined();
    });
  });
});
