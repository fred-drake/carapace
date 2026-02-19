/**
 * Schema validation engine for Carapace.
 *
 * Validates tool arguments against their declared JSON Schemas (from plugin
 * manifests) using ajv. Enforces additionalProperties: false and prototype
 * pollution protection. Schemas are compiled once at plugin load time and
 * reused for every request.
 */

import _Ajv, { type ValidateFunction } from 'ajv';
// ajv ESM interop: default export is the constructor
const Ajv = _Ajv.default ?? _Ajv;

import type { JsonSchema, ToolDeclaration } from '../types/manifest.js';

// ---------------------------------------------------------------------------
// Prototype pollution keys
// ---------------------------------------------------------------------------

const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// SchemaValidator
// ---------------------------------------------------------------------------

export class SchemaValidator {
  private readonly ajv: InstanceType<typeof Ajv>;
  private readonly validators: Map<string, ValidateFunction> = new Map();

  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
  }

  /**
   * Compile a JSON Schema for a tool and cache the validator.
   *
   * @param toolName - Unique tool name (used as cache key).
   * @param schema - The JSON Schema to compile (typically arguments_schema from manifest).
   * @throws If the tool was already compiled or the schema is invalid.
   */
  compile(toolName: string, schema: JsonSchema | Record<string, unknown>): void {
    if (this.validators.has(toolName)) {
      throw new Error(`Schema already compiled for tool: "${toolName}"`);
    }

    const validate = this.ajv.compile(schema);
    this.validators.set(toolName, validate);
  }

  /**
   * Compile schemas for all tools in a set of tool declarations.
   */
  compileFromTools(tools: ToolDeclaration[]): void {
    for (const tool of tools) {
      this.compile(tool.name, tool.arguments_schema);
    }
  }

  /**
   * Validate arguments against a previously compiled schema.
   *
   * @param toolName - The tool whose schema to validate against.
   * @param args - The arguments object to validate.
   * @returns Validation result with `valid` flag and error messages.
   * @throws If no schema has been compiled for the given tool name.
   */
  validate(toolName: string, args: Record<string, unknown>): ValidationResult {
    const validateFn = this.validators.get(toolName);
    if (!validateFn) {
      throw new Error(`No compiled schema for tool: "${toolName}"`);
    }

    // Check for prototype pollution keys before schema validation
    const pollutionErrors = this.checkPollutionKeys(args, '');
    if (pollutionErrors.length > 0) {
      return { valid: false, errors: pollutionErrors };
    }

    const valid = validateFn(args) as boolean;
    if (valid) {
      return { valid: true, errors: [] };
    }

    const errors = (validateFn.errors ?? []).map((err) => {
      const path = err.instancePath || '';
      const msg = err.message ?? 'unknown error';
      if (err.keyword === 'additionalProperties') {
        const extra = (err.params as { additionalProperty?: string }).additionalProperty ?? '';
        return `${path}: additional property "${extra}" not allowed`;
      }
      if (err.keyword === 'required') {
        const missing = (err.params as { missingProperty?: string }).missingProperty ?? '';
        return `${path}: required property "${missing}" is missing`;
      }
      return `${path}: ${msg}`;
    });

    return { valid: false, errors };
  }

  /**
   * Recursively check for prototype pollution keys in an object.
   */
  private checkPollutionKeys(obj: unknown, path: string): string[] {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      return [];
    }

    const errors: string[] = [];

    for (const key of Object.keys(obj as Record<string, unknown>)) {
      if (POLLUTION_KEYS.has(key)) {
        errors.push(`${path}/${key}: prototype pollution key "${key}" is not allowed`);
      }
      const value = (obj as Record<string, unknown>)[key];
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        errors.push(...this.checkPollutionKeys(value, `${path}/${key}`));
      }
    }

    return errors;
  }
}
