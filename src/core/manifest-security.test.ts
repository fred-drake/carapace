import { describe, it, expect } from 'vitest';
import {
  validateManifestSize,
  validateToolNames,
  validateAdditionalProperties,
  validateSchemaComplexity,
  validateSkillPaths,
  validateManifestSecurity,
  DEFAULT_SCHEMA_LIMITS,
  DEFAULT_MAX_MANIFEST_BYTES,
} from './manifest-security.js';
import { createManifest, createToolDeclaration } from '../testing/factories.js';
import type { JsonSchema } from '../types/index.js';

// ---------------------------------------------------------------------------
// validateManifestSize
// ---------------------------------------------------------------------------

describe('validateManifestSize', () => {
  it('accepts a manifest within the size limit', () => {
    const raw = JSON.stringify(createManifest());
    const result = validateManifestSize(raw);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a manifest exceeding the default size limit', () => {
    const raw = 'x'.repeat(DEFAULT_MAX_MANIFEST_BYTES + 1);
    const result = validateManifestSize(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('exceeds maximum');
  });

  it('accepts a manifest at exactly the size limit', () => {
    const raw = 'x'.repeat(DEFAULT_MAX_MANIFEST_BYTES);
    const result = validateManifestSize(raw);
    expect(result.valid).toBe(true);
  });

  it('respects a custom size limit', () => {
    const raw = 'x'.repeat(100);
    const result = validateManifestSize(raw, 50);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateToolNames
// ---------------------------------------------------------------------------

describe('validateToolNames', () => {
  it('accepts valid snake_case tool names', () => {
    const tools = [
      createToolDeclaration({ name: 'create_reminder' }),
      createToolDeclaration({ name: 'send_message' }),
    ];
    const result = validateToolNames(tools);
    expect(result.valid).toBe(true);
  });

  it('accepts tool names with digits', () => {
    const tools = [createToolDeclaration({ name: 'get_v2_items' })];
    const result = validateToolNames(tools);
    expect(result.valid).toBe(true);
  });

  it('rejects tool names with dots (topic injection)', () => {
    const tools = [createToolDeclaration({ name: 'tool.invoke.hack' })];
    const result = validateToolNames(tools);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('tool.invoke.hack');
    expect(result.errors[0]).toContain('invalid characters');
  });

  it('rejects tool names with slashes', () => {
    const tools = [createToolDeclaration({ name: 'path/traversal' })];
    const result = validateToolNames(tools);
    expect(result.valid).toBe(false);
  });

  it('rejects tool names with spaces', () => {
    const tools = [createToolDeclaration({ name: 'bad name' })];
    const result = validateToolNames(tools);
    expect(result.valid).toBe(false);
  });

  it('rejects tool names starting with a digit', () => {
    const tools = [createToolDeclaration({ name: '1invalid' })];
    const result = validateToolNames(tools);
    expect(result.valid).toBe(false);
  });

  it('rejects empty tool names', () => {
    const tools = [createToolDeclaration({ name: '' })];
    const result = validateToolNames(tools);
    expect(result.valid).toBe(false);
  });

  it('reports all invalid names, not just the first', () => {
    const tools = [
      createToolDeclaration({ name: 'bad.name' }),
      createToolDeclaration({ name: 'also bad!' }),
    ];
    const result = validateToolNames(tools);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// validateAdditionalProperties
// ---------------------------------------------------------------------------

describe('validateAdditionalProperties', () => {
  it('accepts a manifest where all schemas have additionalProperties: false', () => {
    const manifest = createManifest({
      provides: {
        channels: [],
        tools: [
          createToolDeclaration({
            name: 'good_tool',
            arguments_schema: {
              type: 'object',
              additionalProperties: false,
              properties: { input: { type: 'string' } },
            },
          }),
        ],
      },
    });
    const result = validateAdditionalProperties(manifest);
    expect(result.valid).toBe(true);
  });

  it('rejects a manifest where additionalProperties is missing', () => {
    const manifest = createManifest({
      provides: {
        channels: [],
        tools: [
          {
            name: 'bad_tool',
            description: 'Missing additionalProperties',
            risk_level: 'low',
            arguments_schema: {
              type: 'object',
              properties: { input: { type: 'string' } },
            } as unknown as JsonSchema,
          },
        ],
      },
    });
    const result = validateAdditionalProperties(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('bad_tool');
    expect(result.errors[0]).toContain('additionalProperties');
  });

  it('rejects a manifest where additionalProperties is true', () => {
    const manifest = createManifest({
      provides: {
        channels: [],
        tools: [
          {
            name: 'bad_tool',
            description: 'additionalProperties is true',
            risk_level: 'low',
            arguments_schema: {
              type: 'object',
              additionalProperties: true,
              properties: { input: { type: 'string' } },
            } as unknown as JsonSchema,
          },
        ],
      },
    });
    const result = validateAdditionalProperties(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('additionalProperties');
  });

  it('checks all tools, not just the first', () => {
    const manifest = createManifest({
      provides: {
        channels: [],
        tools: [
          createToolDeclaration({ name: 'good_tool' }),
          {
            name: 'bad_tool',
            description: 'Missing additionalProperties',
            risk_level: 'low',
            arguments_schema: {
              type: 'object',
              properties: { input: { type: 'string' } },
            } as unknown as JsonSchema,
          },
        ],
      },
    });
    const result = validateAdditionalProperties(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('bad_tool');
  });
});

// ---------------------------------------------------------------------------
// validateSchemaComplexity
// ---------------------------------------------------------------------------

describe('validateSchemaComplexity', () => {
  it('accepts a simple schema', () => {
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
    };
    const result = validateSchemaComplexity(schema);
    expect(result.valid).toBe(true);
  });

  it('rejects a schema exceeding max depth', () => {
    // Build a deeply nested schema via items recursion
    let inner: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < DEFAULT_SCHEMA_LIMITS.maxDepth + 1; i++) {
      inner = { type: 'array', items: inner };
    }
    const schema = {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: { deep: inner },
    };
    const result = validateSchemaComplexity(schema as unknown as JsonSchema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('depth');
  });

  it('rejects a schema exceeding max properties', () => {
    const properties: Record<string, { type: string }> = {};
    for (let i = 0; i < DEFAULT_SCHEMA_LIMITS.maxProperties + 1; i++) {
      properties[`prop_${i}`] = { type: 'string' };
    }
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: false,
      properties: properties as JsonSchema['properties'],
    };
    const result = validateSchemaComplexity(schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('properties');
  });

  it('rejects a schema containing $ref', () => {
    const schema = {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        self: { $ref: '#' },
      },
    };
    const result = validateSchemaComplexity(schema as unknown as JsonSchema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('$ref');
  });

  it('detects $ref in nested objects', () => {
    const schema = {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        wrapper: {
          type: 'object',
          properties: {
            recursive: { $ref: '#/properties/wrapper' },
          },
        },
      },
    };
    const result = validateSchemaComplexity(schema as unknown as JsonSchema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('$ref');
  });

  it('respects custom limits', () => {
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'string' },
      },
    };
    const result = validateSchemaComplexity(schema, { maxDepth: 10, maxProperties: 2 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('properties');
  });

  it('counts nested properties toward the total', () => {
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
      },
    };
    // 2 properties, max 2 should pass
    const result = validateSchemaComplexity(schema, { maxDepth: 10, maxProperties: 2 });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateSkillPaths
// ---------------------------------------------------------------------------

describe('validateSkillPaths', () => {
  it('accepts valid relative skill paths', () => {
    const result = validateSkillPaths(['skill/reminders.md', 'skill/telegram.md']);
    expect(result.valid).toBe(true);
  });

  it('rejects paths with ../ traversal', () => {
    const result = validateSkillPaths(['skill/../../../etc/passwd']);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('path traversal');
  });

  it('rejects paths starting with ../', () => {
    const result = validateSkillPaths(['../outside.md']);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('path traversal');
  });

  it('rejects absolute paths', () => {
    const result = validateSkillPaths(['/etc/passwd']);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('absolute');
  });

  it('rejects paths with backslash traversal', () => {
    const result = validateSkillPaths(['skill\\..\\..\\etc\\passwd']);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('backslash');
  });

  it('accepts an empty skill paths array', () => {
    const result = validateSkillPaths([]);
    expect(result.valid).toBe(true);
  });

  it('reports all invalid paths', () => {
    const result = validateSkillPaths(['../bad1.md', '/bad2.md']);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('rejects paths with encoded traversal (..%2f)', () => {
    const result = validateSkillPaths(['skill/..%2f..%2fetc/passwd']);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('encoded traversal');
  });
});

// ---------------------------------------------------------------------------
// validateManifestSecurity (integration)
// ---------------------------------------------------------------------------

describe('validateManifestSecurity', () => {
  it('passes for a well-formed manifest', () => {
    const manifest = createManifest({
      provides: {
        channels: [],
        tools: [createToolDeclaration({ name: 'good_tool' })],
      },
    });
    const raw = JSON.stringify(manifest);
    const result = validateManifestSecurity(raw, manifest, ['skill/good.md']);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('collects errors from multiple validators', () => {
    const manifest = createManifest({
      provides: {
        channels: [],
        tools: [
          {
            name: 'bad.name',
            description: 'Bad',
            risk_level: 'low',
            arguments_schema: {
              type: 'object',
              properties: { x: { type: 'string' } },
            } as unknown as JsonSchema,
          },
        ],
      },
    });
    const raw = JSON.stringify(manifest);
    const result = validateManifestSecurity(raw, manifest, ['../escape.md']);
    expect(result.valid).toBe(false);
    // Should have errors from tool name, additionalProperties, and skill path
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects oversized manifest before any other validation', () => {
    const raw = 'x'.repeat(DEFAULT_MAX_MANIFEST_BYTES + 1);
    const manifest = createManifest();
    const result = validateManifestSecurity(raw, manifest, []);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('exceeds maximum');
  });
});
