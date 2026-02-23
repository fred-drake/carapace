import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolCatalog } from './tool-catalog.js';
import { PluginLoader } from './plugin-loader.js';
import type { PluginHandler } from './plugin-handler.js';
import { createManifest, createToolDeclaration } from '../testing/factories.js';
import { configureLogging, resetLogging, type LogEntry, type LogSink } from './logger.js';

// ---------------------------------------------------------------------------
// Mock node:fs/promises
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

/**
 * Create a minimal mock PluginHandler. All methods are vi.fn() by default.
 */
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

/**
 * Set up the dynamic import mock for a given plugin directory.
 * Patches the global import to intercept the handler path.
 */
let importMocks: Map<string, () => Promise<Record<string, unknown>>>;

vi.mock('/plugins/alpha/handler.js', () => importMocks.get('/plugins/alpha/handler.js')!());
vi.mock('/plugins/beta/handler.js', () => importMocks.get('/plugins/beta/handler.js')!());
vi.mock('/plugins/gamma/handler.js', () => importMocks.get('/plugins/gamma/handler.js')!());
vi.mock('/plugins/timeout-plugin/handler.js', () =>
  importMocks.get('/plugins/timeout-plugin/handler.js')!(),
);
vi.mock('/plugins/bad-handler/handler.js', () =>
  importMocks.get('/plugins/bad-handler/handler.js')!(),
);
vi.mock('/plugins/init-fail/handler.js', () => importMocks.get('/plugins/init-fail/handler.js')!());
vi.mock('/plugins/reserved/handler.js', () => importMocks.get('/plugins/reserved/handler.js')!());
vi.mock('/plugins/collision/handler.js', () => importMocks.get('/plugins/collision/handler.js')!());
vi.mock('/plugins/shutdown-hang/handler.js', () =>
  importMocks.get('/plugins/shutdown-hang/handler.js')!(),
);
vi.mock('/plugins/accessor-test/handler.js', () =>
  importMocks.get('/plugins/accessor-test/handler.js')!(),
);
vi.mock('/plugins/accessor-all/handler.js', () =>
  importMocks.get('/plugins/accessor-all/handler.js')!(),
);
// Channel services injection mocks
vi.mock('/plugins/channel-plugin/handler.js', () =>
  importMocks.get('/plugins/channel-plugin/handler.js')!(),
);
vi.mock('/plugins/tool-only-plugin/handler.js', () =>
  importMocks.get('/plugins/tool-only-plugin/handler.js')!(),
);
// Built-in plugin handler mocks
vi.mock('/builtin/alpha/handler.js', () => importMocks.get('/builtin/alpha/handler.js')!());
vi.mock('/builtin/beta/handler.js', () => importMocks.get('/builtin/beta/handler.js')!());
// Unload / reload handler mocks
vi.mock('/plugins/unload-test/handler.js', () =>
  importMocks.get('/plugins/unload-test/handler.js')!(),
);
vi.mock('/plugins/unload-fail/handler.js', () =>
  importMocks.get('/plugins/unload-fail/handler.js')!(),
);
vi.mock('/plugins/reload-test/handler.js', () =>
  importMocks.get('/plugins/reload-test/handler.js')!(),
);
vi.mock('/plugins/reload-vanish/handler.js', () =>
  importMocks.get('/plugins/reload-vanish/handler.js')!(),
);
vi.mock('/plugins/reload-all-test/handler.js', () =>
  importMocks.get('/plugins/reload-all-test/handler.js')!(),
);

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  importMocks = new Map();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PluginLoader', () => {
  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  describe('discoverPlugins', () => {
    it('finds plugin directories with manifest.json', async () => {
      mockReaddir.mockResolvedValue(['alpha', 'beta'] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);
      allowAccess(['/plugins/alpha/manifest.json', '/plugins/beta/manifest.json']);

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      const discovered = await loader.discoverPlugins();

      expect(discovered).toEqual([
        { name: 'alpha', dir: '/plugins/alpha', source: 'user' },
        { name: 'beta', dir: '/plugins/beta', source: 'user' },
      ]);
    });

    it('ignores directories without manifest.json', async () => {
      mockReaddir.mockResolvedValue(['alpha', 'no-manifest'] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);
      allowAccess(['/plugins/alpha/manifest.json']);

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      const discovered = await loader.discoverPlugins();

      expect(discovered).toEqual([{ name: 'alpha', dir: '/plugins/alpha', source: 'user' }]);
    });

    it('handles empty plugins directory', async () => {
      mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof readdir>>);

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      const discovered = await loader.discoverPlugins();

      expect(discovered).toEqual([]);
    });

    it('returns empty array when plugins directory does not exist', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/missing',
      });
      const discovered = await loader.discoverPlugins();

      expect(discovered).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Valid manifest loading
  // -----------------------------------------------------------------------

  describe('loadPlugin with valid manifest', () => {
    it('loads a plugin and registers tools in catalog', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'alpha_tool' })],
        },
      });
      const handler = createMockHandler();

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/alpha/manifest.json', '/plugins/alpha/handler.js']);
      importMocks.set('/plugins/alpha/handler.js', () => Promise.resolve({ default: handler }));

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });

      const result = await loader.loadPlugin('/plugins/alpha');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pluginName).toBe('alpha');
        expect(result.manifest).toEqual(manifest);
        expect(result.handler).toBe(handler);
        expect(result.source).toBe('user');
      }
      expect(catalog.has('alpha_tool')).toBe(true);
    });

    it('tags plugin with specified source', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'alpha_builtin_tool' })],
        },
      });
      const handler = createMockHandler();

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/builtin/alpha/manifest.json', '/builtin/alpha/handler.js']);
      importMocks.set('/builtin/alpha/handler.js', () => Promise.resolve({ default: handler }));

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({
        toolCatalog: catalog,
        userPluginsDir: '/plugins',
        builtinPluginsDir: '/builtin',
      });

      const result = await loader.loadPlugin('/builtin/alpha', 'built-in');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source).toBe('built-in');
      }
    });

    it('calls handler.initialize() with CoreServices', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'beta_tool' })],
        },
      });
      const handler = createMockHandler();

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/beta/manifest.json', '/plugins/beta/handler.js']);
      importMocks.set('/plugins/beta/handler.js', () => Promise.resolve({ default: handler }));

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      await loader.loadPlugin('/plugins/beta');

      expect(handler.initialize).toHaveBeenCalledTimes(1);
      expect(handler.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          getAuditLog: expect.any(Function),
          getToolCatalog: expect.any(Function),
          getSessionInfo: expect.any(Function),
          readCredential: expect.any(Function),
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Invalid manifest
  // -----------------------------------------------------------------------

  describe('loadPlugin with invalid manifest', () => {
    it('rejects with category invalid_manifest for malformed JSON', async () => {
      mockReadFile.mockResolvedValue('{ not valid json }}}');

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      const result = await loader.loadPlugin('/plugins/alpha');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid_manifest');
        expect(result.pluginName).toBe('alpha');
        expect(result.error).toContain('not valid JSON');
      }
    });

    it('rejects with category invalid_manifest when schema validation fails', async () => {
      // Missing required fields
      mockReadFile.mockResolvedValue(JSON.stringify({ description: 'incomplete' }));

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      const result = await loader.loadPlugin('/plugins/alpha');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid_manifest');
        expect(result.error).toContain('Invalid manifest');
      }
    });

    it('rejects when manifest.json cannot be read', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      const result = await loader.loadPlugin('/plugins/alpha');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid_manifest');
        expect(result.error).toContain('Could not read manifest.json');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Tool name collision
  // -----------------------------------------------------------------------

  describe('tool name collision', () => {
    it('rejects a plugin whose tool name collides with an existing catalog entry', async () => {
      const catalog = new ToolCatalog();
      const existingTool = createToolDeclaration({ name: 'shared_tool' });
      catalog.register(existingTool, async () => ({}));

      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'shared_tool' })],
        },
      });
      mockReadFile.mockResolvedValue(JSON.stringify(manifest));

      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      const result = await loader.loadPlugin('/plugins/collision');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid_manifest');
        expect(result.error).toContain('already registered');
        expect(result.error).toContain('shared_tool');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Reserved intrinsic names
  // -----------------------------------------------------------------------

  describe('reserved intrinsic names', () => {
    it.each(['get_diagnostics', 'list_tools', 'get_session_info'])(
      'rejects a plugin with reserved tool name "%s"',
      async (reservedName) => {
        const manifest = createManifest({
          provides: {
            channels: [],
            tools: [createToolDeclaration({ name: reservedName })],
          },
        });
        mockReadFile.mockResolvedValue(JSON.stringify(manifest));

        const loader = new PluginLoader({
          toolCatalog: new ToolCatalog(),
          userPluginsDir: '/plugins',
        });
        const result = await loader.loadPlugin('/plugins/reserved');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.category).toBe('invalid_manifest');
          expect(result.error).toContain('reserved');
          expect(result.error).toContain(reservedName);
        }
      },
    );
  });

  // -----------------------------------------------------------------------
  // Missing handler
  // -----------------------------------------------------------------------

  describe('missing handler', () => {
    it('produces category missing_handler when handler.js/.ts is missing', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'orphan_tool' })],
        },
      });
      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      // access rejects for both handler.js and handler.ts
      allowAccess([]);

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      const result = await loader.loadPlugin('/plugins/alpha');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('missing_handler');
        expect(result.error).toContain('handler');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Init failure
  // -----------------------------------------------------------------------

  describe('handler initialization failure', () => {
    it('produces category init_error when initialize() throws', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'fail_tool' })],
        },
      });
      const handler = createMockHandler({
        initialize: vi.fn(async () => {
          throw new Error('DB connection refused');
        }),
      });

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/init-fail/handler.js']);
      importMocks.set('/plugins/init-fail/handler.js', () => Promise.resolve({ default: handler }));

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      const result = await loader.loadPlugin('/plugins/init-fail');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('init_error');
        expect(result.error).toContain('DB connection refused');
      }
      // Tool should NOT be registered in the catalog
      expect(catalog.has('fail_tool')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Init timeout
  // -----------------------------------------------------------------------

  describe('handler initialization timeout', () => {
    it('produces category timeout when initialize() hangs', async () => {
      // Use real timers for this test — fake timers cannot advance through
      // the chain of async steps (readFile, import, etc.) that precede setTimeout.
      vi.useRealTimers();

      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'hang_tool' })],
        },
      });
      const handler = createMockHandler({
        initialize: vi.fn(
          () => new Promise<void>(() => {}), // never resolves
        ),
      });

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/timeout-plugin/handler.js']);
      importMocks.set('/plugins/timeout-plugin/handler.js', () =>
        Promise.resolve({ default: handler }),
      );

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({
        toolCatalog: catalog,
        userPluginsDir: '/plugins',
        initTimeoutMs: 50, // very short timeout with real timers
      });

      const result = await loader.loadPlugin('/plugins/timeout-plugin');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('timeout');
        expect(result.error).toContain('timed out');
      }
      expect(catalog.has('hang_tool')).toBe(false);

      // Restore fake timers for remaining tests
      vi.useFakeTimers();
    });
  });

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  describe('shutdownAll', () => {
    it('calls shutdown() on all loaded handlers', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'gamma_tool' })],
        },
      });
      const handler = createMockHandler();

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/gamma/handler.js']);
      importMocks.set('/plugins/gamma/handler.js', () => Promise.resolve({ default: handler }));

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      await loader.loadPlugin('/plugins/gamma');

      await loader.shutdownAll();

      expect(handler.shutdown).toHaveBeenCalledTimes(1);
    });

    it('force-terminates handlers that hang on shutdown', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'hang_shutdown_tool' })],
        },
      });
      const handler = createMockHandler({
        shutdown: vi.fn(() => new Promise<void>(() => {})), // never resolves
      });

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/shutdown-hang/handler.js']);
      importMocks.set('/plugins/shutdown-hang/handler.js', () =>
        Promise.resolve({ default: handler }),
      );

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      await loader.loadPlugin('/plugins/shutdown-hang');

      // shutdownAll with short timeout — should not hang forever
      const shutdownPromise = loader.shutdownAll(100);
      vi.advanceTimersByTime(200);
      await shutdownPromise;

      // Reached here without hanging — shutdown was force-terminated
      expect(handler.shutdown).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // loadAll
  // -----------------------------------------------------------------------

  describe('loadAll', () => {
    it('loads all valid plugins and records failures', async () => {
      mockReaddir.mockResolvedValue(['alpha', 'bad-handler'] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);

      // alpha has manifest.json and handler.js
      // bad-handler has manifest.json but no handler
      allowAccess([
        '/plugins/alpha/manifest.json',
        '/plugins/bad-handler/manifest.json',
        '/plugins/alpha/handler.js',
      ]);

      const alphaManifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'alpha_tool' })],
        },
      });
      const badManifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'bad_tool' })],
        },
      });
      const alphaHandler = createMockHandler();

      mockReadFile.mockImplementation(async (path) => {
        const pathStr = String(path);
        if (pathStr.includes('alpha')) return JSON.stringify(alphaManifest);
        if (pathStr.includes('bad-handler')) return JSON.stringify(badManifest);
        throw new Error('ENOENT');
      });

      importMocks.set('/plugins/alpha/handler.js', () =>
        Promise.resolve({ default: alphaHandler }),
      );
      importMocks.set('/plugins/bad-handler/handler.js', () => {
        throw new Error('Cannot find module');
      });

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      const results = await loader.loadAll();

      expect(results).toHaveLength(2);

      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      expect(successes[0]!.pluginName).toBe('alpha');
      if (successes[0]!.ok) {
        expect(successes[0]!.source).toBe('user');
      }
      expect(failures[0]!.pluginName).toBe('bad-handler');

      // Only the successful plugin's tool should be in the catalog
      expect(catalog.has('alpha_tool')).toBe(true);
      expect(catalog.has('bad_tool')).toBe(false);
    });

    it('returns empty array when no plugins are found', async () => {
      mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof readdir>>);

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      const results = await loader.loadAll();

      expect(results).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Dual-directory scanning
  // -----------------------------------------------------------------------

  describe('dual-directory scanning', () => {
    it('discovers plugins from both built-in and user directories', async () => {
      mockReaddir.mockImplementation(async (dir) => {
        const dirStr = String(dir);
        if (dirStr === '/builtin')
          return ['alpha'] as unknown as Awaited<ReturnType<typeof readdir>>;
        if (dirStr === '/plugins')
          return ['beta'] as unknown as Awaited<ReturnType<typeof readdir>>;
        throw new Error('ENOENT');
      });
      allowAccess(['/builtin/alpha/manifest.json', '/plugins/beta/manifest.json']);

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
        builtinPluginsDir: '/builtin',
      });
      const discovered = await loader.discoverPlugins();

      expect(discovered).toEqual([
        { name: 'alpha', dir: '/builtin/alpha', source: 'built-in' },
        { name: 'beta', dir: '/plugins/beta', source: 'user' },
      ]);
    });

    it('user plugin overrides built-in plugin of same name', async () => {
      mockReaddir.mockImplementation(async (dir) => {
        const dirStr = String(dir);
        if (dirStr === '/builtin')
          return ['alpha'] as unknown as Awaited<ReturnType<typeof readdir>>;
        if (dirStr === '/plugins')
          return ['alpha'] as unknown as Awaited<ReturnType<typeof readdir>>;
        throw new Error('ENOENT');
      });
      allowAccess(['/builtin/alpha/manifest.json', '/plugins/alpha/manifest.json']);

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
        builtinPluginsDir: '/builtin',
      });
      const discovered = await loader.discoverPlugins();

      // Only user version should remain
      expect(discovered).toHaveLength(1);
      expect(discovered[0]).toEqual({
        name: 'alpha',
        dir: '/plugins/alpha',
        source: 'user',
      });
    });

    it('works when built-in directory does not exist', async () => {
      mockReaddir.mockImplementation(async (dir) => {
        const dirStr = String(dir);
        if (dirStr === '/builtin') throw new Error('ENOENT');
        if (dirStr === '/plugins')
          return ['alpha'] as unknown as Awaited<ReturnType<typeof readdir>>;
        throw new Error('ENOENT');
      });
      allowAccess(['/plugins/alpha/manifest.json']);

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
        builtinPluginsDir: '/builtin',
      });
      const discovered = await loader.discoverPlugins();

      expect(discovered).toEqual([{ name: 'alpha', dir: '/plugins/alpha', source: 'user' }]);
    });

    it('works when no builtinPluginsDir is provided', async () => {
      mockReaddir.mockResolvedValue(['alpha'] as unknown as Awaited<ReturnType<typeof readdir>>);
      allowAccess(['/plugins/alpha/manifest.json']);

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      const discovered = await loader.discoverPlugins();

      expect(discovered).toEqual([{ name: 'alpha', dir: '/plugins/alpha', source: 'user' }]);
    });

    it('loadAll loads from both directories with correct sources', async () => {
      mockReaddir.mockImplementation(async (dir) => {
        const dirStr = String(dir);
        if (dirStr === '/builtin')
          return ['beta'] as unknown as Awaited<ReturnType<typeof readdir>>;
        if (dirStr === '/plugins')
          return ['alpha'] as unknown as Awaited<ReturnType<typeof readdir>>;
        throw new Error('ENOENT');
      });

      const alphaManifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'alpha_tool' })],
        },
      });
      const betaManifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'beta_builtin_tool' })],
        },
      });
      const alphaHandler = createMockHandler();
      const betaHandler = createMockHandler();

      allowAccess([
        '/plugins/alpha/manifest.json',
        '/plugins/alpha/handler.js',
        '/builtin/beta/manifest.json',
        '/builtin/beta/handler.js',
      ]);

      mockReadFile.mockImplementation(async (path) => {
        const pathStr = String(path);
        if (pathStr.includes('/plugins/alpha')) return JSON.stringify(alphaManifest);
        if (pathStr.includes('/builtin/beta')) return JSON.stringify(betaManifest);
        throw new Error('ENOENT');
      });

      importMocks.set('/plugins/alpha/handler.js', () =>
        Promise.resolve({ default: alphaHandler }),
      );
      importMocks.set('/builtin/beta/handler.js', () => Promise.resolve({ default: betaHandler }));

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({
        toolCatalog: catalog,
        userPluginsDir: '/plugins',
        builtinPluginsDir: '/builtin',
      });
      const results = await loader.loadAll();

      expect(results).toHaveLength(2);
      const successes = results.filter((r) => r.ok);
      expect(successes).toHaveLength(2);

      // Sorted by name: alpha (user) then beta (built-in)
      expect(successes[0]!.pluginName).toBe('alpha');
      if (successes[0]!.ok) expect(successes[0]!.source).toBe('user');
      expect(successes[1]!.pluginName).toBe('beta');
      if (successes[1]!.ok) expect(successes[1]!.source).toBe('built-in');

      expect(catalog.has('alpha_tool')).toBe(true);
      expect(catalog.has('beta_builtin_tool')).toBe(true);
    });

    it('loadAll with user override only loads user version', async () => {
      mockReaddir.mockImplementation(async (dir) => {
        const dirStr = String(dir);
        if (dirStr === '/builtin')
          return ['alpha'] as unknown as Awaited<ReturnType<typeof readdir>>;
        if (dirStr === '/plugins')
          return ['alpha'] as unknown as Awaited<ReturnType<typeof readdir>>;
        throw new Error('ENOENT');
      });

      const userManifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'alpha_user_tool' })],
        },
      });
      const userHandler = createMockHandler();

      allowAccess([
        '/builtin/alpha/manifest.json',
        '/plugins/alpha/manifest.json',
        '/plugins/alpha/handler.js',
      ]);

      mockReadFile.mockImplementation(async (path) => {
        const pathStr = String(path);
        if (pathStr.includes('/plugins/alpha')) return JSON.stringify(userManifest);
        throw new Error('ENOENT');
      });

      importMocks.set('/plugins/alpha/handler.js', () => Promise.resolve({ default: userHandler }));

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({
        toolCatalog: catalog,
        userPluginsDir: '/plugins',
        builtinPluginsDir: '/builtin',
      });
      const results = await loader.loadAll();

      // Only user version loaded
      expect(results).toHaveLength(1);
      expect(results[0]!.ok).toBe(true);
      if (results[0]!.ok) {
        expect(results[0]!.pluginName).toBe('alpha');
        expect(results[0]!.source).toBe('user');
      }
      expect(catalog.has('alpha_user_tool')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // ChannelServices injection for channel plugins
  // -----------------------------------------------------------------------

  describe('ChannelServices injection', () => {
    it('passes ChannelServices to plugins that declare provides.channels', async () => {
      const manifest = createManifest({
        provides: {
          channels: ['test-input'],
          tools: [createToolDeclaration({ name: 'channel_tool' })],
        },
      });
      const handler = createMockHandler();
      const mockEventBus = {
        publish: vi.fn(async () => {}),
      } as unknown as import('./event-bus.js').EventBus;

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/channel-plugin/manifest.json', '/plugins/channel-plugin/handler.js']);
      importMocks.set('/plugins/channel-plugin/handler.js', () =>
        Promise.resolve({ default: handler }),
      );

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
        eventBus: mockEventBus,
      });
      const result = await loader.loadPlugin('/plugins/channel-plugin');

      expect(result.ok).toBe(true);
      expect(handler.initialize).toHaveBeenCalledTimes(1);
      const services = (handler.initialize as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(typeof services.publishEvent).toBe('function');
    });

    it('passes CoreServices (without publishEvent) to tool-only plugins', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'tool_only' })],
        },
      });
      const handler = createMockHandler();
      const mockEventBus = {
        publish: vi.fn(async () => {}),
      } as unknown as import('./event-bus.js').EventBus;

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess([
        '/plugins/tool-only-plugin/manifest.json',
        '/plugins/tool-only-plugin/handler.js',
      ]);
      importMocks.set('/plugins/tool-only-plugin/handler.js', () =>
        Promise.resolve({ default: handler }),
      );

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
        eventBus: mockEventBus,
      });
      await loader.loadPlugin('/plugins/tool-only-plugin');

      expect(handler.initialize).toHaveBeenCalledTimes(1);
      const services = (handler.initialize as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(services.publishEvent).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getHandler accessor
  // -----------------------------------------------------------------------

  describe('getHandler', () => {
    it('returns the handler instance after loadPlugin()', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'accessor_test_tool' })],
        },
      });
      const handler = createMockHandler();

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/accessor-test/manifest.json', '/plugins/accessor-test/handler.js']);
      importMocks.set('/plugins/accessor-test/handler.js', () =>
        Promise.resolve({ default: handler }),
      );

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      await loader.loadPlugin('/plugins/accessor-test');

      expect(loader.getHandler('accessor-test')).toBe(handler);
    });

    it('returns undefined for unknown plugin name', () => {
      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });

      expect(loader.getHandler('unknown')).toBeUndefined();
    });

    it('returns correct handler after loadAll()', async () => {
      mockReaddir.mockResolvedValue(['accessor-all'] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);

      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'accessor_all_tool' })],
        },
      });
      const handler = createMockHandler();

      allowAccess(['/plugins/accessor-all/manifest.json', '/plugins/accessor-all/handler.js']);
      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      importMocks.set('/plugins/accessor-all/handler.js', () =>
        Promise.resolve({ default: handler }),
      );

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      await loader.loadAll();

      expect(loader.getHandler('accessor-all')).toBe(handler);
    });
  });

  // -----------------------------------------------------------------------
  // Logging
  // -----------------------------------------------------------------------

  describe('logging', () => {
    let logEntries: LogEntry[];

    beforeEach(() => {
      logEntries = [];
      const logSink: LogSink = (entry) => logEntries.push(entry);
      configureLogging({ level: 'debug', sink: logSink });
    });

    afterEach(() => {
      resetLogging();
    });

    it('logs loading plugin on loadPlugin start', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'log_start_tool' })],
        },
      });
      const handler = createMockHandler();

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/alpha/manifest.json', '/plugins/alpha/handler.js']);
      importMocks.set('/plugins/alpha/handler.js', () => Promise.resolve({ default: handler }));

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      await loader.loadPlugin('/plugins/alpha');

      const loadLog = logEntries.find((e) => e.msg === 'loading plugin');
      expect(loadLog).toBeDefined();
      expect(loadLog!.meta?.pluginName).toBe('alpha');
    });

    it('logs plugin loaded on successful load', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'log_success_tool' })],
        },
      });
      const handler = createMockHandler();

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/alpha/manifest.json', '/plugins/alpha/handler.js']);
      importMocks.set('/plugins/alpha/handler.js', () => Promise.resolve({ default: handler }));

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      await loader.loadPlugin('/plugins/alpha');

      const loadedLog = logEntries.find((e) => e.msg === 'plugin loaded');
      expect(loadedLog).toBeDefined();
      expect(loadedLog!.meta?.pluginName).toBe('alpha');
      expect(loadedLog!.meta?.tools).toEqual(['log_success_tool']);
    });

    it('logs plugin load failed on invalid manifest', async () => {
      mockReadFile.mockResolvedValue('{ invalid }}}');

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      await loader.loadPlugin('/plugins/alpha');

      const failLog = logEntries.find((e) => e.msg === 'plugin load failed');
      expect(failLog).toBeDefined();
      expect(failLog!.level).toBe('warn');
      expect(failLog!.meta?.pluginName).toBe('alpha');
      expect(failLog!.meta?.category).toBe('invalid_manifest');
    });

    it('logs discovered plugins count in loadAll', async () => {
      mockReaddir.mockResolvedValue(['alpha'] as unknown as Awaited<ReturnType<typeof readdir>>);
      allowAccess(['/plugins/alpha/manifest.json', '/plugins/alpha/handler.js']);

      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'loadall_tool' })],
        },
      });
      const handler = createMockHandler();
      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      importMocks.set('/plugins/alpha/handler.js', () => Promise.resolve({ default: handler }));

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      await loader.loadAll();

      const discoverLog = logEntries.find((e) => e.msg === 'discovered plugins');
      expect(discoverLog).toBeDefined();
      expect(discoverLog!.meta?.count).toBe(1);

      const allLog = logEntries.find((e) => e.msg === 'all plugins loaded');
      expect(allLog).toBeDefined();
      expect(allLog!.meta?.succeeded).toBe(1);
      expect(allLog!.meta?.failed).toBe(0);
    });

    it('logs shutting down all plugins on shutdownAll', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'shutdown_log_tool' })],
        },
      });
      const handler = createMockHandler();

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/gamma/manifest.json', '/plugins/gamma/handler.js']);
      importMocks.set('/plugins/gamma/handler.js', () => Promise.resolve({ default: handler }));

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      await loader.loadPlugin('/plugins/gamma');

      await loader.shutdownAll();

      const shutdownLog = logEntries.find((e) => e.msg === 'shutting down all plugins');
      expect(shutdownLog).toBeDefined();
      expect(shutdownLog!.meta?.count).toBe(1);

      const doneLog = logEntries.find((e) => e.msg === 'all plugins shut down');
      expect(doneLog).toBeDefined();
    });

    it('uses plugin-loader component name', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });
      await loader.loadPlugin('/plugins/alpha');

      const log = logEntries.find((e) => e.msg === 'loading plugin');
      expect(log).toBeDefined();
      expect(log!.component).toBe('plugin-loader');
    });
  });

  // -----------------------------------------------------------------------
  // unloadPlugin
  // -----------------------------------------------------------------------

  describe('unloadPlugin', () => {
    it('unloads a loaded plugin and removes its tools from catalog', async () => {
      vi.useRealTimers();

      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'unload_tool' })],
        },
      });
      const handler = createMockHandler();

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/unload-test/manifest.json', '/plugins/unload-test/handler.js']);
      importMocks.set('/plugins/unload-test/handler.js', () =>
        Promise.resolve({ default: handler }),
      );

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      const loadResult = await loader.loadPlugin('/plugins/unload-test');

      expect(loadResult.ok).toBe(true);
      expect(catalog.has('unload_tool')).toBe(true);

      const result = await loader.unloadPlugin('unload-test');

      expect(result).toBe(true);
      expect(handler.shutdown).toHaveBeenCalledTimes(1);
      expect(catalog.has('unload_tool')).toBe(false);
      expect(loader.getHandler('unload-test')).toBeUndefined();

      vi.useFakeTimers();
    });

    it('returns false for a plugin that is not loaded', async () => {
      const loader = new PluginLoader({
        toolCatalog: new ToolCatalog(),
        userPluginsDir: '/plugins',
      });

      const result = await loader.unloadPlugin('nonexistent');
      expect(result).toBe(false);
    });

    it('refuses to unload reserved plugins', async () => {
      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'builtin_tool' })],
        },
      });
      const handler = createMockHandler();

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      await loader.registerBuiltinHandler('reserved-plugin', handler, manifest);

      const result = await loader.unloadPlugin('reserved-plugin');

      expect(result).toBe(false);
      expect(catalog.has('builtin_tool')).toBe(true);
      expect(loader.getHandler('reserved-plugin')).toBe(handler);
    });

    it('handles handler shutdown failure gracefully', async () => {
      vi.useRealTimers();

      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'fail_shutdown_tool' })],
        },
      });
      const handler = createMockHandler({
        shutdown: vi.fn(async () => {
          throw new Error('shutdown exploded');
        }),
      });

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/unload-fail/manifest.json', '/plugins/unload-fail/handler.js']);
      importMocks.set('/plugins/unload-fail/handler.js', () =>
        Promise.resolve({ default: handler }),
      );

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      await loader.loadPlugin('/plugins/unload-fail');

      const result = await loader.unloadPlugin('unload-fail');

      expect(result).toBe(true);
      expect(catalog.has('fail_shutdown_tool')).toBe(false);

      vi.useFakeTimers();
    });
  });

  // -----------------------------------------------------------------------
  // reloadPlugin
  // -----------------------------------------------------------------------

  describe('reloadPlugin', () => {
    it('unloads and re-loads a plugin from disk', async () => {
      vi.useRealTimers();

      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'reload_tool' })],
        },
      });
      const handler = createMockHandler();

      mockReaddir.mockResolvedValue(['reload-test'] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);
      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/reload-test/manifest.json', '/plugins/reload-test/handler.js']);
      importMocks.set('/plugins/reload-test/handler.js', () =>
        Promise.resolve({ default: handler }),
      );

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      await loader.loadPlugin('/plugins/reload-test');

      const result = await loader.reloadPlugin('reload-test');

      expect(result.ok).toBe(true);
      expect(result.pluginName).toBe('reload-test');
      expect(catalog.has('reload_tool')).toBe(true);

      vi.useFakeTimers();
    });

    it('returns failure when plugin is not found on disk', async () => {
      vi.useRealTimers();

      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'vanish_tool' })],
        },
      });
      const handler = createMockHandler();

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess(['/plugins/reload-vanish/manifest.json', '/plugins/reload-vanish/handler.js']);
      importMocks.set('/plugins/reload-vanish/handler.js', () =>
        Promise.resolve({ default: handler }),
      );

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      await loader.loadPlugin('/plugins/reload-vanish');

      // Now readdir returns empty — plugin no longer on disk
      mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof readdir>>);

      const result = await loader.reloadPlugin('reload-vanish');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not found on disk');
      }

      vi.useFakeTimers();
    });
  });

  // -----------------------------------------------------------------------
  // reloadAll
  // -----------------------------------------------------------------------

  describe('reloadAll', () => {
    it('unloads non-reserved plugins and re-loads from disk', async () => {
      vi.useRealTimers();

      const manifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'reload_all_tool' })],
        },
      });
      const handler = createMockHandler();

      mockReaddir.mockResolvedValue(['reload-all-test'] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);
      mockReadFile.mockResolvedValue(JSON.stringify(manifest));
      allowAccess([
        '/plugins/reload-all-test/manifest.json',
        '/plugins/reload-all-test/handler.js',
      ]);
      importMocks.set('/plugins/reload-all-test/handler.js', () =>
        Promise.resolve({ default: handler }),
      );

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      await loader.loadAll();

      const results = await loader.reloadAll();

      expect(results).toHaveLength(1);
      expect(results[0]!.ok).toBe(true);
      expect(catalog.has('reload_all_tool')).toBe(true);

      vi.useFakeTimers();
    });

    it('preserves reserved plugins during reload', async () => {
      vi.useRealTimers();

      const builtinManifest = createManifest({
        provides: {
          channels: [],
          tools: [createToolDeclaration({ name: 'builtin_preserved' })],
        },
      });
      const builtinHandler = createMockHandler();

      const catalog = new ToolCatalog();
      const loader = new PluginLoader({ toolCatalog: catalog, userPluginsDir: '/plugins' });
      await loader.registerBuiltinHandler('my-builtin', builtinHandler, builtinManifest);

      // No user plugins on disk
      mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof readdir>>);

      const results = await loader.reloadAll();

      expect(results).toHaveLength(0); // No user plugins discovered
      expect(catalog.has('builtin_preserved')).toBe(true); // Built-in still there
      expect(loader.getHandler('my-builtin')).toBe(builtinHandler);

      vi.useFakeTimers();
    });
  });
});
