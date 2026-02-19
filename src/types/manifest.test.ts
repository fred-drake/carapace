import { describe, it, expect } from 'vitest';
import type { RiskLevel, Author, JsonSchema, ToolDeclaration, PluginManifest } from './manifest.js';

function remindersManifest(): PluginManifest {
  return {
    description: 'Manage Apple Reminders — create, list, complete, and delete reminders',
    version: '1.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Fred Drake', url: 'https://freddrake.com' },
    provides: {
      channels: [],
      tools: [
        {
          name: 'create_reminder',
          description: 'Create a new reminder',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            required: ['title'],
            additionalProperties: false,
            properties: {
              title: { type: 'string', maxLength: 500 },
              due: { type: 'string', format: 'date-time' },
              list: { type: 'string', default: 'Personal' },
            },
          },
        },
        {
          name: 'delete_reminder',
          description: 'Delete a reminder',
          risk_level: 'high',
          arguments_schema: {
            type: 'object',
            required: ['reminder_id'],
            additionalProperties: false,
            properties: {
              reminder_id: { type: 'string' },
            },
          },
        },
      ],
    },
    subscribes: [],
    config_schema: {
      type: 'object',
      properties: {
        default_list: {
          type: 'string',
          description: 'Default reminders list to use',
        },
      },
    },
  };
}

describe('manifest types', () => {
  describe('PluginManifest', () => {
    it('accepts a valid reminders manifest', () => {
      const manifest: PluginManifest = remindersManifest();
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.provides.tools).toHaveLength(2);
    });

    it('allows config_schema to be omitted', () => {
      const manifest: PluginManifest = {
        description: 'Minimal plugin',
        version: '0.1.0',
        app_compat: '>=0.1.0',
        author: { name: 'Test' },
        provides: { channels: [], tools: [] },
        subscribes: [],
      };
      expect(manifest.config_schema).toBeUndefined();
    });
  });

  describe('ToolDeclaration', () => {
    it('requires all four fields', () => {
      const tool: ToolDeclaration = {
        name: 'test_tool',
        description: 'A test tool',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      };
      expect(tool.name).toBe('test_tool');
      expect(tool.description).toBe('A test tool');
      expect(tool.risk_level).toBe('low');
      expect(tool.arguments_schema).toBeDefined();
    });
  });

  describe('RiskLevel', () => {
    it('accepts low and high', () => {
      const low: RiskLevel = 'low';
      const high: RiskLevel = 'high';
      expect(low).toBe('low');
      expect(high).toBe('high');
    });

    it('does not accept arbitrary strings at the type level', () => {
      const isRiskLevel = (v: string): v is RiskLevel => v === 'low' || v === 'high';
      expect(isRiskLevel('low')).toBe(true);
      expect(isRiskLevel('high')).toBe(true);
      expect(isRiskLevel('medium')).toBe(false);
    });
  });

  describe('JsonSchema', () => {
    it('requires additionalProperties to be false', () => {
      const schema: JsonSchema = {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string' } },
      };
      expect(schema.additionalProperties).toBe(false);
    });

    it('accepts optional required array', () => {
      const schema: JsonSchema = {
        type: 'object',
        required: ['id'],
        additionalProperties: false,
        properties: { id: { type: 'string' } },
      };
      expect(schema.required).toEqual(['id']);
    });
  });

  describe('Author', () => {
    it('requires name and allows optional url', () => {
      const minimal: Author = { name: 'Test' };
      expect(minimal.url).toBeUndefined();

      const full: Author = { name: 'Test', url: 'https://example.com' };
      expect(full.url).toBe('https://example.com');
    });
  });
});
