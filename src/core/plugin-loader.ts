/**
 * Plugin loader for Carapace.
 *
 * Discovers plugins under a configured directory, validates each manifest
 * against the JSON Schema, registers tools in the catalog, and manages the
 * handler lifecycle (init → run → shutdown).
 *
 * Graceful degradation: a plugin that fails to load is recorded but does not
 * prevent other plugins from loading.
 */

import { readdir, readFile, access } from 'node:fs/promises';
import { join, basename } from 'node:path';

import _Ajv, { type ErrorObject } from 'ajv';
// ajv ESM interop: default export is the constructor
const Ajv = _Ajv.default ?? _Ajv;

import type { PluginManifest } from '../types/index.js';
import { MANIFEST_JSON_SCHEMA } from '../types/index.js';
import { ToolCatalog } from './tool-catalog.js';
import type { PluginHandler, CoreServices, PluginLoadResult } from './plugin-handler.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tool names reserved for core intrinsic operations.
 * Plugins may not declare tools with any of these names.
 */
const RESERVED_INTRINSIC_NAMES: ReadonlySet<string> = new Set([
  'get_diagnostics',
  'list_tools',
  'get_session_info',
]);

// ---------------------------------------------------------------------------
// PluginLoader
// ---------------------------------------------------------------------------

export class PluginLoader {
  private readonly toolCatalog: ToolCatalog;
  private readonly pluginsDir: string;
  private readonly initTimeoutMs: number;
  private readonly loadedHandlers: Map<string, PluginHandler> = new Map();

  constructor(opts: { toolCatalog: ToolCatalog; pluginsDir: string; initTimeoutMs?: number }) {
    this.toolCatalog = opts.toolCatalog;
    this.pluginsDir = opts.pluginsDir;
    this.initTimeoutMs = opts.initTimeoutMs ?? 10_000;
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Scan the plugins directory for subdirectories containing a `manifest.json`.
   * Returns a sorted list of absolute directory paths.
   */
  async discoverPlugins(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.pluginsDir);
    } catch {
      return [];
    }

    const results: string[] = [];
    for (const entry of entries) {
      const dir = join(this.pluginsDir, entry);
      const manifestPath = join(dir, 'manifest.json');
      try {
        await access(manifestPath);
        results.push(dir);
      } catch {
        // No manifest.json — skip this directory
      }
    }

    return results.sort();
  }

  // -------------------------------------------------------------------------
  // Load single plugin
  // -------------------------------------------------------------------------

  /**
   * Load a single plugin from the given directory.
   *
   * Steps:
   *   1. Read and parse manifest.json
   *   2. Validate manifest against JSON Schema
   *   3. Check tool name uniqueness (catalog + reserved intrinsics)
   *   4. Dynamically import handler module
   *   5. Call handler.initialize() with timeout
   *   6. Register tools in catalog
   */
  async loadPlugin(pluginDir: string): Promise<PluginLoadResult> {
    const pluginName = basename(pluginDir);

    // 1. Read manifest
    let rawManifest: string;
    try {
      rawManifest = await readFile(join(pluginDir, 'manifest.json'), 'utf-8');
    } catch {
      return {
        ok: false,
        pluginName,
        error: 'Could not read manifest.json',
        category: 'invalid_manifest',
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawManifest);
    } catch {
      return {
        ok: false,
        pluginName,
        error: 'manifest.json is not valid JSON',
        category: 'invalid_manifest',
      };
    }

    // 2. Validate with ajv
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(MANIFEST_JSON_SCHEMA);
    if (!validate(parsed)) {
      const errors =
        validate.errors?.map((e: ErrorObject) => `${e.instancePath} ${e.message}`).join('; ') ?? '';
      return {
        ok: false,
        pluginName,
        error: `Invalid manifest: ${errors}`,
        category: 'invalid_manifest',
      };
    }

    const manifest = parsed as PluginManifest;

    // 3. Check tool name uniqueness + reserved names
    for (const tool of manifest.provides.tools) {
      if (RESERVED_INTRINSIC_NAMES.has(tool.name)) {
        return {
          ok: false,
          pluginName,
          error: `Tool name "${tool.name}" is reserved for core intrinsics`,
          category: 'invalid_manifest',
        };
      }
      if (this.toolCatalog.has(tool.name)) {
        return {
          ok: false,
          pluginName,
          error: `Tool name "${tool.name}" is already registered by another plugin`,
          category: 'invalid_manifest',
        };
      }
    }

    // 4. Dynamically import handler
    let handler: PluginHandler;
    try {
      handler = await this.importHandler(pluginDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        pluginName,
        error: `Failed to import handler: ${message}`,
        category: 'missing_handler',
      };
    }

    // 5. Initialize with timeout
    try {
      await this.initializeWithTimeout(handler, pluginName);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('timed out');
      return {
        ok: false,
        pluginName,
        error: `Handler initialization failed: ${message}`,
        category: isTimeout ? 'timeout' : 'init_error',
      };
    }

    // 6. Register tools in catalog
    for (const tool of manifest.provides.tools) {
      this.toolCatalog.register(tool, (envelope) => handler.handleRequest(envelope));
    }

    this.loadedHandlers.set(pluginName, handler);

    return { ok: true, pluginName, manifest, handler };
  }

  // -------------------------------------------------------------------------
  // Load all plugins
  // -------------------------------------------------------------------------

  /**
   * Discover and load all plugins. Returns results for both successes and
   * failures. Failed plugins are excluded from the tool catalog.
   */
  async loadAll(): Promise<PluginLoadResult[]> {
    const dirs = await this.discoverPlugins();
    const results: PluginLoadResult[] = [];

    for (const dir of dirs) {
      const result = await this.loadPlugin(dir);
      results.push(result);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /**
   * Call shutdown() on every loaded handler with an optional per-handler
   * timeout. Handlers that exceed the timeout are force-terminated
   * (their promise is abandoned).
   */
  async shutdownAll(timeoutMs?: number): Promise<void> {
    const timeout = timeoutMs ?? 5_000;
    const entries = [...this.loadedHandlers.entries()];

    await Promise.allSettled(
      entries.map(async ([_name, handler]) => {
        await Promise.race([
          handler.shutdown(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('shutdown timed out')), timeout),
          ),
        ]);
      }),
    );

    this.loadedHandlers.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Try to dynamically import handler.js or handler.ts from the plugin dir.
   * Looks for handler.js first, then handler.ts.
   */
  private async importHandler(pluginDir: string): Promise<PluginHandler> {
    const jsPath = join(pluginDir, 'handler.js');
    const tsPath = join(pluginDir, 'handler.ts');

    let handlerModule: Record<string, unknown>;

    try {
      await access(jsPath);
      handlerModule = (await import(jsPath)) as Record<string, unknown>;
    } catch {
      try {
        await access(tsPath);
        handlerModule = (await import(tsPath)) as Record<string, unknown>;
      } catch {
        throw new Error('No handler.js or handler.ts found');
      }
    }

    // Accept either a default export or a named `handler` export
    const exported =
      (handlerModule.default as PluginHandler | undefined) ??
      (handlerModule.handler as PluginHandler | undefined);

    if (!exported || typeof exported.initialize !== 'function') {
      throw new Error('Handler module does not export a valid PluginHandler');
    }

    return exported;
  }

  /**
   * Call handler.initialize() with a timeout. Rejects with a descriptive
   * error if the timeout expires before initialization completes.
   */
  private async initializeWithTimeout(handler: PluginHandler, pluginName: string): Promise<void> {
    const services: CoreServices = {};
    await Promise.race([
      handler.initialize(services),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Plugin "${pluginName}" initialize() timed out`)),
          this.initTimeoutMs,
        ),
      ),
    ]);
  }
}
