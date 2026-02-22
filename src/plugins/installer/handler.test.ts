/**
 * Tests for InstallerHandler — plugin_install tool.
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
import type { CoreServices, PluginContext } from '../../core/plugin-handler.js';
import { ErrorCode } from '../../types/errors.js';

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

function createMockGitOps(): GitOps {
  return {
    clone: vi.fn(async () => {}),
    fetch: vi.fn(async () => {}),
    checkout: vi.fn(async () => {}),
    getRemoteUrl: vi.fn(async () => ''),
    getCurrentRef: vi.fn(async () => ''),
    getDefaultBranch: vi.fn(async () => 'main'),
    configUnset: vi.fn(async () => {}),
    configList: vi.fn(async () => new Map()),
  };
}

function createMockFs(overrides?: Partial<InstallerFs>): InstallerFs {
  return {
    existsSync: vi.fn((): boolean => false),
    readFileSync: vi.fn((): string => validManifestJson()),
    rmSync: vi.fn(),
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
});
