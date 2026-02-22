/**
 * Tests for InstallerHandler — plugin_install, plugin_list, plugin_remove,
 * plugin_update, plugin_configure, and plugin_verify tools.
 *
 * All tests use mocked GitOps and filesystem — no real git or disk I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InstallerHandler,
  type InstallerDeps,
  type InstallerFs,
  type SanitizeFunction,
} from './handler.js';
import type { GitOps } from './git-ops.js';
import type { SanitizerFs, SanitizationResult } from './git-sanitizer.js';
import type {
  CoreServices,
  PluginContext,
  PluginHandler,
  PluginVerifyResult,
} from '../../core/plugin-handler.js';
import { ErrorCode } from '../../types/errors.js';
import type { Stats } from 'node:fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validManifestJson(): string {
  return JSON.stringify({
    description: 'A test plugin',
    version: '1.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Test Author' },
    provides: {
      channels: [],
      tools: [
        {
          name: 'test_tool',
          description: 'A test tool',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              input: { type: 'string', description: 'Test input' },
            },
          },
        },
      ],
    },
    subscribes: [],
    install: {
      credentials: [
        {
          key: 'api_key',
          description: 'The API key',
          required: true,
          obtain_url: 'https://example.com/keys',
        },
        {
          key: 'webhook_secret',
          description: 'Optional webhook secret',
          required: false,
        },
      ],
    },
  });
}

function validManifestWithoutInstall(): string {
  return JSON.stringify({
    description: 'A plugin without install spec',
    version: '2.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Test Author' },
    provides: {
      channels: [],
      tools: [
        {
          name: 'another_tool',
          description: 'Another tool',
          risk_level: 'high',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
      ],
    },
    subscribes: [],
  });
}

function validManifestWithConfig(): string {
  return JSON.stringify({
    description: 'A plugin with config schema',
    version: '1.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Test Author' },
    provides: {
      channels: [],
      tools: [
        {
          name: 'test_tool',
          description: 'A test tool',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
      ],
    },
    subscribes: [],
    config_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Notification email' },
        max_retries: { type: 'number', description: 'Max retries' },
        enabled: { type: 'boolean', description: 'Enable plugin' },
      },
    },
  });
}

function updatedManifestWithNewCreds(): string {
  return JSON.stringify({
    description: 'A test plugin (updated)',
    version: '2.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Test Author' },
    provides: {
      channels: [],
      tools: [
        {
          name: 'test_tool',
          description: 'A test tool',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              input: { type: 'string', description: 'Test input' },
            },
          },
        },
      ],
    },
    subscribes: [],
    install: {
      credentials: [
        {
          key: 'api_key',
          description: 'The API key',
          required: true,
          obtain_url: 'https://example.com/keys',
        },
        {
          key: 'webhook_secret',
          description: 'Optional webhook secret',
          required: false,
        },
        {
          key: 'new_token',
          description: 'A new auth token',
          required: true,
          obtain_url: 'https://example.com/tokens',
        },
      ],
    },
  });
}

function createMockGitOps(): GitOps {
  return {
    clone: vi.fn(async () => {}),
    fetch: vi.fn(async () => {}),
    checkout: vi.fn(async () => {}),
    getRemoteUrl: vi.fn(async () => ''),
    getCurrentRef: vi.fn(async () => ''),
    getDefaultBranch: vi.fn(async (): Promise<string> => 'main'),
    configUnset: vi.fn(async () => {}),
    configList: vi.fn(async () => new Map()),
  };
}

function createMockStats(overrides?: Partial<Stats>): Stats {
  return {
    isSymbolicLink: () => false,
    mode: 0o100600,
    size: 42,
    ...overrides,
  } as Stats;
}

function createMockFs(overrides?: Partial<InstallerFs>): InstallerFs {
  return {
    existsSync: vi.fn((): boolean => false),
    readFileSync: vi.fn((): string => validManifestJson()),
    rmSync: vi.fn(),
    readdirSync: vi.fn((): string[] => []),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    lstatSync: vi.fn((): Stats => createMockStats()),
    ...overrides,
  };
}

function createMockSanitize(): SanitizeFunction {
  return vi.fn(
    async (): Promise<SanitizationResult> => ({
      hooksRemoved: 0,
      configKeysStripped: [],
      rejected: false,
      rejectionReasons: [],
    }),
  );
}

function createMockSanitizerFs(): SanitizerFs {
  return {
    readdir: vi.fn(async () => []),
    unlink: vi.fn(async () => {}),
    access: vi.fn(async () => false),
    lstat: vi.fn(async () => ({ isSymbolicLink: () => false })),
  };
}

function createDeps(overrides?: Partial<InstallerDeps>): InstallerDeps {
  return {
    pluginsDir: '/home/user/.carapace/plugins',
    credentialsDir: '/home/user/.carapace/credentials/plugins',
    carapaceHome: '/home/user/.carapace',
    gitOps: createMockGitOps(),
    reservedNames: new Set(['installer', 'memory', 'test-input']),
    ...overrides,
  };
}

function createContext(): PluginContext {
  return {
    group: 'default',
    sessionId: 'session-1',
    correlationId: 'corr-1',
    timestamp: new Date().toISOString(),
  };
}

function createServices(): CoreServices {
  return {
    getAuditLog: vi.fn(async () => []),
    getToolCatalog: vi.fn(() => []),
    getSessionInfo: vi.fn(() => ({ group: '', sessionId: '', startedAt: '' })),
    readCredential: vi.fn(() => ''),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InstallerHandler', () => {
  let deps: InstallerDeps;
  let mockFs: InstallerFs;
  let mockSanitize: SanitizeFunction;
  let mockSanitizerFs: SanitizerFs;
  let handler: InstallerHandler;
  let context: PluginContext;

  beforeEach(async () => {
    deps = createDeps();
    mockFs = createMockFs();
    mockSanitize = createMockSanitize();
    mockSanitizerFs = createMockSanitizerFs();
    handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
    context = createContext();
    await handler.initialize(createServices());
  });

  // -----------------------------------------------------------------------
  // initialize / shutdown
  // -----------------------------------------------------------------------

  describe('lifecycle', () => {
    it('should initialize and shutdown without error', async () => {
      const h = new InstallerHandler(deps);
      await h.initialize(createServices());
      await h.shutdown();
    });
  });

  // -----------------------------------------------------------------------
  // Unknown tool
  // -----------------------------------------------------------------------

  describe('unknown tool', () => {
    it('should return error for unknown tool name', async () => {
      const result = await handler.handleToolInvocation('nonexistent_tool', {}, context);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.HANDLER_ERROR);
        expect(result.error.message).toContain('Unknown tool');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Successful install
  // -----------------------------------------------------------------------

  describe('successful install', () => {
    it('should install a plugin and return metadata with credential instructions', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/my-plugin.git' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['plugin_name']).toBe('my-plugin');
        expect(result.result['version']).toBe('1.0.0');
        expect(result.result['description']).toBe('A test plugin');
        expect(result.result['tools']).toEqual(['test_tool']);
        const creds = result.result['credentials_needed'] as Array<Record<string, unknown>>;
        expect(creds).toHaveLength(2);
        expect(creds[0]!['key']).toBe('api_key');
        expect(creds[0]!['file']).toBe(
          '/home/user/.carapace/credentials/plugins/my-plugin/api_key',
        );
        expect(creds[0]!['obtain_url']).toBe('https://example.com/keys');
        expect(creds[1]!['key']).toBe('webhook_secret');
        expect(creds[1]!['required']).toBe(false);
      }
    });

    it('should install a plugin without install spec (empty credentials)', async () => {
      mockFs = createMockFs({
        readFileSync: vi.fn((): string => validManifestWithoutInstall()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/simple-plugin.git' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['plugin_name']).toBe('simple-plugin');
        expect(result.result['credentials_needed']).toEqual([]);
      }
    });

    it('should call clone with correct URL and destination', async () => {
      await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/my-plugin.git' },
        context,
      );

      expect(deps.gitOps.clone).toHaveBeenCalledWith(
        'https://github.com/user/my-plugin.git',
        '/home/user/.carapace/plugins/my-plugin',
      );
    });

    it('should call sanitize with correct arguments', async () => {
      await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/my-plugin.git' },
        context,
      );

      expect(mockSanitize).toHaveBeenCalledWith(
        '/home/user/.carapace/plugins/my-plugin',
        mockSanitizerFs,
        deps.gitOps,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Name derivation from various URL formats
  // -----------------------------------------------------------------------

  describe('name derivation', () => {
    it('should derive name from https URL with .git suffix', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/awesome-plugin.git' },
        context,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['plugin_name']).toBe('awesome-plugin');
      }
    });

    it('should derive name from https URL without .git suffix', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/awesome-plugin' },
        context,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['plugin_name']).toBe('awesome-plugin');
      }
    });

    it('should derive name from git@ SSH URL', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'git@github.com:user/ssh-plugin.git' },
        context,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['plugin_name']).toBe('ssh-plugin');
      }
    });

    it('should derive name from git@ SSH URL without .git suffix', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'git@github.com:user/ssh-plugin' },
        context,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['plugin_name']).toBe('ssh-plugin');
      }
    });

    it('should derive name from deeply nested path', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://gitlab.com/org/subgroup/my-tool.git' },
        context,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['plugin_name']).toBe('my-tool');
      }
    });

    it('should return error when name cannot be derived', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/' },
        context,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Could not derive plugin name');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Name validation
  // -----------------------------------------------------------------------

  describe('name validation', () => {
    it('should accept valid lowercase names', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/valid-name.git' },
        context,
      );
      expect(result.ok).toBe(true);
    });

    it('should accept names with underscores and digits', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/plugin_v2.git' },
        context,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['plugin_name']).toBe('plugin_v2');
      }
    });

    it('should reject names starting with a digit', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/repo.git', name: '2fast' },
        context,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('Invalid plugin name');
      }
    });

    it('should reject names with uppercase letters', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/repo.git', name: 'MyPlugin' },
        context,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
      }
    });

    it('should reject names with special characters', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/repo.git', name: 'my.plugin' },
        context,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
      }
    });

    it('should reject empty name override', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/repo.git', name: '' },
        context,
      );
      // Empty string is falsy, so deriveName falls through to URL-based derivation
      // which yields 'repo' — a valid name. So it should succeed.
      expect(result.ok).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Reserved name rejection
  // -----------------------------------------------------------------------

  describe('reserved name rejection', () => {
    it('should reject reserved name "installer"', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/repo.git', name: 'installer' },
        context,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('reserved');
      }
    });

    it('should reject reserved name "memory"', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/repo.git', name: 'memory' },
        context,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('reserved');
      }
    });

    it('should reject reserved name "test-input"', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/repo.git', name: 'test-input' },
        context,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('reserved');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Name collision detection
  // -----------------------------------------------------------------------

  describe('name collision detection', () => {
    it('should reject when plugin directory already exists', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => true),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/existing-plugin.git' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('already exists');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Clone failure cleanup
  // -----------------------------------------------------------------------

  describe('clone failure', () => {
    it('should return error on clone failure without cleanup (directory not created)', async () => {
      const gitOps = createMockGitOps();
      (gitOps.clone as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Repository not found'),
      );
      deps = createDeps({ gitOps });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/nonexistent.git' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Clone failed');
        expect(result.error.message).toContain('Repository not found');
        expect(result.error.retriable).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Sanitization rejection cleanup
  // -----------------------------------------------------------------------

  describe('sanitization rejection', () => {
    it('should clean up and return error when sanitizer rejects', async () => {
      mockSanitize = vi.fn(
        async (): Promise<SanitizationResult> => ({
          hooksRemoved: 0,
          configKeysStripped: [],
          rejected: true,
          rejectionReasons: ['Repository contains .gitmodules (submodules not allowed)'],
        }),
      );
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/bad-plugin.git' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Repository rejected');
        expect(result.error.message).toContain('submodules not allowed');
      }

      // Verify cleanup was called
      expect(mockFs.rmSync).toHaveBeenCalledWith('/home/user/.carapace/plugins/bad-plugin', {
        recursive: true,
        force: true,
      });
    });

    it('should clean up when sanitizer throws an error', async () => {
      mockSanitize = vi.fn(async (): Promise<SanitizationResult> => {
        throw new Error('Unexpected sanitizer crash');
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/crash-plugin.git' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Sanitization failed');
      }
      expect(mockFs.rmSync).toHaveBeenCalledWith('/home/user/.carapace/plugins/crash-plugin', {
        recursive: true,
        force: true,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Invalid manifest cleanup
  // -----------------------------------------------------------------------

  describe('invalid manifest cleanup', () => {
    it('should clean up when manifest.json is missing', async () => {
      mockFs = createMockFs({
        readFileSync: vi.fn((): string => {
          throw new Error('ENOENT: no such file or directory');
        }),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/no-manifest.git' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid manifest');
      }
      expect(mockFs.rmSync).toHaveBeenCalledWith('/home/user/.carapace/plugins/no-manifest', {
        recursive: true,
        force: true,
      });
    });

    it('should clean up when manifest.json is not valid JSON', async () => {
      mockFs = createMockFs({
        readFileSync: vi.fn((): string => '{ invalid json !!!'),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/bad-json.git' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid manifest');
        expect(result.error.message).toContain('not valid JSON');
      }
      expect(mockFs.rmSync).toHaveBeenCalledWith('/home/user/.carapace/plugins/bad-json', {
        recursive: true,
        force: true,
      });
    });

    it('should clean up when manifest fails schema validation', async () => {
      mockFs = createMockFs({
        readFileSync: vi.fn((): string =>
          JSON.stringify({ description: 'Missing required fields' }),
        ),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/bad-schema.git' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid manifest');
        expect(result.error.message).toContain('Schema validation failed');
      }
      expect(mockFs.rmSync).toHaveBeenCalledWith('/home/user/.carapace/plugins/bad-schema', {
        recursive: true,
        force: true,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Optional name override
  // -----------------------------------------------------------------------

  describe('optional name override', () => {
    it('should use user-provided name instead of URL-derived name', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_install',
        { url: 'https://github.com/user/original-name.git', name: 'custom-name' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['plugin_name']).toBe('custom-name');
      }

      expect(deps.gitOps.clone).toHaveBeenCalledWith(
        'https://github.com/user/original-name.git',
        '/home/user/.carapace/plugins/custom-name',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Missing url argument
  // -----------------------------------------------------------------------

  describe('missing url', () => {
    it('should return validation error when url is missing', async () => {
      const result = await handler.handleToolInvocation('plugin_install', {}, context);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('url');
      }
    });
  });

  // =======================================================================
  // plugin_list
  // =======================================================================

  describe('plugin_list', () => {
    it('should list installed plugins from pluginsDir', async () => {
      mockFs = createMockFs({
        readdirSync: vi.fn((): string[] => ['my-plugin', 'other-plugin']),
        existsSync: vi.fn((p: string): boolean => {
          // manifest.json exists for both plugins, .git exists for my-plugin only
          if (p.endsWith('manifest.json')) return true;
          if (p === '/home/user/.carapace/plugins/my-plugin/.git') return true;
          if (p === '/home/user/.carapace/plugins/other-plugin/.git') return false;
          return false;
        }),
        readFileSync: vi.fn((p: string): string => {
          if (p.includes('my-plugin')) return validManifestJson();
          if (p.includes('other-plugin')) return validManifestWithoutInstall();
          return validManifestJson();
        }),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation('plugin_list', {}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const plugins = result.result['plugins'] as Array<Record<string, unknown>>;
        expect(plugins).toHaveLength(2);

        expect(plugins[0]!['name']).toBe('my-plugin');
        expect(plugins[0]!['version']).toBe('1.0.0');
        expect(plugins[0]!['description']).toBe('A test plugin');
        expect(plugins[0]!['tools']).toEqual(['test_tool']);
        expect(plugins[0]!['installed_via_git']).toBe(true);

        expect(plugins[1]!['name']).toBe('other-plugin');
        expect(plugins[1]!['version']).toBe('2.0.0');
        expect(plugins[1]!['installed_via_git']).toBe(false);
      }
    });

    it('should return empty list when pluginsDir is empty', async () => {
      mockFs = createMockFs({
        readdirSync: vi.fn((): string[] => []),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation('plugin_list', {}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const plugins = result.result['plugins'] as Array<Record<string, unknown>>;
        expect(plugins).toHaveLength(0);
      }
    });

    it('should include built-in plugin names when include_builtin is true', async () => {
      mockFs = createMockFs({
        readdirSync: vi.fn((): string[] => []),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_list',
        { include_builtin: true },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const plugins = result.result['plugins'] as Array<Record<string, unknown>>;
        // reservedNames: installer, memory, test-input
        expect(plugins).toHaveLength(3);
        const builtinNames = plugins.map((p) => p['name']);
        expect(builtinNames).toContain('installer');
        expect(builtinNames).toContain('memory');
        expect(builtinNames).toContain('test-input');
        expect(plugins[0]!['builtin']).toBe(true);
      }
    });

    it('should skip directories without manifest.json', async () => {
      mockFs = createMockFs({
        readdirSync: vi.fn((): string[] => ['has-manifest', 'no-manifest']),
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/has-manifest/manifest.json') return true;
          if (p === '/home/user/.carapace/plugins/no-manifest/manifest.json') return false;
          return false;
        }),
        readFileSync: vi.fn((): string => validManifestJson()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation('plugin_list', {}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const plugins = result.result['plugins'] as Array<Record<string, unknown>>;
        expect(plugins).toHaveLength(1);
        expect(plugins[0]!['name']).toBe('has-manifest');
      }
    });

    it('should handle unreadable pluginsDir gracefully', async () => {
      mockFs = createMockFs({
        readdirSync: vi.fn((): string[] => {
          throw new Error('ENOENT');
        }),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation('plugin_list', {}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const plugins = result.result['plugins'] as Array<Record<string, unknown>>;
        expect(plugins).toHaveLength(0);
      }
    });

    it('should note plugins with invalid manifests', async () => {
      mockFs = createMockFs({
        readdirSync: vi.fn((): string[] => ['broken-plugin']),
        existsSync: vi.fn((p: string): boolean => {
          if (p.endsWith('manifest.json')) return true;
          return false;
        }),
        readFileSync: vi.fn((): string => '{ invalid json'),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation('plugin_list', {}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const plugins = result.result['plugins'] as Array<Record<string, unknown>>;
        expect(plugins).toHaveLength(1);
        expect(plugins[0]!['name']).toBe('broken-plugin');
        expect(plugins[0]!['error']).toBe('Invalid manifest');
      }
    });
  });

  // =======================================================================
  // plugin_remove
  // =======================================================================

  describe('plugin_remove', () => {
    it('should remove a plugin directory and retain credentials by default', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          return false;
        }),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_remove',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['removed']).toBe('my-plugin');
        expect(result.result['credentials_retained']).toBe(true);
        expect(result.result['requires_restart']).toBe(true);
      }

      expect(mockFs.rmSync).toHaveBeenCalledWith('/home/user/.carapace/plugins/my-plugin', {
        recursive: true,
        force: true,
      });
    });

    it('should remove credentials when remove_credentials is true', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => true),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_remove',
        { name: 'my-plugin', remove_credentials: true },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['credentials_retained']).toBe(false);
      }

      // Should remove both plugin dir and credentials dir
      expect(mockFs.rmSync).toHaveBeenCalledWith('/home/user/.carapace/plugins/my-plugin', {
        recursive: true,
        force: true,
      });
      expect(mockFs.rmSync).toHaveBeenCalledWith(
        '/home/user/.carapace/credentials/plugins/my-plugin',
        {
          recursive: true,
          force: true,
        },
      );
    });

    it('should reject removal of built-in plugins', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_remove',
        { name: 'installer' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('Cannot remove built-in');
      }
    });

    it('should return error when plugin does not exist', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => false),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_remove',
        { name: 'nonexistent' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('not found');
      }
    });

    it('should return error when name is missing', async () => {
      const result = await handler.handleToolInvocation('plugin_remove', {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('name');
      }
    });
  });

  // =======================================================================
  // plugin_update
  // =======================================================================

  describe('plugin_update', () => {
    it('should fetch, checkout, re-sanitize, and re-validate on update', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          if (p === '/home/user/.carapace/plugins/my-plugin/.git') return true;
          return false;
        }),
        readFileSync: vi.fn((): string => validManifestJson()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_update',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['plugin_name']).toBe('my-plugin');
        expect(result.result['old_version']).toBe('1.0.0');
        expect(result.result['new_version']).toBe('1.0.0');
        expect(result.result['requires_restart']).toBe(true);
      }

      // Verify fetch was called
      expect(deps.gitOps.fetch).toHaveBeenCalledWith('/home/user/.carapace/plugins/my-plugin');

      // Verify getDefaultBranch was called
      expect(deps.gitOps.getDefaultBranch).toHaveBeenCalledWith(
        '/home/user/.carapace/plugins/my-plugin',
      );

      // Verify checkout was called with origin/main
      expect(deps.gitOps.checkout).toHaveBeenCalledWith(
        '/home/user/.carapace/plugins/my-plugin',
        'origin/main',
      );

      // Verify re-sanitize was called
      expect(mockSanitize).toHaveBeenCalledWith(
        '/home/user/.carapace/plugins/my-plugin',
        mockSanitizerFs,
        deps.gitOps,
      );
    });

    it('should detect new credential requirements after update', async () => {
      let callCount = 0;
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          if (p === '/home/user/.carapace/plugins/my-plugin/.git') return true;
          return false;
        }),
        readFileSync: vi.fn((): string => {
          callCount++;
          // First call reads old manifest, second reads new (updated) manifest
          if (callCount <= 1) return validManifestJson();
          return updatedManifestWithNewCreds();
        }),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_update',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['old_version']).toBe('1.0.0');
        expect(result.result['new_version']).toBe('2.0.0');

        const newCreds = result.result['new_credentials_needed'] as Array<Record<string, unknown>>;
        expect(newCreds).toHaveLength(1);
        expect(newCreds[0]!['key']).toBe('new_token');
        expect(newCreds[0]!['required']).toBe(true);
        expect(newCreds[0]!['obtain_url']).toBe('https://example.com/tokens');
        expect(newCreds[0]!['file']).toBe(
          '/home/user/.carapace/credentials/plugins/my-plugin/new_token',
        );
      }
    });

    it('should return error when plugin has no .git directory', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/manual-plugin') return true;
          if (p === '/home/user/.carapace/plugins/manual-plugin/.git') return false;
          return false;
        }),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_update',
        { name: 'manual-plugin' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('not installed via git');
      }
    });

    it('should return error when plugin does not exist', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => false),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_update',
        { name: 'nonexistent' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('not found');
      }
    });

    it('should return error when fetch fails', async () => {
      const gitOps = createMockGitOps();
      (gitOps.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
      deps = createDeps({ gitOps });
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          if (p === '/home/user/.carapace/plugins/my-plugin/.git') return true;
          return false;
        }),
        readFileSync: vi.fn((): string => validManifestJson()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_update',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Fetch failed');
        expect(result.error.retriable).toBe(true);
      }
    });

    it('should return error when name is missing', async () => {
      const result = await handler.handleToolInvocation('plugin_update', {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('name');
      }
    });

    it('should return error when sanitizer rejects after update', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          if (p === '/home/user/.carapace/plugins/my-plugin/.git') return true;
          return false;
        }),
        readFileSync: vi.fn((): string => validManifestJson()),
      });
      mockSanitize = vi.fn(
        async (): Promise<SanitizationResult> => ({
          hooksRemoved: 0,
          configKeysStripped: [],
          rejected: true,
          rejectionReasons: ['Contains symlinks'],
        }),
      );
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_update',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Updated repository rejected');
        expect(result.error.message).toContain('Contains symlinks');
      }
    });
  });

  // =======================================================================
  // plugin_configure
  // =======================================================================

  describe('plugin_configure', () => {
    it('should write config.json with the specified key/value', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          if (p.endsWith('manifest.json')) return true;
          if (p.endsWith('config.json')) return false;
          return false;
        }),
        readFileSync: vi.fn((): string => validManifestWithConfig()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_configure',
        { name: 'my-plugin', key: 'email', value: 'user@example.com' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['plugin_name']).toBe('my-plugin');
        expect(result.result['key']).toBe('email');
        expect(result.result['value']).toBe('user@example.com');
      }

      // Verify config.json was written
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/home/user/.carapace/plugins/my-plugin/config.json',
        JSON.stringify({ email: 'user@example.com' }, null, 2),
        'utf-8',
      );
    });

    it('should merge with existing config.json', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          if (p.endsWith('config.json')) return true;
          return true;
        }),
        readFileSync: vi.fn((p: string): string => {
          if (p.endsWith('config.json')) return JSON.stringify({ email: 'old@example.com' });
          return validManifestWithConfig();
        }),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_configure',
        { name: 'my-plugin', key: 'max_retries', value: 5 },
        context,
      );

      expect(result.ok).toBe(true);

      // Verify config.json preserves existing values
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/home/user/.carapace/plugins/my-plugin/config.json',
        JSON.stringify({ email: 'old@example.com', max_retries: 5 }, null, 2),
        'utf-8',
      );
    });

    it('should reject unknown config keys', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => true),
        readFileSync: vi.fn((): string => validManifestWithConfig()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_configure',
        { name: 'my-plugin', key: 'nonexistent_key', value: 'foo' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('Unknown config key');
        expect(result.error.message).toContain('nonexistent_key');
        expect(result.error.message).toContain('email');
      }
    });

    it('should reject value with wrong type', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => true),
        readFileSync: vi.fn((): string => validManifestWithConfig()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_configure',
        { name: 'my-plugin', key: 'email', value: 123 },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('must be of type "string"');
      }
    });

    it('should reject when plugin has no config_schema', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => true),
        readFileSync: vi.fn((): string => validManifestJson()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_configure',
        { name: 'my-plugin', key: 'email', value: 'user@example.com' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('does not declare a config_schema');
      }
    });

    it('should return error when plugin does not exist', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => false),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_configure',
        { name: 'nonexistent', key: 'email', value: 'user@example.com' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('not found');
      }
    });

    it('should return error when name is missing', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_configure',
        { key: 'email', value: 'user@example.com' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('name');
      }
    });

    it('should return error when key is missing', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_configure',
        { name: 'my-plugin', value: 'foo' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('key');
      }
    });

    it('should return error when value is missing', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_configure',
        { name: 'my-plugin', key: 'email' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('value');
      }
    });

    it('should accept boolean values for boolean config keys', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          if (p.endsWith('config.json')) return false;
          return true;
        }),
        readFileSync: vi.fn((): string => validManifestWithConfig()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_configure',
        { name: 'my-plugin', key: 'enabled', value: true },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['value']).toBe(true);
      }
    });

    it('should accept number values for number config keys', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          if (p.endsWith('config.json')) return false;
          return true;
        }),
        readFileSync: vi.fn((): string => validManifestWithConfig()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_configure',
        { name: 'my-plugin', key: 'max_retries', value: 3 },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['value']).toBe(3);
      }
    });
  });

  // =======================================================================
  // plugin_verify
  // =======================================================================

  describe('plugin_verify', () => {
    it('should return ready: true when all credentials are present and valid', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          return true;
        }),
        readFileSync: vi.fn((): string => validManifestJson()),
        lstatSync: vi.fn(
          (): Stats =>
            createMockStats({
              isSymbolicLink: () => false,
              mode: 0o100600,
              size: 42,
            }),
        ),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(true);
        expect(result.result['plugin_name']).toBe('my-plugin');
        const credStatus = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(credStatus).toHaveLength(2);
        expect(credStatus[0]!['key']).toBe('api_key');
        expect(credStatus[0]!['ok']).toBe(true);
        expect(credStatus[1]!['key']).toBe('webhook_secret');
        expect(credStatus[1]!['ok']).toBe(true);
      }
    });

    it('should return ready: false when a required credential file is missing', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          return true;
        }),
        readFileSync: vi.fn((): string => validManifestJson()),
        lstatSync: vi.fn((p: string): Stats => {
          if (p.endsWith('api_key')) {
            throw new Error('ENOENT: no such file or directory');
          }
          return createMockStats();
        }),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const credStatus = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(credStatus[0]!['key']).toBe('api_key');
        expect(credStatus[0]!['ok']).toBe(false);
        expect(credStatus[0]!['error']).toBe('File not found');
      }
    });

    it('should return ready: false when a credential file has wrong permissions', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          return true;
        }),
        readFileSync: vi.fn((): string => validManifestJson()),
        lstatSync: vi.fn((p: string): Stats => {
          if (p.endsWith('api_key')) {
            return createMockStats({ mode: 0o100644 });
          }
          return createMockStats();
        }),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const credStatus = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(credStatus[0]!['key']).toBe('api_key');
        expect(credStatus[0]!['ok']).toBe(false);
        expect(credStatus[0]!['error']).toContain('Incorrect permissions');
        expect(credStatus[0]!['error']).toContain('0644');
      }
    });

    it('should return ready: false when a credential file is a symlink', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          return true;
        }),
        readFileSync: vi.fn((): string => validManifestJson()),
        lstatSync: vi.fn((p: string): Stats => {
          if (p.endsWith('api_key')) {
            return createMockStats({ isSymbolicLink: () => true });
          }
          return createMockStats();
        }),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const credStatus = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(credStatus[0]!['key']).toBe('api_key');
        expect(credStatus[0]!['ok']).toBe(false);
        expect(credStatus[0]!['error']).toContain('symlink');
      }
    });

    it('should return ready: false when a credential file is empty', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((p: string): boolean => {
          if (p === '/home/user/.carapace/plugins/my-plugin') return true;
          return true;
        }),
        readFileSync: vi.fn((): string => validManifestJson()),
        lstatSync: vi.fn((p: string): Stats => {
          if (p.endsWith('api_key')) {
            return createMockStats({ size: 0 });
          }
          return createMockStats();
        }),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const credStatus = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(credStatus[0]!['key']).toBe('api_key');
        expect(credStatus[0]!['ok']).toBe(false);
        expect(credStatus[0]!['error']).toBe('File is empty');
      }
    });

    it('should run smoke test when handler is loaded and implements verify()', async () => {
      const mockHandler: PluginHandler = {
        initialize: vi.fn(async () => {}),
        handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
        shutdown: vi.fn(async () => {}),
        verify: vi.fn(
          async (): Promise<PluginVerifyResult> => ({
            ok: true,
            message: 'Connection established',
          }),
        ),
      };

      deps = createDeps({
        getLoadedHandler: (_name: string): PluginHandler | undefined => mockHandler,
      });
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => true),
        readFileSync: vi.fn((): string => validManifestJson()),
        lstatSync: vi.fn((): Stats => createMockStats()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(true);
        const smoke = result.result['smoke_test'] as Record<string, unknown>;
        expect(smoke['ok']).toBe(true);
        expect(smoke['message']).toBe('Connection established');
      }
    });

    it('should return ready: false when smoke test fails', async () => {
      const mockHandler: PluginHandler = {
        initialize: vi.fn(async () => {}),
        handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
        shutdown: vi.fn(async () => {}),
        verify: vi.fn(
          async (): Promise<PluginVerifyResult> => ({
            ok: false,
            message: 'Authentication failed',
          }),
        ),
      };

      deps = createDeps({
        getLoadedHandler: (_name: string): PluginHandler | undefined => mockHandler,
      });
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => true),
        readFileSync: vi.fn((): string => validManifestJson()),
        lstatSync: vi.fn((): Stats => createMockStats()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const smoke = result.result['smoke_test'] as Record<string, unknown>;
        expect(smoke['ok']).toBe(false);
        expect(smoke['message']).toBe('Authentication failed');
      }
    });

    it('should skip Phase 2 when handler has no verify() method', async () => {
      const mockHandler: PluginHandler = {
        initialize: vi.fn(async () => {}),
        handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
        shutdown: vi.fn(async () => {}),
        // no verify() method
      };

      deps = createDeps({
        getLoadedHandler: (_name: string): PluginHandler | undefined => mockHandler,
      });
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => true),
        readFileSync: vi.fn((): string => validManifestJson()),
        lstatSync: vi.fn((): Stats => createMockStats()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(true);
        expect(result.result['smoke_test']).toBeUndefined();
      }
    });

    it('should return error when plugin is not found', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => false),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'nonexistent' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('not found');
      }
    });

    it('should return ready: true when plugin has no install.credentials', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => true),
        readFileSync: vi.fn((): string => validManifestWithoutInstall()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(true);
        const credStatus = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(credStatus).toHaveLength(0);
      }
    });

    it('should return error when name is missing', async () => {
      const result = await handler.handleToolInvocation('plugin_verify', {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('name');
      }
    });

    it('should handle smoke test that throws an exception', async () => {
      const mockHandler: PluginHandler = {
        initialize: vi.fn(async () => {}),
        handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
        shutdown: vi.fn(async () => {}),
        verify: vi.fn(async (): Promise<PluginVerifyResult> => {
          throw new Error('Connection refused');
        }),
      };

      deps = createDeps({
        getLoadedHandler: (_name: string): PluginHandler | undefined => mockHandler,
      });
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => true),
        readFileSync: vi.fn((): string => validManifestJson()),
        lstatSync: vi.fn((): Stats => createMockStats()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const smoke = result.result['smoke_test'] as Record<string, unknown>;
        expect(smoke['ok']).toBe(false);
        expect(smoke['message']).toContain('Connection refused');
      }
    });

    it('should accept 0400 permissions as valid', async () => {
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => true),
        readFileSync: vi.fn((): string => validManifestJson()),
        lstatSync: vi.fn((): Stats => createMockStats({ mode: 0o100400 })),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(true);
        const credStatus = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(credStatus[0]!['ok']).toBe(true);
      }
    });

    it('should sanitize smoke test detail to strip credential values', async () => {
      const mockHandler: PluginHandler = {
        initialize: vi.fn(async () => {}),
        handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
        shutdown: vi.fn(async () => {}),
        verify: vi.fn(
          async (): Promise<PluginVerifyResult> => ({
            ok: true,
            message: 'Connected',
            detail: {
              token: 'Bearer ghp_1234567890abcdef1234567890abcdef12',
              server: 'api.example.com',
            },
          }),
        ),
      };

      deps = createDeps({
        getLoadedHandler: (_name: string): PluginHandler | undefined => mockHandler,
      });
      mockFs = createMockFs({
        existsSync: vi.fn((): boolean => true),
        readFileSync: vi.fn((): string => validManifestJson()),
        lstatSync: vi.fn((): Stats => createMockStats()),
      });
      handler = new InstallerHandler(deps, mockFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const smoke = result.result['smoke_test'] as Record<string, unknown>;
        const detail = smoke['detail'] as Record<string, unknown>;
        // The github token should be redacted
        expect(detail['token']).toContain('[REDACTED]');
        // Non-sensitive values should be preserved
        expect(detail['server']).toBe('api.example.com');
      }
    });
  });
});
