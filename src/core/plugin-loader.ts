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
import { readCredentialFile } from '../security/credential-dir-security.js';

import _Ajv, { type ErrorObject } from 'ajv';
// ajv ESM interop: default export is the constructor
const Ajv = _Ajv.default ?? _Ajv;

import type { PluginManifest } from '../types/index.js';
import { MANIFEST_JSON_SCHEMA } from '../types/index.js';
import { ToolCatalog } from './tool-catalog.js';
import type {
  PluginHandler,
  CoreServices,
  ChannelServices,
  PluginLoadResult,
  PluginSource,
} from './plugin-handler.js';
import { formatErrorMessage } from './plugin-handler.js';
import type { EventBus } from './event-bus.js';
import { createLogger, type Logger } from './logger.js';

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
  private readonly credentialsPluginsDir: string | undefined;
  private readonly initTimeoutMs: number;
  private readonly eventBus: EventBus | undefined;
  private readonly logger: Logger;
  private readonly loadedHandlers: Map<string, PluginHandler> = new Map();
  private readonly loadedManifests: Map<string, PluginManifest> = new Map();
  private readonly reservedPluginNames: Set<string> = new Set();

  constructor(opts: {
    toolCatalog: ToolCatalog;
    userPluginsDir: string;
    builtinPluginsDir?: string;
    credentialsPluginsDir?: string;
    initTimeoutMs?: number;
    eventBus?: EventBus;
    logger?: Logger;
  }) {
    this.toolCatalog = opts.toolCatalog;
    this.userPluginsDir = opts.userPluginsDir;
    this.builtinPluginsDir = opts.builtinPluginsDir;
    this.credentialsPluginsDir = opts.credentialsPluginsDir;
    this.initTimeoutMs = opts.initTimeoutMs ?? 10_000;
    this.eventBus = opts.eventBus;
    this.logger = opts.logger ?? createLogger('plugin-loader');
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
    // Skip any names that are reserved (registered via registerBuiltinHandler)
    const merged = new Map<string, DiscoveredPlugin>();
    for (const plugin of builtinPlugins) {
      if (!this.reservedPluginNames.has(plugin.name)) {
        merged.set(plugin.name, plugin);
      }
    }
    for (const plugin of userPlugins) {
      if (!this.reservedPluginNames.has(plugin.name)) {
        merged.set(plugin.name, plugin);
      }
    }

    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // -------------------------------------------------------------------------
  // Accessor
  // -------------------------------------------------------------------------

  /**
   * Return the loaded handler for the given plugin directory name,
   * or undefined if no plugin by that name has been loaded.
   */
  getHandler(pluginName: string): PluginHandler | undefined {
    return this.loadedHandlers.get(pluginName);
  }

  // -------------------------------------------------------------------------
  // Built-in handler registration
  // -------------------------------------------------------------------------

  /**
   * Register a pre-constructed handler as a built-in plugin.
   *
   * Unlike filesystem-discovered plugins, built-in handlers are constructed
   * by the application factory with their dependencies already injected.
   * This method:
   *   1. Validates tool name uniqueness (catalog + reserved intrinsics)
   *   2. Calls handler.initialize() with CoreServices (with timeout)
   *   3. Registers tools in the catalog
   *   4. Marks the plugin name as reserved (cannot be overridden by user plugins)
   *
   * @param name - The plugin name (e.g. "installer")
   * @param handler - The pre-constructed PluginHandler instance
   * @param manifest - The plugin's manifest (parsed, not from disk)
   */
  async registerBuiltinHandler(
    name: string,
    handler: PluginHandler,
    manifest: PluginManifest,
  ): Promise<PluginLoadResult> {
    this.logger.info('registering built-in handler', { pluginName: name });

    // 1. Check tool name uniqueness + reserved names
    for (const tool of manifest.provides.tools) {
      if (RESERVED_INTRINSIC_NAMES.has(tool.name)) {
        this.logger.warn('built-in handler registration failed', {
          pluginName: name,
          category: 'invalid_manifest',
          reason: 'reserved tool name',
        });
        return {
          ok: false,
          pluginName: name,
          error: `Tool name "${tool.name}" is reserved for core intrinsics`,
          category: 'invalid_manifest',
        };
      }
      if (this.toolCatalog.has(tool.name)) {
        this.logger.warn('built-in handler registration failed', {
          pluginName: name,
          category: 'invalid_manifest',
          reason: 'tool name collision',
        });
        return {
          ok: false,
          pluginName: name,
          error: `Tool name "${tool.name}" is already registered by another plugin`,
          category: 'invalid_manifest',
        };
      }
    }

    // 2. Initialize with timeout
    try {
      await this.initializeWithTimeout(handler, name, manifest);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('timed out');
      const category = isTimeout ? 'timeout' : 'init_error';
      this.logger.warn('built-in handler registration failed', { pluginName: name, category });
      return {
        ok: false,
        pluginName: name,
        error: `Handler initialization failed: ${message}`,
        category,
      };
    }

    // 3. Register tools in catalog
    const toolNames: string[] = [];
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
      toolNames.push(tool.name);
    }

    // 4. Mark as loaded and reserved
    this.loadedHandlers.set(name, handler);
    this.loadedManifests.set(name, manifest);
    this.reservedPluginNames.add(name);

    this.logger.info('built-in handler registered', {
      pluginName: name,
      source: 'built-in',
      tools: toolNames,
    });
    return { ok: true, pluginName: name, manifest, handler, source: 'built-in' };
  }

  /**
   * Check whether a plugin name is reserved (registered as a built-in handler).
   * Reserved names cannot be overridden by user plugins discovered from disk.
   */
  isReservedPlugin(name: string): boolean {
    return this.reservedPluginNames.has(name);
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

    this.logger.info('loading plugin', { pluginName, source });

    // 1. Read manifest
    let rawManifest: string;
    try {
      rawManifest = await readFile(join(pluginDir, 'manifest.json'), 'utf-8');
    } catch {
      this.logger.warn('plugin load failed', { pluginName, category: 'invalid_manifest' });
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
      this.logger.warn('plugin load failed', { pluginName, category: 'invalid_manifest' });
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
      this.logger.warn('plugin load failed', { pluginName, category: 'invalid_manifest' });
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
        this.logger.warn('plugin load failed', {
          pluginName,
          category: 'invalid_manifest',
          reason: 'reserved tool name',
        });
        return {
          ok: false,
          pluginName,
          error: `Tool name "${tool.name}" is reserved for core intrinsics`,
          category: 'invalid_manifest',
        };
      }
      if (this.toolCatalog.has(tool.name)) {
        this.logger.warn('plugin load failed', {
          pluginName,
          category: 'invalid_manifest',
          reason: 'tool name collision',
        });
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
      this.logger.warn('plugin load failed', { pluginName, category: 'missing_handler' });
      return {
        ok: false,
        pluginName,
        error: `Failed to import handler: ${message}`,
        category: 'missing_handler',
      };
    }

    // 4b. Validate session policy: explicit requires resolveSession()
    if (manifest.session === 'explicit' && typeof handler.resolveSession !== 'function') {
      this.logger.warn('plugin load failed', {
        pluginName,
        category: 'invalid_manifest',
        reason: 'explicit session policy requires resolveSession()',
      });
      return {
        ok: false,
        pluginName,
        error:
          'Manifest declares session: "explicit" but handler does not implement resolveSession()',
        category: 'invalid_manifest',
      };
    }

    // 5. Initialize with timeout (channel plugins get ChannelServices)
    try {
      await this.initializeWithTimeout(handler, pluginName, manifest);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('timed out');
      const category = isTimeout ? 'timeout' : 'init_error';
      this.logger.warn('plugin load failed', { pluginName, category });
      return {
        ok: false,
        pluginName,
        error: `Handler initialization failed: ${message}`,
        category,
      };
    }

    // 6. Register tools in catalog — bridge envelope to handleToolInvocation
    const toolNames: string[] = [];
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
      toolNames.push(tool.name);
    }

    this.loadedHandlers.set(pluginName, handler);
    this.loadedManifests.set(pluginName, manifest);

    this.logger.info('plugin loaded', { pluginName, source, tools: toolNames });
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
    this.logger.info('discovered plugins', { count: discovered.length });

    const results: PluginLoadResult[] = [];

    for (const plugin of discovered) {
      const result = await this.loadPlugin(plugin.dir, plugin.source);
      results.push(result);
    }

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    this.logger.info('all plugins loaded', { succeeded, failed, total: results.length });

    return results;
  }

  // -------------------------------------------------------------------------
  // Unload / Reload
  // -------------------------------------------------------------------------

  /**
   * Unload a single plugin by name.
   *
   * Shuts down the handler, unregisters its tools from the catalog, and
   * removes it from internal tracking maps. Refuses to unload reserved
   * (built-in) plugins.
   *
   * @returns `true` if the plugin was unloaded, `false` if not found or reserved.
   */
  async unloadPlugin(name: string): Promise<boolean> {
    if (this.reservedPluginNames.has(name)) {
      this.logger.warn('refused to unload reserved plugin', { pluginName: name });
      return false;
    }

    const handler = this.loadedHandlers.get(name);
    if (!handler) {
      this.logger.debug('unload skipped — plugin not loaded', { pluginName: name });
      return false;
    }

    // Shutdown handler
    try {
      await Promise.race([
        handler.shutdown(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('shutdown timed out')), 5_000),
        ),
      ]);
    } catch {
      this.logger.warn('plugin shutdown failed during unload', { pluginName: name });
    }

    // Unregister tools from catalog
    const manifest = this.loadedManifests.get(name);
    if (manifest) {
      for (const tool of manifest.provides.tools) {
        this.toolCatalog.unregister(tool.name);
      }
    }

    this.loadedHandlers.delete(name);
    this.loadedManifests.delete(name);

    this.logger.info('plugin unloaded', { pluginName: name });
    return true;
  }

  /**
   * Reload a single plugin by name.
   *
   * Unloads the plugin (if loaded), then re-discovers it from disk and
   * re-loads it. Returns the load result or a failure if the plugin
   * could not be found on disk.
   */
  async reloadPlugin(name: string): Promise<PluginLoadResult> {
    await this.unloadPlugin(name);

    // Re-discover to find the plugin's directory
    const discovered = await this.discoverPlugins();
    const match = discovered.find((p) => p.name === name);
    if (!match) {
      this.logger.warn('reload failed — plugin not found on disk', { pluginName: name });
      return {
        ok: false,
        pluginName: name,
        error: `Plugin "${name}" not found on disk`,
        category: 'missing_handler',
      };
    }

    return this.loadPlugin(match.dir, match.source);
  }

  /**
   * Reload all non-reserved plugins.
   *
   * Unloads every non-reserved plugin, then calls `loadAll()` to
   * re-discover and load everything from disk.
   */
  async reloadAll(): Promise<PluginLoadResult[]> {
    this.logger.info('reloading all plugins');

    // Unload all non-reserved plugins
    const toUnload = [...this.loadedHandlers.keys()].filter(
      (name) => !this.reservedPluginNames.has(name),
    );
    for (const name of toUnload) {
      await this.unloadPlugin(name);
    }

    // Re-discover and load
    return this.loadAll();
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
    this.logger.info('shutting down all plugins', { count: entries.length });

    await Promise.allSettled(
      entries.map(async ([name, handler]) => {
        try {
          await Promise.race([
            handler.shutdown(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('shutdown timed out')), timeout),
            ),
          ]);
          this.logger.info('plugin shut down', { pluginName: name });
        } catch {
          this.logger.warn('plugin shutdown failed', { pluginName: name });
        }
      }),
    );

    this.loadedHandlers.clear();
    this.loadedManifests.clear();
    this.logger.info('all plugins shut down');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Read a credential file scoped to a specific plugin.
   *
   * Reads from `$CARAPACE_HOME/credentials/plugins/{pluginName}/{key}`.
   * Validates the key to prevent path traversal, then delegates to
   * `readCredentialFile()` which rejects symlinks.
   *
   * @throws If the key contains `/`, `..`, or null bytes.
   * @throws If the credentials directory is not configured.
   * @throws If the credential file does not exist.
   */
  private readPluginCredential(pluginName: string, key: string): string {
    // Validate key — reject path traversal characters
    if (key.includes('/') || key.includes('..') || key.includes('\0')) {
      throw new Error(
        formatErrorMessage({
          component: 'PluginLoader',
          what: `Invalid credential key "${key}" for plugin "${pluginName}"`,
          how: 'Credential keys must be simple filenames without /, .., or null bytes',
        }),
      );
    }

    if (!this.credentialsPluginsDir) {
      throw new Error(
        formatErrorMessage({
          component: 'PluginLoader',
          what: `Cannot read credential "${key}" for plugin "${pluginName}": credentials directory not configured`,
          how: 'Ensure $CARAPACE_HOME/credentials/plugins exists and the server is started with credentialsDir',
        }),
      );
    }

    const filePath = join(this.credentialsPluginsDir, pluginName, key);
    try {
      return readCredentialFile(filePath);
    } catch {
      throw new Error(
        formatErrorMessage({
          component: 'PluginLoader',
          what: `Credential "${key}" not found for plugin "${pluginName}"`,
          how: `Create the file at ${filePath} with the credential value`,
        }),
      );
    }
  }

  /**
   * Try to dynamically import handler.js or handler.ts from the plugin dir.
   * Looks for handler.js first, then handler.ts.
   *
   * Appends a cache-busting query parameter to the import URL so that
   * Node.js ESM module cache does not serve stale code after a reload.
   */
  private async importHandler(pluginDir: string): Promise<PluginHandler> {
    const jsPath = join(pluginDir, 'handler.js');
    const tsPath = join(pluginDir, 'handler.ts');
    const cacheBust = `?t=${Date.now()}`;

    let handlerModule: Record<string, unknown>;

    // Check handler.js first
    let jsExists = false;
    try {
      await access(jsPath);
      jsExists = true;
    } catch {
      // handler.js does not exist
    }

    if (jsExists) {
      try {
        handlerModule = (await import(jsPath + cacheBust)) as Record<string, unknown>;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`handler.js exists but failed to import: ${message}`);
      }
    } else {
      // Fall back to handler.ts
      let tsExists = false;
      try {
        await access(tsPath);
        tsExists = true;
      } catch {
        // handler.ts does not exist
      }

      if (tsExists) {
        try {
          handlerModule = (await import(tsPath + cacheBust)) as Record<string, unknown>;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`handler.ts exists but failed to import: ${message}`);
        }
      } else {
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
   *
   * Channel plugins (those with `provides.channels.length > 0`) receive
   * {@link ChannelServices} with `publishEvent()`. Tool-only plugins
   * receive plain {@link CoreServices}.
   */
  private async initializeWithTimeout(
    handler: PluginHandler,
    pluginName: string,
    manifest: PluginManifest,
  ): Promise<void> {
    const isChannelPlugin = manifest.provides.channels.length > 0;

    const baseServices: CoreServices = {
      getAuditLog: async () => [],
      getToolCatalog: () => this.toolCatalog.list(),
      getSessionInfo: () => ({ group: '', sessionId: '', startedAt: '' }),
      readCredential: (key: string): string => {
        return this.readPluginCredential(pluginName, key);
      },
    };

    let services: CoreServices | ChannelServices;
    if (isChannelPlugin && this.eventBus) {
      const eventBus = this.eventBus;
      services = {
        ...baseServices,
        publishEvent: async (partial: {
          topic: string;
          source: string;
          group: string;
          payload: Record<string, unknown>;
        }) => {
          const { randomUUID } = await import('node:crypto');
          const { PROTOCOL_VERSION } = await import('../types/protocol.js');
          const envelope = {
            id: randomUUID(),
            version: PROTOCOL_VERSION,
            type: 'event' as const,
            topic: partial.topic,
            source: partial.source,
            correlation: null,
            timestamp: new Date().toISOString(),
            group: partial.group,
            payload: partial.payload,
          };
          await eventBus.publish(envelope);
        },
      };
    } else {
      services = baseServices;
    }

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
