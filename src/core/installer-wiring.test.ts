/**
 * Tests for wiring the InstallerHandler as a built-in plugin in PluginLoader.
 *
 * Verifies:
 * - Installer loads on startup and appears as built-in
 * - Its 6 tools appear in the tool catalog
 * - Name "installer" is reserved (can't be overridden by user plugins)
 * - getLoadedHandler works lazily (loads plugin after installer init, verify can find it)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolCatalog } from './tool-catalog.js';
import { PluginLoader } from './plugin-loader.js';
import type { PluginHandler, CoreServices } from './plugin-handler.js';
import type { PluginManifest } from '../types/index.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Mock node:fs/promises (needed by PluginLoader for filesystem-discovered plugins)
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  access: vi.fn(),
}));

import { readdir, readFile, access } from 'node:fs/promises';

const mockReaddir = vi.mocked(readdir);
const mockReadFile = vi.mocked(readFile);
const mockAccess = vi.mocked(access);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the real installer manifest from the source tree. */
function loadInstallerManifest(): PluginManifest {
  const manifestPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'plugins',
    'installer',
    'manifest.json',
  );
  return JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest;
}

/** Create a minimal mock PluginHandler. */
function createMockHandler(overrides?: Partial<PluginHandler>): PluginHandler {
  return {
    initialize: vi.fn(async () => {}),
    handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  };
}

/**
 * Set up mockAccess so that the given paths succeed (resolve) and all
 * others fail (reject with ENOENT).
 */
function allowAccess(paths: string[]): void {
  const pathSet = new Set(paths);
  mockAccess.mockImplementation(async (p) => {
    if (pathSet.has(String(p))) return undefined;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InstallerHandler wiring into PluginLoader', () => {
  describe('registerBuiltinHandler', () => {
    it('registers installer as built-in and appears in loadedHandlers', async () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      const handler = createMockHandler();
      const manifest = loadInstallerManifest();

      const result = await loader.registerBuiltinHandler('installer', handler, manifest);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pluginName).toBe('installer');
        expect(result.source).toBe('built-in');
        expect(result.handler).toBe(handler);
        expect(result.manifest).toEqual(manifest);
      }

      // Handler is retrievable by name
      expect(loader.getHandler('installer')).toBe(handler);
    });

    it('registers all 6 installer tools in the tool catalog', async () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      const handler = createMockHandler();
      const manifest = loadInstallerManifest();

      await loader.registerBuiltinHandler('installer', handler, manifest);

      // The installer manifest declares 6 tools
      const expectedTools = [
        'plugin_install',
        'plugin_verify',
        'plugin_list',
        'plugin_remove',
        'plugin_update',
        'plugin_configure',
      ];

      for (const toolName of expectedTools) {
        expect(catalog.has(toolName)).toBe(true);
      }

      // Verify exactly 6 tools registered (no extras)
      expect(catalog.list()).toHaveLength(expectedTools.length);
    });

    it('calls handler.initialize() with CoreServices', async () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      const handler = createMockHandler();
      const manifest = loadInstallerManifest();

      await loader.registerBuiltinHandler('installer', handler, manifest);

      expect(handler.initialize).toHaveBeenCalledTimes(1);
      const services = (handler.initialize as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as CoreServices;
      expect(typeof services.getAuditLog).toBe('function');
      expect(typeof services.getToolCatalog).toBe('function');
      expect(typeof services.getSessionInfo).toBe('function');
      expect(typeof services.readCredential).toBe('function');
    });

    it('marks the plugin name as reserved', async () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      const handler = createMockHandler();
      const manifest = loadInstallerManifest();

      await loader.registerBuiltinHandler('installer', handler, manifest);

      expect(loader.isReservedPlugin('installer')).toBe(true);
      expect(loader.isReservedPlugin('nonexistent')).toBe(false);
    });

    it('rejects registration if tool name collides with existing catalog entry', async () => {
      const catalog = new ToolCatalog();
      // Pre-register one of the installer's tool names
      catalog.register(
        {
          name: 'plugin_install',
          description: 'Conflict',
          risk_level: 'low',
          arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
        },
        async () => ({}),
      );

      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      const handler = createMockHandler();
      const manifest = loadInstallerManifest();

      const result = await loader.registerBuiltinHandler('installer', handler, manifest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('plugin_install');
        expect(result.error).toContain('already registered');
      }
    });

    it('rejects registration if initialize() throws', async () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      const handler = createMockHandler({
        initialize: vi.fn(async () => {
          throw new Error('Init failed');
        }),
      });
      const manifest = loadInstallerManifest();

      const result = await loader.registerBuiltinHandler('installer', handler, manifest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('init_error');
        expect(result.error).toContain('Init failed');
      }

      // Tools should NOT be registered
      expect(catalog.has('plugin_install')).toBe(false);
    });
  });

  describe('reserved name prevents filesystem override', () => {
    it('discoverPlugins excludes reserved plugin names from user directory', async () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({
        toolCatalog: catalog,
        userPluginsDir: '/plugins',
        builtinPluginsDir: '/builtin',
      });

      // Register installer as built-in
      const handler = createMockHandler();
      const manifest = loadInstallerManifest();
      await loader.registerBuiltinHandler('installer', handler, manifest);

      // Simulate filesystem discovery — both directories contain "installer"
      mockReaddir.mockImplementation(async (dir) => {
        const dirStr = String(dir);
        if (dirStr === '/builtin')
          return ['installer'] as unknown as Awaited<ReturnType<typeof readdir>>;
        if (dirStr === '/plugins')
          return ['installer', 'my-plugin'] as unknown as Awaited<ReturnType<typeof readdir>>;
        throw new Error('ENOENT');
      });
      allowAccess([
        '/builtin/installer/manifest.json',
        '/plugins/installer/manifest.json',
        '/plugins/my-plugin/manifest.json',
      ]);

      const discovered = await loader.discoverPlugins();

      // "installer" should be excluded from discovery because it's reserved
      const names = discovered.map((p) => p.name);
      expect(names).not.toContain('installer');
      expect(names).toContain('my-plugin');
    });

    it('discoverPlugins excludes reserved plugin names from built-in directory', async () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({
        toolCatalog: catalog,
        userPluginsDir: '/plugins',
        builtinPluginsDir: '/builtin',
      });

      // Register installer as built-in handler
      const handler = createMockHandler();
      const manifest = loadInstallerManifest();
      await loader.registerBuiltinHandler('installer', handler, manifest);

      // Built-in directory also has an "installer" directory
      mockReaddir.mockImplementation(async (dir) => {
        const dirStr = String(dir);
        if (dirStr === '/builtin')
          return ['installer'] as unknown as Awaited<ReturnType<typeof readdir>>;
        if (dirStr === '/plugins') return [] as unknown as Awaited<ReturnType<typeof readdir>>;
        throw new Error('ENOENT');
      });
      allowAccess(['/builtin/installer/manifest.json']);

      const discovered = await loader.discoverPlugins();

      // "installer" should not appear — it's reserved
      expect(discovered).toHaveLength(0);
    });
  });

  describe('getLoadedHandler lazy closure', () => {
    it('returns undefined for unknown plugin before any plugins are loaded', () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });

      // Lazy closure using loader.getHandler
      const getLoadedHandler = (name: string) => loader.getHandler(name);

      expect(getLoadedHandler('some-plugin')).toBeUndefined();
    });

    it('returns handler after plugin is dynamically loaded (lazy, not snapshot)', async () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });

      // Create lazy closure BEFORE any plugins are loaded
      const getLoadedHandler = (name: string) => loader.getHandler(name);

      // At this point, no plugins are loaded
      expect(getLoadedHandler('installer')).toBeUndefined();

      // Now register the installer as built-in
      const handler = createMockHandler();
      const manifest = loadInstallerManifest();
      await loader.registerBuiltinHandler('installer', handler, manifest);

      // The SAME lazy closure now finds the handler — proof it's lazy, not a snapshot
      expect(getLoadedHandler('installer')).toBe(handler);
    });

    it('reflects plugins loaded after installer initialization', async () => {
      // This simulates the real scenario: installer is registered first,
      // then filesystem plugins are loaded via loadAll, and getLoadedHandler
      // (used by plugin_verify) can find them.

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });

      // Lazy closure — same pattern as production wiring
      const getLoadedHandler = (name: string) => loader.getHandler(name);

      // Register installer first
      const installerHandler = createMockHandler();
      const installerManifest = loadInstallerManifest();
      await loader.registerBuiltinHandler('installer', installerHandler, installerManifest);

      // At this point, only installer is loaded
      expect(getLoadedHandler('installer')).toBe(installerHandler);
      expect(getLoadedHandler('some-user-plugin')).toBeUndefined();

      // Simulate loading a user plugin (manually add to loadedHandlers via loadPlugin)
      // We need to mock the filesystem for this
      const userManifest: PluginManifest = {
        description: 'A user plugin',
        version: '1.0.0',
        app_compat: '>=0.1.0',
        author: { name: 'User' },
        provides: {
          channels: [],
          tools: [
            {
              name: 'user_tool',
              description: 'A user tool',
              risk_level: 'low',
              arguments_schema: {
                type: 'object',
                additionalProperties: false,
                properties: { input: { type: 'string' } },
              },
            },
          ],
        },
        subscribes: [],
      };
      const userHandler = createMockHandler();

      // Register it as another built-in (simulates a post-init load)
      await loader.registerBuiltinHandler('some-user-plugin', userHandler, userManifest);

      // Lazy closure now finds both — proving it's not a snapshot
      expect(getLoadedHandler('installer')).toBe(installerHandler);
      expect(getLoadedHandler('some-user-plugin')).toBe(userHandler);
    });
  });

  describe('tool catalog delegation', () => {
    it('routes tool invocations through the registered handler', async () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });

      const handler = createMockHandler({
        handleToolInvocation: vi.fn(async () => ({
          ok: true as const,
          result: { installed: true },
        })),
      });
      const manifest = loadInstallerManifest();

      await loader.registerBuiltinHandler('installer', handler, manifest);

      // Get the catalog entry for plugin_install and invoke it
      const entry = catalog.get('plugin_install');
      expect(entry).toBeDefined();

      const result = await entry!.handler({
        id: 'req-1',
        version: 1,
        type: 'request',
        topic: 'tool.invoke.plugin_install',
        source: 'agent-test',
        correlation: 'corr-1',
        timestamp: new Date().toISOString(),
        group: 'default',
        payload: { arguments: { url: 'https://github.com/user/repo.git' } },
      });

      expect(handler.handleToolInvocation).toHaveBeenCalledWith(
        'plugin_install',
        { url: 'https://github.com/user/repo.git' },
        expect.objectContaining({
          group: 'default',
          sessionId: 'agent-test',
          correlationId: 'corr-1',
        }),
      );
      expect(result).toEqual({ installed: true });
    });
  });
});
