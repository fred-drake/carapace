import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolCatalog } from './tool-catalog.js';
import { PluginLoader } from './plugin-loader.js';
import type { PluginHandler } from './plugin-handler.js';
import { createManifest, createToolDeclaration } from '../testing/factories.js';

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
    handleRequest: vi.fn(async () => ({ ok: true })),
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

      const loader = new PluginLoader({ toolCatalog: new ToolCatalog(), pluginsDir: '/plugins' });
      const dirs = await loader.discoverPlugins();

      expect(dirs).toEqual(['/plugins/alpha', '/plugins/beta']);
    });

    it('ignores directories without manifest.json', async () => {
      mockReaddir.mockResolvedValue(['alpha', 'no-manifest'] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);
      allowAccess(['/plugins/alpha/manifest.json']);

      const loader = new PluginLoader({ toolCatalog: new ToolCatalog(), pluginsDir: '/plugins' });
      const dirs = await loader.discoverPlugins();

      expect(dirs).toEqual(['/plugins/alpha']);
    });

    it('handles empty plugins directory', async () => {
      mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof readdir>>);

      const loader = new PluginLoader({ toolCatalog: new ToolCatalog(), pluginsDir: '/plugins' });
      const dirs = await loader.discoverPlugins();

      expect(dirs).toEqual([]);
    });

    it('returns empty array when plugins directory does not exist', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const loader = new PluginLoader({ toolCatalog: new ToolCatalog(), pluginsDir: '/missing' });
      const dirs = await loader.discoverPlugins();

      expect(dirs).toEqual([]);
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
      const loader = new PluginLoader({ toolCatalog: catalog, pluginsDir: '/plugins' });

      const result = await loader.loadPlugin('/plugins/alpha');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pluginName).toBe('alpha');
        expect(result.manifest).toEqual(manifest);
        expect(result.handler).toBe(handler);
      }
      expect(catalog.has('alpha_tool')).toBe(true);
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

      const loader = new PluginLoader({ toolCatalog: new ToolCatalog(), pluginsDir: '/plugins' });
      await loader.loadPlugin('/plugins/beta');

      expect(handler.initialize).toHaveBeenCalledTimes(1);
      expect(handler.initialize).toHaveBeenCalledWith({});
    });
  });

  // -----------------------------------------------------------------------
  // Invalid manifest
  // -----------------------------------------------------------------------

  describe('loadPlugin with invalid manifest', () => {
    it('rejects with category invalid_manifest for malformed JSON', async () => {
      mockReadFile.mockResolvedValue('{ not valid json }}}');

      const loader = new PluginLoader({ toolCatalog: new ToolCatalog(), pluginsDir: '/plugins' });
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

      const loader = new PluginLoader({ toolCatalog: new ToolCatalog(), pluginsDir: '/plugins' });
      const result = await loader.loadPlugin('/plugins/alpha');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe('invalid_manifest');
        expect(result.error).toContain('Invalid manifest');
      }
    });

    it('rejects when manifest.json cannot be read', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const loader = new PluginLoader({ toolCatalog: new ToolCatalog(), pluginsDir: '/plugins' });
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

      const loader = new PluginLoader({ toolCatalog: catalog, pluginsDir: '/plugins' });
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
          pluginsDir: '/plugins',
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

      const loader = new PluginLoader({ toolCatalog: new ToolCatalog(), pluginsDir: '/plugins' });
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
      const loader = new PluginLoader({ toolCatalog: catalog, pluginsDir: '/plugins' });
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
        pluginsDir: '/plugins',
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

      const loader = new PluginLoader({ toolCatalog: new ToolCatalog(), pluginsDir: '/plugins' });
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

      const loader = new PluginLoader({ toolCatalog: new ToolCatalog(), pluginsDir: '/plugins' });
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
      const loader = new PluginLoader({ toolCatalog: catalog, pluginsDir: '/plugins' });
      const results = await loader.loadAll();

      expect(results).toHaveLength(2);

      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      expect(successes[0]!.pluginName).toBe('alpha');
      expect(failures[0]!.pluginName).toBe('bad-handler');

      // Only the successful plugin's tool should be in the catalog
      expect(catalog.has('alpha_tool')).toBe(true);
      expect(catalog.has('bad_tool')).toBe(false);
    });

    it('returns empty array when no plugins are found', async () => {
      mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof readdir>>);

      const loader = new PluginLoader({ toolCatalog: new ToolCatalog(), pluginsDir: '/plugins' });
      const results = await loader.loadAll();

      expect(results).toEqual([]);
    });
  });
});
