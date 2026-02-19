/**
 * Plugin conformance test suite for Carapace.
 *
 * Validates any plugin against its manifest contract. Checks:
 *   1. Manifest parsing and schema validation
 *   2. Handler import and lifecycle (init → handle → shutdown)
 *   3. Tool callability with valid arguments
 *   4. Schema enforcement (rejects invalid/extra arguments)
 *   5. Risk level declarations
 *
 * Usage (in a test file):
 *   import { describePluginConformance } from './conformance.js';
 *   describePluginConformance({ pluginDir: 'path/to/plugin' });
 *
 * Or via CLI:
 *   pnpm test:conformance -- plugins/my-plugin/
 */

import * as fs from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import _Ajv from 'ajv';
const Ajv = (_Ajv as unknown as { default?: typeof _Ajv }).default ?? _Ajv;

import { MANIFEST_JSON_SCHEMA } from '../types/manifest-schema.js';
import { SchemaValidator } from '../core/schema-validator.js';
import type { PluginManifest, ToolDeclaration } from '../types/manifest.js';
import type { PluginHandler, CoreServices, PluginContext } from '../core/plugin-handler.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ConformanceOptions {
  /** Absolute or relative path to the plugin directory. */
  pluginDir: string;
  /**
   * Optional sample arguments per tool. Keys are tool names, values are
   * valid argument objects. If not provided, the suite generates minimal
   * valid args from the schema (empty object for tools with no required fields).
   */
  sampleArgs?: Record<string, Record<string, unknown>>;
  /** Timeout for handler initialization in milliseconds. Default 5000. */
  initTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCoreServices(): CoreServices {
  return {
    getAuditLog: async () => [],
    getToolCatalog: () => [],
    getSessionInfo: () => ({
      group: 'conformance-test',
      sessionId: 'sess-conformance',
      startedAt: new Date().toISOString(),
    }),
  };
}

function makePluginContext(): PluginContext {
  return {
    group: 'conformance-test',
    sessionId: 'sess-conformance',
    correlationId: 'corr-conformance',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Generate minimal valid arguments from a tool's schema.
 * For required string fields, uses an empty string.
 * For required number fields, uses 0.
 * For optional fields, omits them.
 */
function generateMinimalArgs(tool: ToolDeclaration): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const required = new Set(tool.arguments_schema.required ?? []);

  for (const [name, prop] of Object.entries(tool.arguments_schema.properties)) {
    if (!required.has(name)) continue;

    switch (prop.type) {
      case 'string':
        args[name] = prop.enum ? prop.enum[0] : 'test';
        break;
      case 'number':
      case 'integer':
        args[name] = prop.minimum ?? 0;
        break;
      case 'boolean':
        args[name] = false;
        break;
      case 'array':
        args[name] = [];
        break;
      case 'object':
        args[name] = {};
        break;
      default:
        args[name] = null;
    }
  }

  return args;
}

/**
 * Import a plugin handler from the plugin directory.
 * Tries handler.ts first (for dev), then handler.js (for built plugins).
 */
async function importHandler(pluginDir: string): Promise<PluginHandler> {
  const tsPath = join(pluginDir, 'handler.ts');
  const jsPath = join(pluginDir, 'handler.js');

  let handlerModule: Record<string, unknown>;

  if (fs.existsSync(tsPath)) {
    handlerModule = (await import(tsPath)) as Record<string, unknown>;
  } else if (fs.existsSync(jsPath)) {
    handlerModule = (await import(jsPath)) as Record<string, unknown>;
  } else {
    throw new Error(`No handler.ts or handler.js found in ${pluginDir}`);
  }

  const exported =
    (handlerModule.default as PluginHandler | undefined) ??
    (handlerModule.handler as PluginHandler | undefined);

  if (!exported) {
    throw new Error('Handler module does not export a default or named "handler" export');
  }

  return exported;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full conformance test suite for a plugin.
 *
 * Call this inside a vitest test file. It generates describe/it blocks
 * that validate the plugin against its manifest contract.
 */
export function describePluginConformance(options: ConformanceOptions): void {
  const pluginDir = resolve(options.pluginDir);
  const pluginName = basename(pluginDir);
  const initTimeout = options.initTimeoutMs ?? 5_000;

  // ---------------------------------------------------------------------------
  // Load manifest synchronously (needed for dynamic test generation)
  // ---------------------------------------------------------------------------

  const manifestPath = join(pluginDir, 'manifest.json');
  let rawManifest: string;
  let manifest: PluginManifest;

  try {
    rawManifest = fs.readFileSync(manifestPath, 'utf-8');
    manifest = JSON.parse(rawManifest) as PluginManifest;
  } catch (err) {
    // If manifest can't be loaded, create a single failing test
    describe(`Plugin conformance: ${pluginName}`, () => {
      it('has a valid manifest.json', () => {
        expect.fail(
          `Could not load manifest.json from ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Test suite
  // ---------------------------------------------------------------------------

  describe(`Plugin conformance: ${pluginName}`, () => {
    let handler: PluginHandler;

    beforeAll(async () => {
      handler = await importHandler(pluginDir);
      await Promise.race([
        handler.initialize(makeCoreServices()),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`initialize() timed out after ${initTimeout}ms`)),
            initTimeout,
          ),
        ),
      ]);
    }, initTimeout + 1_000);

    afterAll(async () => {
      if (handler?.shutdown) {
        await handler.shutdown();
      }
    });

    // -----------------------------------------------------------------------
    // 1. Manifest validation
    // -----------------------------------------------------------------------

    describe('manifest', () => {
      it('is valid JSON', () => {
        expect(() => JSON.parse(rawManifest)).not.toThrow();
      });

      it('validates against the manifest JSON Schema', () => {
        const ajv = new Ajv({ allErrors: true });
        const validate = ajv.compile(MANIFEST_JSON_SCHEMA);
        const valid = validate(JSON.parse(rawManifest));

        if (!valid) {
          const errors = validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ');
          expect.fail(`Manifest schema validation failed: ${errors}`);
        }
      });

      it('has a non-empty description', () => {
        expect(manifest.description).toBeTruthy();
        expect(manifest.description.length).toBeGreaterThan(0);
      });

      it('has a valid semver version', () => {
        expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
      });

      it('has an author with a name', () => {
        expect(manifest.author).toBeDefined();
        expect(manifest.author.name).toBeTruthy();
      });

      it('declares at least one tool', () => {
        expect(manifest.provides.tools.length).toBeGreaterThan(0);
      });

      it('has unique tool names', () => {
        const names = manifest.provides.tools.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
      });

      for (const tool of manifest.provides.tools) {
        it(`tool "${tool.name}" has additionalProperties: false`, () => {
          expect(tool.arguments_schema.additionalProperties).toBe(false);
        });
      }
    });

    // -----------------------------------------------------------------------
    // 2. Handler import & lifecycle
    // -----------------------------------------------------------------------

    describe('handler lifecycle', () => {
      it('exports a valid PluginHandler', () => {
        expect(typeof handler.initialize).toBe('function');
        expect(typeof handler.handleToolInvocation).toBe('function');
        expect(typeof handler.shutdown).toBe('function');
      });

      it('handleEvent is either a function or undefined', () => {
        if (handler.handleEvent !== undefined) {
          expect(typeof handler.handleEvent).toBe('function');
        }
      });
    });

    // -----------------------------------------------------------------------
    // 3. Tool callability
    // -----------------------------------------------------------------------

    describe('tool callability', () => {
      for (const tool of manifest.provides.tools) {
        it(`"${tool.name}" is callable with valid arguments`, async () => {
          const args = options.sampleArgs?.[tool.name] ?? generateMinimalArgs(tool);
          const result = await handler.handleToolInvocation(tool.name, args, makePluginContext());

          expect(result).toBeDefined();
          expect(typeof result.ok).toBe('boolean');

          if (result.ok) {
            expect(result.result).toBeDefined();
            expect(typeof result.result).toBe('object');
          } else {
            // Handler returned a structured error — still valid
            expect(result.error).toBeDefined();
            expect(result.error.code).toBeTruthy();
            expect(result.error.message).toBeTruthy();
          }
        });

        it(`"${tool.name}" returns a well-formed ToolInvocationResult`, async () => {
          const args = options.sampleArgs?.[tool.name] ?? generateMinimalArgs(tool);
          const result = await handler.handleToolInvocation(tool.name, args, makePluginContext());

          // Must be a discriminated union
          if (result.ok) {
            expect(result).toHaveProperty('result');
          } else {
            expect(result).toHaveProperty('error');
            expect(result.error).toHaveProperty('code');
            expect(result.error).toHaveProperty('message');
            expect(result.error).toHaveProperty('retriable');
          }
        });
      }
    });

    // -----------------------------------------------------------------------
    // 4. Schema enforcement
    // -----------------------------------------------------------------------

    describe('schema validation', () => {
      const schemaValidator = new SchemaValidator();

      beforeAll(() => {
        for (const tool of manifest.provides.tools) {
          schemaValidator.compile(tool.name, tool.arguments_schema);
        }
      });

      for (const tool of manifest.provides.tools) {
        it(`"${tool.name}" schema accepts valid arguments`, () => {
          const args = options.sampleArgs?.[tool.name] ?? generateMinimalArgs(tool);
          const result = schemaValidator.validate(tool.name, args);

          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        });

        it(`"${tool.name}" schema rejects additional properties`, () => {
          const args = {
            ...(options.sampleArgs?.[tool.name] ?? generateMinimalArgs(tool)),
            __extra_undeclared_property__: 'should fail',
          };
          const result = schemaValidator.validate(tool.name, args);

          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
        });

        it(`"${tool.name}" schema rejects prototype pollution keys`, () => {
          const args = {
            ...(options.sampleArgs?.[tool.name] ?? generateMinimalArgs(tool)),
            __proto__: { polluted: true },
          };
          const result = schemaValidator.validate(tool.name, args);

          expect(result.valid).toBe(false);
        });
      }
    });

    // -----------------------------------------------------------------------
    // 5. Risk levels
    // -----------------------------------------------------------------------

    describe('risk levels', () => {
      for (const tool of manifest.provides.tools) {
        it(`"${tool.name}" has a valid risk_level`, () => {
          expect(['low', 'high']).toContain(tool.risk_level);
        });
      }
    });
  });
}
