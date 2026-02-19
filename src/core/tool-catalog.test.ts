import { describe, it, expect } from 'vitest';
import { ToolCatalog } from './tool-catalog.js';
import type { ToolHandler } from './tool-catalog.js';
import { createToolDeclaration } from '../testing/factories.js';

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

  describe('get unknown', () => {
    it('returns undefined for an unregistered tool name', () => {
      const catalog = new ToolCatalog();

      expect(catalog.get('unknown')).toBeUndefined();
    });
  });
});
