import { describe, it, expect } from 'vitest';
import { SchemaValidator } from './schema-validator.js';
import type { JsonSchema } from '../types/manifest.js';
import { createToolDeclaration } from '../testing/factories.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simpleSchema(overrides?: Partial<JsonSchema>): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      age: { type: 'integer' },
    },
    required: ['name'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchemaValidator', () => {
  describe('compile', () => {
    it('compiles a valid JSON Schema without throwing', () => {
      const validator = new SchemaValidator();
      expect(() => validator.compile('test_tool', simpleSchema())).not.toThrow();
    });

    it('throws on invalid schema definition', () => {
      const validator = new SchemaValidator();
      const bad = {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          x: { type: 'not-a-type' },
        },
      };
      expect(() => validator.compile('bad_tool', bad)).toThrow();
    });

    it('throws when compiling the same tool name twice', () => {
      const validator = new SchemaValidator();
      validator.compile('dup', simpleSchema());
      expect(() => validator.compile('dup', simpleSchema())).toThrow(
        'Schema already compiled for tool: "dup"',
      );
    });
  });

  describe('validate — passing', () => {
    it('accepts valid arguments matching the schema', () => {
      const validator = new SchemaValidator();
      validator.compile('greet', simpleSchema());

      const result = validator.validate('greet', { name: 'Alice', age: 30 });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('accepts arguments with optional fields omitted', () => {
      const validator = new SchemaValidator();
      validator.compile('greet', simpleSchema());

      const result = validator.validate('greet', { name: 'Bob' });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe('validate — additionalProperties rejected', () => {
    it('rejects extra properties not in the schema', () => {
      const validator = new SchemaValidator();
      validator.compile('strict', simpleSchema());

      const result = validator.validate('strict', { name: 'Alice', extra: true });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('extra');
    });
  });

  describe('validate — missing required fields', () => {
    it('reports missing required fields with clear path', () => {
      const validator = new SchemaValidator();
      validator.compile('require_test', simpleSchema());

      const result = validator.validate('require_test', { age: 25 });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('name');
    });
  });

  describe('validate — type mismatch', () => {
    it('rejects arguments with wrong types', () => {
      const validator = new SchemaValidator();
      validator.compile('type_check', simpleSchema());

      const result = validator.validate('type_check', { name: 123 });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('/name');
    });
  });

  describe('validate — nested objects', () => {
    it('validates nested fields and reports JSON path', () => {
      const nestedSchema: JsonSchema = {
        type: 'object',
        additionalProperties: false,
        properties: {
          config: {
            type: 'object',
            description: 'nested config',
            items: undefined,
          },
        },
        required: ['config'],
      };

      // Use a raw schema for deeper nesting so ajv can enforce it.
      // We compile a schema with nested object properties via raw ajv schema.
      const validator = new SchemaValidator();
      const rawNested = {
        type: 'object' as const,
        additionalProperties: false as const,
        required: ['config'],
        properties: {
          config: {
            type: 'object',
            additionalProperties: false,
            required: ['host'],
            properties: {
              host: { type: 'string' },
              port: { type: 'integer' },
            },
          },
        },
      };
      validator.compile('nested', rawNested);

      // Valid nested
      expect(validator.validate('nested', { config: { host: 'localhost', port: 80 } }).valid).toBe(
        true,
      );

      // Missing nested required field
      const result = validator.validate('nested', { config: { port: 80 } });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('/config');
      expect(result.errors[0]).toContain('host');
    });

    it('rejects additional properties in nested objects', () => {
      const validator = new SchemaValidator();
      const rawNested = {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          nested: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: { type: 'string' },
            },
          },
        },
      };
      validator.compile('nested_strict', rawNested);

      const result = validator.validate('nested_strict', {
        nested: { field: 'ok', surprise: true },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('/nested');
    });
  });

  describe('validate — arrays', () => {
    it('validates array items against their schema', () => {
      const validator = new SchemaValidator();
      const arraySchema: JsonSchema = {
        type: 'object',
        additionalProperties: false,
        properties: {
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['tags'],
      };
      validator.compile('array_test', arraySchema);

      // Valid
      expect(validator.validate('array_test', { tags: ['a', 'b'] }).valid).toBe(true);

      // Invalid item type
      const result = validator.validate('array_test', { tags: ['a', 42] });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('/tags');
    });
  });

  describe('validate — all JSON Schema draft-07 types', () => {
    it('validates string type', () => {
      const validator = new SchemaValidator();
      validator.compile('str', {
        type: 'object',
        additionalProperties: false,
        properties: { val: { type: 'string' } },
        required: ['val'],
      });
      expect(validator.validate('str', { val: 'hello' }).valid).toBe(true);
      expect(validator.validate('str', { val: 42 }).valid).toBe(false);
    });

    it('validates number type', () => {
      const validator = new SchemaValidator();
      validator.compile('num', {
        type: 'object',
        additionalProperties: false,
        properties: { val: { type: 'number' } },
        required: ['val'],
      });
      expect(validator.validate('num', { val: 3.14 }).valid).toBe(true);
      expect(validator.validate('num', { val: 'nope' }).valid).toBe(false);
    });

    it('validates integer type', () => {
      const validator = new SchemaValidator();
      validator.compile('int', {
        type: 'object',
        additionalProperties: false,
        properties: { val: { type: 'integer' } },
        required: ['val'],
      });
      expect(validator.validate('int', { val: 42 }).valid).toBe(true);
      expect(validator.validate('int', { val: 3.14 }).valid).toBe(false);
    });

    it('validates boolean type', () => {
      const validator = new SchemaValidator();
      validator.compile('bool', {
        type: 'object',
        additionalProperties: false,
        properties: { val: { type: 'boolean' } },
        required: ['val'],
      });
      expect(validator.validate('bool', { val: true }).valid).toBe(true);
      expect(validator.validate('bool', { val: 'yes' }).valid).toBe(false);
    });

    it('validates null type', () => {
      const validator = new SchemaValidator();
      validator.compile('nil', {
        type: 'object',
        additionalProperties: false,
        properties: { val: { type: 'null' } },
        required: ['val'],
      });
      expect(validator.validate('nil', { val: null }).valid).toBe(true);
      expect(validator.validate('nil', { val: 0 }).valid).toBe(false);
    });
  });

  describe('prototype pollution protection', () => {
    it('rejects __proto__ key in arguments', () => {
      const validator = new SchemaValidator();
      validator.compile('proto_test', simpleSchema());

      const malicious = JSON.parse('{"name":"ok","__proto__":{"admin":true}}');
      const result = validator.validate('proto_test', malicious);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('__proto__');
    });

    it('rejects constructor key in arguments', () => {
      const validator = new SchemaValidator();
      validator.compile('ctor_test', simpleSchema());

      const result = validator.validate('ctor_test', { name: 'ok', constructor: {} });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('constructor');
    });

    it('rejects prototype key in arguments', () => {
      const validator = new SchemaValidator();
      validator.compile('prototype_test', simpleSchema());

      const result = validator.validate('prototype_test', { name: 'ok', prototype: {} });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('prototype');
    });

    it('rejects prototype pollution keys in nested objects', () => {
      const validator = new SchemaValidator();
      const rawNested = {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            properties: {
              value: { type: 'string' },
            },
          },
        },
      };
      validator.compile('nested_proto', rawNested);

      const malicious = { data: JSON.parse('{"value":"ok","__proto__":{"admin":true}}') };
      const result = validator.validate('nested_proto', malicious);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('__proto__');
    });
  });

  describe('schema caching', () => {
    it('reuses compiled validator across multiple validate calls', () => {
      const validator = new SchemaValidator();
      validator.compile('cached', simpleSchema());

      // Multiple validations should work without re-compiling
      const r1 = validator.validate('cached', { name: 'A' });
      const r2 = validator.validate('cached', { name: 'B' });
      const r3 = validator.validate('cached', { name: 'C', age: 1 });
      expect(r1.valid).toBe(true);
      expect(r2.valid).toBe(true);
      expect(r3.valid).toBe(true);
    });
  });

  describe('validate — uncompiled tool', () => {
    it('throws when validating a tool that was never compiled', () => {
      const validator = new SchemaValidator();
      expect(() => validator.validate('unknown', {})).toThrow(
        'No compiled schema for tool: "unknown"',
      );
    });
  });

  describe('compileFromManifest', () => {
    it('compiles all tools from a plugin manifest', () => {
      const validator = new SchemaValidator();
      const tool1 = createToolDeclaration({ name: 'tool_a' });
      const tool2 = createToolDeclaration({
        name: 'tool_b',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: { count: { type: 'integer' } },
        },
      });

      validator.compileFromTools([tool1, tool2]);

      expect(validator.validate('tool_a', { input: 'hello' }).valid).toBe(true);
      expect(validator.validate('tool_b', { count: 42 }).valid).toBe(true);
    });
  });
});
