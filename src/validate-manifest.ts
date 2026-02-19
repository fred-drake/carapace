/**
 * Manifest validation for Carapace plugins.
 *
 * Standalone validator for `carapace plugin validate [path]`. Performs:
 *   1. JSON syntax check
 *   2. Schema validation (ajv + MANIFEST_JSON_SCHEMA)
 *   3. Tool name uniqueness check
 *   4. additionalProperties: false enforcement on argument schemas
 *   5. Skill file existence check
 *   6. Risk level warnings for high-risk tools
 *
 * Works without a running core — reads manifest.json from the plugin
 * directory and reports pass/fail with specific error messages.
 */

import _Ajv from 'ajv';
// ajv ESM interop: CJS default export may be wrapped in { default: ... }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv: new (opts?: any) => any = (_Ajv as any).default ?? _Ajv;
import { MANIFEST_JSON_SCHEMA } from './types/manifest-schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single validation message (error or warning). */
export interface ValidationMessage {
  /** The field or location that triggered the message. */
  field: string;
  /** Human-readable description of the issue. */
  message: string;
}

/** Result of validating a plugin manifest. */
export interface ValidationResult {
  /** True if the manifest passes all checks (warnings are allowed). */
  valid: boolean;
  /** Hard errors that cause validation failure. */
  errors: ValidationMessage[];
  /** Non-fatal warnings (e.g. high risk level). */
  warnings: ValidationMessage[];
}

/** Injectable dependencies for the validator. */
export interface ValidateManifestDeps {
  /** Read a file's contents as a string. Throws on missing file. */
  readFile: (path: string) => string;
  /** Check whether a file exists. */
  fileExists: (path: string) => boolean;
  /** Write to stdout. */
  stdout: (msg: string) => void;
  /** Write to stderr. */
  stderr: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

/**
 * Validate a plugin manifest at the given directory path.
 *
 * @param pluginDir - Absolute path to the plugin directory (containing manifest.json).
 * @param deps - Injectable dependencies for file I/O and output.
 * @returns Validation result with errors and warnings.
 */
export function validateManifest(pluginDir: string, deps: ValidateManifestDeps): ValidationResult {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];
  const manifestPath = `${pluginDir}/manifest.json`;

  // 1. Read and parse JSON
  let raw: string;
  try {
    raw = deps.readFile(manifestPath);
  } catch {
    errors.push({
      field: 'manifest.json',
      message: `Cannot read manifest.json: file not found at ${manifestPath}`,
    });
    return reportResult({ valid: false, errors, warnings }, deps);
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    errors.push({
      field: 'manifest.json',
      message: `Invalid JSON syntax: ${detail}`,
    });
    return reportResult({ valid: false, errors, warnings }, deps);
  }

  // 2. Schema validation via ajv
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(MANIFEST_JSON_SCHEMA);
  const schemaValid = validate(manifest);

  if (!schemaValid && validate.errors) {
    for (const err of validate.errors) {
      const field = err.instancePath || '/';
      let message = err.message ?? 'Unknown schema error';

      // Improve error messages for common cases
      if (err.keyword === 'additionalProperties') {
        const extra = (err.params as { additionalProperty?: string }).additionalProperty;
        if (extra) {
          message = `Additional property "${extra}" is not allowed`;
        }
      } else if (err.keyword === 'required') {
        const missing = (err.params as { missingProperty?: string }).missingProperty;
        if (missing) {
          message = `Missing required property "${missing}" (${missing})`;
        }
      }

      errors.push({ field, message });
    }
  }

  // If schema failed, skip semantic checks (manifest structure isn't reliable)
  if (errors.length > 0) {
    return reportResult({ valid: false, errors, warnings }, deps);
  }

  // 3. Tool name uniqueness
  const tools = (manifest.provides as { tools: Array<{ name: string; risk_level: string }> }).tools;
  const seenNames = new Set<string>();
  for (const tool of tools) {
    if (seenNames.has(tool.name)) {
      errors.push({
        field: `provides.tools[${tool.name}]`,
        message: `Duplicate tool name: "${tool.name}"`,
      });
    }
    seenNames.add(tool.name);
  }

  // 4. additionalProperties: false enforcement (belt-and-suspenders beyond schema)
  for (const tool of tools) {
    const schema = (tool as Record<string, unknown>).arguments_schema as
      | Record<string, unknown>
      | undefined;
    if (schema && schema.additionalProperties !== false) {
      errors.push({
        field: `provides.tools[${tool.name}].arguments_schema`,
        message: `Tool "${tool.name}" arguments_schema must have additionalProperties: false`,
      });
    }
  }

  // 5. Skill file existence
  const pluginName = pluginDir.split('/').pop() ?? '';
  const skillPath = `${pluginDir}/skills/${pluginName}.md`;
  if (!deps.fileExists(skillPath)) {
    errors.push({
      field: `skills/${pluginName}.md`,
      message: `Missing skill file: expected ${skillPath}`,
    });
  }

  // 6. Risk level warnings
  for (const tool of tools) {
    if (tool.risk_level === 'high') {
      warnings.push({
        field: `provides.tools[${tool.name}].risk_level`,
        message: `Tool "${tool.name}" has high risk level — requires user confirmation for every invocation`,
      });
    }
  }

  const valid = errors.length === 0;
  return reportResult({ valid, errors, warnings }, deps);
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function reportResult(result: ValidationResult, deps: ValidateManifestDeps): ValidationResult {
  if (result.valid) {
    deps.stdout('  PASS  Manifest validation passed');
  } else {
    deps.stderr('  FAIL  Manifest validation failed');
  }

  for (const error of result.errors) {
    deps.stderr(`  ERROR [${error.field}] ${error.message}`);
  }

  for (const warning of result.warnings) {
    deps.stdout(`  WARN  [${warning.field}] ${warning.message}`);
  }

  return result;
}
