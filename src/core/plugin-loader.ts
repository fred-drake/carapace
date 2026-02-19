/**
 * Plugin loader for Carapace.
 *
 * Discovers plugins under two directories — built-in (read-only,
 * shipped with Carapace) and user (mutable, user-managed) — validates
 * each manifest against the JSON Schema, registers tools in the catalog,
 * and manages the handler lifecycle (init → run → shutdown).
 *
 * User plugins override built-in plugins of the same name.
 * Graceful degradation: a plugin that fails to load is recorded but
 * does not prevent other plugins from loading.
 */

import { readdir, readFile, access } from 'node:fs/promises';
import { join, basename } from 'node:path';

import _Ajv, { type ErrorObject } from 'ajv';
// ajv ESM interop: default export is the constructor
const Ajv = _Ajv.default ?? _Ajv;

import type { PluginManifest } from '../types/index.js';
import { MANIFEST_JSON_SCHEMA } from '../types/index.js';
import { ToolCatalog } from './tool-catalog.js';
import type {
  PluginHandler,
  CoreServices,
  PluginLoadResult,
  PluginSource,
} from './plugin-handler.js';

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
// DiscoveredPlugin
// ---------------------------------------------------------------------------

/** A plugin found during directory scanning. */
export interface DiscoveredPlugin {
  name: string;
  dir: string;
  source: PluginSource;
}

// ---------------------------------------------------------------------------
// PluginLoader
// ---------------------------------------------------------------------------

export class PluginLoader {
  private readonly toolCatalog: ToolCatalog;
  private readonly userPluginsDir: string;
  private readonly builtinPluginsDir: string | undefined;
  private readonly initTimeoutMs: number;
  private readonly loadedHandlers: Map<string, PluginHandler> = new Map();

  constructor(opts: {
    toolCatalog: ToolCatalog;
    userPluginsDir: string;
    builtinPluginsDir?: string;
    initTimeoutMs?: number;
  }) {
    this.toolCatalog = opts.toolCatalog;
    this.userPluginsDir = opts.userPluginsDir;
    this.builtinPluginsDir = opts.builtinPluginsDir;
    this.initTimeoutMs = opts.initTimeoutMs ?? 10_000;
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Scan a single directory for subdirectories containing a `manifest.json`.
   * Returns a list of discovered plugins with their source tag.
   */
  private async discoverPluginsInDir(
    dir: string,
    source: PluginSource,
  ): Promise<DiscoveredPlugin[]> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    const results: DiscoveredPlugin[] = [];
    for (const entry of entries) {
      const pluginDir = join(dir, entry);
      const manifestPath = join(pluginDir, 'manifest.json');
      try {
        await access(manifestPath);
        results.push({ name: entry, dir: pluginDir, source });
      } catch {
        // No manifest.json — skip this directory
      }
    }

    return results;
  }

  /**
   * Scan both built-in and user plugin directories. User plugins override
   * built-in plugins of the same name. Returns a sorted list of discovered
   * plugins.
   */
  async discoverPlugins(): Promise<DiscoveredPlugin[]> {
    // Scan built-in first, then user (user overrides)
    const builtinPlugins = this.builtinPluginsDir
      ? await this.discoverPluginsInDir(this.builtinPluginsDir, 'built-in')
      : [];
    const userPlugins = await this.discoverPluginsInDir(this.userPluginsDir, 'user');

    // Merge: user overrides built-in of same name
    const merged = new Map<string, DiscoveredPlugin>();
    for (const plugin of builtinPlugins) {
      merged.set(plugin.name, plugin);
    }
    for (const plugin of userPlugins) {
      merged.set(plugin.name, plugin);
    }

    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
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
  async loadPlugin(pluginDir: string, source: PluginSource = 'user'): Promise<PluginLoadResult> {
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

    // 6. Register tools in catalog — bridge envelope to handleToolInvocation
    for (const tool of manifest.provides.tools) {
      this.toolCatalog.register(tool, async (envelope) => {
        const toolName = envelope.topic.replace('tool.invoke.', '');
        const result = await handler.handleToolInvocation(toolName, envelope.payload.arguments, {
          group: envelope.group,
          sessionId: envelope.source,
          correlationId: envelope.correlation,
          timestamp: envelope.timestamp,
        });
        if (result.ok) {
          return result.result;
        }
        return { error: result.error };
      });
    }

    this.loadedHandlers.set(pluginName, handler);

    return { ok: true, pluginName, manifest, handler, source };
  }

  // -------------------------------------------------------------------------
  // Load all plugins
  // -------------------------------------------------------------------------

  /**
   * Discover and load all plugins from both directories. User plugins
   * override built-in plugins of the same name. Returns results for
   * both successes and failures. Failed plugins are excluded from the
   * tool catalog.
   */
  async loadAll(): Promise<PluginLoadResult[]> {
    const discovered = await this.discoverPlugins();
    const results: PluginLoadResult[] = [];

    for (const plugin of discovered) {
      const result = await this.loadPlugin(plugin.dir, plugin.source);
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

    if (
      !exported ||
      typeof exported.initialize !== 'function' ||
      typeof exported.handleToolInvocation !== 'function'
    ) {
      throw new Error('Handler module does not export a valid PluginHandler');
    }

    return exported;
  }

  /**
   * Call handler.initialize() with a timeout. Rejects with a descriptive
   * error if the timeout expires before initialization completes.
   */
  private async initializeWithTimeout(handler: PluginHandler, pluginName: string): Promise<void> {
    const services: CoreServices = {
      getAuditLog: async () => [],
      getToolCatalog: () => this.toolCatalog.list(),
      getSessionInfo: () => ({ group: '', sessionId: '', startedAt: '' }),
    };
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
