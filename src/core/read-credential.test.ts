/**
 * Tests for CoreServices.readCredential() wired through PluginLoader.
 *
 * Validates:
 *  - Happy path: reads the correct scoped file
 *  - Invalid keys (/, .., null bytes) throw with actionable error
 *  - Missing files throw with actionable error
 *  - Plugin scoping: each plugin has its own credential directory
 *  - Unconfigured credentials directory throws
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolCatalog } from './tool-catalog.js';
import { PluginLoader } from './plugin-loader.js';
import type { PluginHandler, CoreServices } from './plugin-handler.js';
import { createManifest, createToolDeclaration } from '../testing/factories.js';

// ---------------------------------------------------------------------------
// Mock node:fs/promises (required by PluginLoader for plugin discovery)
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  access: vi.fn(),
}));

import { readFile, access } from 'node:fs/promises';

const mockReadFile = vi.mocked(readFile);
const mockAccess = vi.mocked(access);

// ---------------------------------------------------------------------------
// Handler mock setup
// Each test uses a unique plugin path to avoid Vitest import caching.
// ---------------------------------------------------------------------------

let importMocks: Map<string, () => Promise<Record<string, unknown>>>;

vi.mock('/plugins/happy-path/handler.js', () =>
  importMocks.get('/plugins/happy-path/handler.js')!(),
);
vi.mock('/plugins/scope-a/handler.js', () => importMocks.get('/plugins/scope-a/handler.js')!());
vi.mock('/plugins/scope-b/handler.js', () => importMocks.get('/plugins/scope-b/handler.js')!());
vi.mock('/plugins/slash-key/handler.js', () => importMocks.get('/plugins/slash-key/handler.js')!());
vi.mock('/plugins/dotdot-key/handler.js', () =>
  importMocks.get('/plugins/dotdot-key/handler.js')!(),
);
vi.mock('/plugins/null-key/handler.js', () => importMocks.get('/plugins/null-key/handler.js')!());
vi.mock('/plugins/missing-file/handler.js', () =>
  importMocks.get('/plugins/missing-file/handler.js')!(),
);
vi.mock('/plugins/no-cred-dir/handler.js', () =>
  importMocks.get('/plugins/no-cred-dir/handler.js')!(),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockHandler(overrides?: Partial<PluginHandler>): PluginHandler {
  return {
    initialize: vi.fn(async () => {}),
    handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  };
}

function allowAccess(paths: string[]): void {
  const pathSet = new Set(paths);
  mockAccess.mockImplementation(async (p) => {
    if (pathSet.has(String(p))) return undefined;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
}

function createCredentialDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carapace-cred-test-'));
}

function writeCredential(
  credPluginsDir: string,
  pluginName: string,
  key: string,
  value: string,
): void {
  const pluginDir = path.join(credPluginsDir, pluginName);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, key), value, { mode: 0o600 });
}

/**
 * Load a plugin and capture the CoreServices passed to initialize().
 */
async function loadAndCapture(
  pluginPath: string,
  toolName: string,
  opts: { credentialsPluginsDir?: string },
): Promise<{ services: CoreServices; result: import('./plugin-handler.js').PluginLoadResult }> {
  let capturedServices: CoreServices | undefined;
  const handler = createMockHandler({
    initialize: vi.fn(async (services: CoreServices) => {
      capturedServices = services;
    }),
  });

  const manifest = createManifest({
    provides: {
      channels: [],
      tools: [createToolDeclaration({ name: toolName })],
    },
  });

  mockReadFile.mockResolvedValue(JSON.stringify(manifest));
  allowAccess([`${pluginPath}/manifest.json`, `${pluginPath}/handler.js`]);
  importMocks.set(`${pluginPath}/handler.js`, () => Promise.resolve({ default: handler }));

  const loader = new PluginLoader({
    toolCatalog: new ToolCatalog(),
    userPluginsDir: '/plugins',
    credentialsPluginsDir: opts.credentialsPluginsDir,
  });

  const result = await loader.loadPlugin(pluginPath);

  if (!capturedServices) {
    throw new Error(
      `Handler.initialize was not called. loadPlugin result: ${JSON.stringify(result)}`,
    );
  }

  return { services: capturedServices, result };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  importMocks = new Map();
  tmpDir = createCredentialDir();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoreServices.readCredential', () => {
  it('reads a credential from the plugin-scoped directory', async () => {
    writeCredential(tmpDir, 'happy-path', 'API_KEY', 'test-cred-value-abc'); // gitleaks:allow

    const { services } = await loadAndCapture('/plugins/happy-path', 'happy_path_tool', {
      credentialsPluginsDir: tmpDir,
    });

    const value = services.readCredential('API_KEY');
    expect(value).toBe('test-cred-value-abc');
  });

  it('scopes credentials per plugin name', async () => {
    writeCredential(tmpDir, 'scope-a', 'TOKEN', 'plugin-a-token');
    writeCredential(tmpDir, 'scope-b', 'TOKEN', 'plugin-b-token');

    const manifestA = createManifest({
      provides: {
        channels: [],
        tools: [createToolDeclaration({ name: 'scope_a_tool' })],
      },
    });
    const manifestB = createManifest({
      provides: {
        channels: [],
        tools: [createToolDeclaration({ name: 'scope_b_tool' })],
      },
    });

    let servicesA: CoreServices | undefined;
    let servicesB: CoreServices | undefined;

    const handlerA = createMockHandler({
      initialize: vi.fn(async (services: CoreServices) => {
        servicesA = services;
      }),
    });
    const handlerB = createMockHandler({
      initialize: vi.fn(async (services: CoreServices) => {
        servicesB = services;
      }),
    });

    mockReadFile.mockImplementation(async (p) => {
      const pathStr = String(p);
      if (pathStr.includes('scope-a')) return JSON.stringify(manifestA);
      if (pathStr.includes('scope-b')) return JSON.stringify(manifestB);
      throw new Error('ENOENT');
    });
    allowAccess([
      '/plugins/scope-a/manifest.json',
      '/plugins/scope-a/handler.js',
      '/plugins/scope-b/manifest.json',
      '/plugins/scope-b/handler.js',
    ]);
    importMocks.set('/plugins/scope-a/handler.js', () => Promise.resolve({ default: handlerA }));
    importMocks.set('/plugins/scope-b/handler.js', () => Promise.resolve({ default: handlerB }));

    const catalog = new ToolCatalog();
    const loader = new PluginLoader({
      toolCatalog: catalog,
      userPluginsDir: '/plugins',
      credentialsPluginsDir: tmpDir,
    });

    await loader.loadPlugin('/plugins/scope-a');
    await loader.loadPlugin('/plugins/scope-b');

    expect(servicesA!.readCredential('TOKEN')).toBe('plugin-a-token');
    expect(servicesB!.readCredential('TOKEN')).toBe('plugin-b-token');
  });

  it('throws for key containing /', async () => {
    const { services } = await loadAndCapture('/plugins/slash-key', 'slash_key_tool', {
      credentialsPluginsDir: tmpDir,
    });

    expect(() => services.readCredential('sub/key')).toThrow(/Invalid credential key.*sub\/key/);
    expect(() => services.readCredential('sub/key')).toThrow(/PluginLoader/);
  });

  it('throws for key containing ..', async () => {
    const { services } = await loadAndCapture('/plugins/dotdot-key', 'dotdot_key_tool', {
      credentialsPluginsDir: tmpDir,
    });

    expect(() => services.readCredential('..')).toThrow(/Invalid credential key/);
    expect(() => services.readCredential('..%2F..%2Fetc%2Fpasswd')).toThrow(
      /Invalid credential key/,
    );
  });

  it('throws for key containing null bytes', async () => {
    const { services } = await loadAndCapture('/plugins/null-key', 'null_key_tool', {
      credentialsPluginsDir: tmpDir,
    });

    expect(() => services.readCredential('key\0evil')).toThrow(/Invalid credential key/);
  });

  it('throws actionable error for missing credential file', async () => {
    // No credential files written for this plugin
    const { services } = await loadAndCapture('/plugins/missing-file', 'missing_file_tool', {
      credentialsPluginsDir: tmpDir,
    });

    expect(() => services.readCredential('MISSING_KEY')).toThrow(/not found.*missing-file/);
    expect(() => services.readCredential('MISSING_KEY')).toThrow(/PluginLoader/);
    expect(() => services.readCredential('MISSING_KEY')).toThrow(/Fix:/);
  });

  it('throws when credentials directory is not configured', async () => {
    const { services } = await loadAndCapture('/plugins/no-cred-dir', 'no_cred_dir_tool', {
      credentialsPluginsDir: undefined,
    });

    expect(() => services.readCredential('SOME_KEY')).toThrow(
      /credentials directory not configured/,
    );
    expect(() => services.readCredential('SOME_KEY')).toThrow(/PluginLoader/);
  });
});
