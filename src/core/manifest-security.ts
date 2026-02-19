/**
 * Plugin manifest security validation for Carapace.
 *
 * Defense-in-depth checks that go beyond ARCH-03 schema validation.
 * These validations catch attack vectors that basic JSON Schema cannot:
 * recursive $ref DoS, topic injection via tool names, path traversal
 * in skill files, and oversized manifests.
 */

import type { PluginManifest, JsonSchema } from '../types/index.js';
import type { ToolDeclaration } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecurityResult {
  valid: boolean;
  errors: string[];
}

export interface SchemaLimits {
  /** Maximum nesting depth for schema objects/arrays. */
  maxDepth: number;
  /** Maximum number of properties in a single schema object. */
  maxProperties: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default maximum manifest file size in bytes (64 KB). */
export const DEFAULT_MAX_MANIFEST_BYTES = 65_536;

/** Default schema complexity limits. */
export const DEFAULT_SCHEMA_LIMITS: Readonly<SchemaLimits> = {
  maxDepth: 5,
  maxProperties: 30,
};

/**
 * Tool names must be lowercase alphanumeric + underscores, starting with
 * a letter. This prevents topic injection (dots), path traversal (slashes),
 * and command injection (special chars).
 */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

// ---------------------------------------------------------------------------
// validateManifestSize
// ---------------------------------------------------------------------------

/**
 * Reject manifests that exceed the maximum byte size.
 * This check runs before JSON parsing to prevent memory exhaustion.
 */
export function validateManifestSize(
  raw: string,
  maxBytes: number = DEFAULT_MAX_MANIFEST_BYTES,
): SecurityResult {
  const byteLength = Buffer.byteLength(raw, 'utf-8');
  if (byteLength > maxBytes) {
    return {
      valid: false,
      errors: [`Manifest size (${byteLength} bytes) exceeds maximum (${maxBytes} bytes)`],
    };
  }
  return { valid: true, errors: [] };
}

// ---------------------------------------------------------------------------
// validateToolNames
// ---------------------------------------------------------------------------

/**
 * Validate tool names against allowed characters.
 *
 * Tool names become part of topic strings (`tool.invoke.{name}`). Dots,
 * slashes, spaces, and special characters could enable topic injection
 * or command injection attacks.
 */
export function validateToolNames(tools: ToolDeclaration[]): SecurityResult {
  const errors: string[] = [];

  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      errors.push(
        `Tool "${tool.name}" has invalid characters. ` +
          `Names must match ${TOOL_NAME_PATTERN} (lowercase alphanumeric and underscores, starting with a letter)`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// validateAdditionalProperties
// ---------------------------------------------------------------------------

/**
 * Verify that every tool's `arguments_schema` has `additionalProperties: false`.
 *
 * This is a belt-and-suspenders check — the JSON Schema validator also
 * enforces this, but we check explicitly as defense-in-depth since a
 * missing `additionalProperties` would allow arbitrary data injection.
 */
export function validateAdditionalProperties(manifest: PluginManifest): SecurityResult {
  const errors: string[] = [];

  for (const tool of manifest.provides.tools) {
    const schema = tool.arguments_schema as unknown as Record<string, unknown>;
    if (schema.additionalProperties !== false) {
      errors.push(`Tool "${tool.name}": arguments_schema must have additionalProperties: false`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// validateSchemaComplexity
// ---------------------------------------------------------------------------

/**
 * Limit schema complexity to prevent DoS via deeply nested schemas,
 * excessive properties, or recursive `$ref` references.
 */
export function validateSchemaComplexity(
  schema: JsonSchema,
  limits?: Partial<SchemaLimits>,
): SecurityResult {
  const resolved: SchemaLimits = {
    maxDepth: limits?.maxDepth ?? DEFAULT_SCHEMA_LIMITS.maxDepth,
    maxProperties: limits?.maxProperties ?? DEFAULT_SCHEMA_LIMITS.maxProperties,
  };

  const errors: string[] = [];

  // Check for $ref anywhere in the schema tree
  checkForRef(schema as unknown as Record<string, unknown>, '', errors);

  // Check depth
  const depth = measureDepth(schema as unknown as Record<string, unknown>, 0);
  if (depth > resolved.maxDepth) {
    errors.push(`Schema depth (${depth}) exceeds maximum (${resolved.maxDepth})`);
  }

  // Check property count
  const propCount = countProperties(schema as unknown as Record<string, unknown>);
  if (propCount > resolved.maxProperties) {
    errors.push(`Schema has ${propCount} properties, exceeds maximum (${resolved.maxProperties})`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Recursively check for `$ref` keys anywhere in the schema tree.
 */
function checkForRef(obj: Record<string, unknown>, path: string, errors: string[]): void {
  for (const key of Object.keys(obj)) {
    if (key === '$ref') {
      errors.push(`Schema contains $ref at ${path || '/'} — recursive references are not allowed`);
    }
    const value = obj[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      checkForRef(value as Record<string, unknown>, `${path}/${key}`, errors);
    }
  }
}

/**
 * Measure the nesting depth of a schema. Each level of `items` or
 * `properties` containing an object type increments depth.
 */
function measureDepth(obj: Record<string, unknown>, current: number): number {
  let maxFound = current;

  if (obj.properties && typeof obj.properties === 'object') {
    const props = obj.properties as Record<string, unknown>;
    for (const value of Object.values(props)) {
      if (value !== null && typeof value === 'object') {
        const childDepth = measureDepth(value as Record<string, unknown>, current + 1);
        if (childDepth > maxFound) maxFound = childDepth;
      }
    }
  }

  if (obj.items && typeof obj.items === 'object' && !Array.isArray(obj.items)) {
    const childDepth = measureDepth(obj.items as Record<string, unknown>, current + 1);
    if (childDepth > maxFound) maxFound = childDepth;
  }

  return maxFound;
}

/**
 * Count the total number of properties across all schema levels.
 */
function countProperties(obj: Record<string, unknown>): number {
  let count = 0;

  if (obj.properties && typeof obj.properties === 'object') {
    const props = obj.properties as Record<string, unknown>;
    count += Object.keys(props).length;
  }

  return count;
}

// ---------------------------------------------------------------------------
// validateSkillPaths
// ---------------------------------------------------------------------------

/**
 * Validate skill file paths for path traversal attacks.
 *
 * Skill files must be relative paths within the plugin directory.
 * Rejects: `../`, absolute paths, backslash paths, URL-encoded traversal.
 */
export function validateSkillPaths(skillPaths: string[]): SecurityResult {
  const errors: string[] = [];

  for (const p of skillPaths) {
    if (p.startsWith('/')) {
      errors.push(`Skill path "${p}": absolute paths are not allowed`);
    } else if (p.includes('\\')) {
      errors.push(`Skill path "${p}": backslash characters are not allowed`);
    } else if (/%2e/i.test(p) || /%2f/i.test(p) || /%5c/i.test(p)) {
      errors.push(`Skill path "${p}": encoded traversal sequences are not allowed`);
    } else if (p.includes('..')) {
      errors.push(`Skill path "${p}": path traversal (..) is not allowed`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// validateManifestSecurity (top-level)
// ---------------------------------------------------------------------------

/**
 * Run all security validations against a plugin manifest.
 *
 * This is the single entry point called during plugin loading, after
 * basic JSON Schema validation has passed. It aggregates errors from
 * all security checks into a single result.
 */
export function validateManifestSecurity(
  raw: string,
  manifest: PluginManifest,
  skillPaths: string[],
): SecurityResult {
  const allErrors: string[] = [];

  // Size check first — reject before deeper analysis
  const sizeResult = validateManifestSize(raw);
  if (!sizeResult.valid) {
    return sizeResult;
  }

  // Tool name validation
  const nameResult = validateToolNames(manifest.provides.tools);
  allErrors.push(...nameResult.errors);

  // additionalProperties enforcement
  const apResult = validateAdditionalProperties(manifest);
  allErrors.push(...apResult.errors);

  // Schema complexity per tool
  for (const tool of manifest.provides.tools) {
    const complexityResult = validateSchemaComplexity(tool.arguments_schema);
    for (const err of complexityResult.errors) {
      allErrors.push(`Tool "${tool.name}": ${err}`);
    }
  }

  // Skill path traversal
  const pathResult = validateSkillPaths(skillPaths);
  allErrors.push(...pathResult.errors);

  return { valid: allErrors.length === 0, errors: allErrors };
}
