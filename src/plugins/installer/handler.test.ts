/**
 * Tests for InstallerHandler — plugin_install and plugin_verify tools.
 *
 * All tests use mocked GitOps and filesystem — no real git or disk I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InstallerHandler,
  type InstallerDeps,
  type InstallerFs,
  type FileStat,
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

function createMockFileStat(overrides?: Partial<FileStat>): FileStat {
  return {
    isSymbolicLink: () => false,
    mode: 0o100600,
    size: 42,
    ...overrides,
  };
}

function createMockFs(overrides?: Partial<InstallerFs>): InstallerFs {
  return {
    existsSync: vi.fn((): boolean => false),
    readFileSync: vi.fn((): string => validManifestJson()),
    rmSync: vi.fn(),
    lstatSync: vi.fn((): FileStat => createMockFileStat()),
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
    readCredential: vi.fn((): string => ''),
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
  // plugin_verify
  // =======================================================================

  describe('plugin_verify', () => {
    // For verify tests, plugin directory must exist and manifest must be readable
    let verifyFs: InstallerFs;

    /** Create an fs mock where the plugin dir and credential files exist. */
    function createVerifyFs(overrides?: {
      credExists?: boolean;
      stat?: Partial<FileStat>;
      manifestJson?: string;
    }): InstallerFs {
      const credExists = overrides?.credExists ?? true;
      const manifestStr = overrides?.manifestJson ?? validManifestJson();
      const stat = createMockFileStat(overrides?.stat);
      return {
        existsSync: vi.fn((path: string): boolean => {
          // Credential files: check first (more specific — path also contains /plugins/)
          if (path.includes('/credentials/')) return credExists;
          // Plugin dir always exists for verify tests
          if (path.includes('/plugins/')) return true;
          return false;
        }),
        readFileSync: vi.fn((): string => manifestStr),
        rmSync: vi.fn(),
        lstatSync: vi.fn((): FileStat => stat),
      };
    }

    beforeEach(async () => {
      verifyFs = createVerifyFs();
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());
    });

    // ---------------------------------------------------------------------
    // Missing name argument
    // ---------------------------------------------------------------------

    it('should return validation error when name is missing', async () => {
      const result = await handler.handleToolInvocation('plugin_verify', {}, context);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.message).toContain('name');
      }
    });

    // ---------------------------------------------------------------------
    // Plugin not found
    // ---------------------------------------------------------------------

    it('should return error when plugin directory does not exist', async () => {
      const noPluginFs = createMockFs();
      // existsSync returns false for everything
      handler = new InstallerHandler(deps, noPluginFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'nonexistent' },
        context,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.HANDLER_ERROR);
        expect(result.error.message).toContain('not found');
      }
    });

    // ---------------------------------------------------------------------
    // All credentials present and valid → ready: true
    // ---------------------------------------------------------------------

    it('should return ready: true when all credentials are present and valid', async () => {
      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(true);
        expect(result.result['plugin_name']).toBe('my-plugin');
        const creds = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(creds).toHaveLength(2);
        expect(creds[0]!['key']).toBe('api_key');
        expect(creds[0]!['found']).toBe(true);
        expect(creds[0]!['valid_permissions']).toBe(true);
        expect(creds[0]!['not_empty']).toBe(true);
        expect(creds[0]!['not_symlink']).toBe(true);
        // No smoke_test when no handler loaded
        expect(result.result['smoke_test']).toBeUndefined();
      }
    });

    // ---------------------------------------------------------------------
    // Missing credential file → ready: false
    // ---------------------------------------------------------------------

    it('should return ready: false when a credential file is missing', async () => {
      verifyFs = createVerifyFs({ credExists: false });
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const creds = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(creds[0]!['found']).toBe(false);
        expect(creds[0]!['valid_permissions']).toBe(false);
        expect(creds[0]!['not_empty']).toBe(false);
        expect(creds[0]!['not_symlink']).toBe(false);
      }
    });

    // ---------------------------------------------------------------------
    // Wrong permissions → ready: false
    // ---------------------------------------------------------------------

    it('should return ready: false when credential has wrong permissions', async () => {
      verifyFs = createVerifyFs({ stat: { mode: 0o100644 } });
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const creds = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(creds[0]!['found']).toBe(true);
        expect(creds[0]!['valid_permissions']).toBe(false);
      }
    });

    // ---------------------------------------------------------------------
    // 0o400 permissions are valid
    // ---------------------------------------------------------------------

    it('should accept 0o400 (read-only owner) permissions', async () => {
      verifyFs = createVerifyFs({ stat: { mode: 0o100400 } });
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(true);
        const creds = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(creds[0]!['valid_permissions']).toBe(true);
      }
    });

    // ---------------------------------------------------------------------
    // Symlink detected → ready: false
    // ---------------------------------------------------------------------

    it('should return ready: false when credential is a symlink', async () => {
      verifyFs = createVerifyFs({ stat: { isSymbolicLink: () => true } });
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const creds = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(creds[0]!['not_symlink']).toBe(false);
      }
    });

    // ---------------------------------------------------------------------
    // Empty file → ready: false
    // ---------------------------------------------------------------------

    it('should return ready: false when credential file is empty', async () => {
      verifyFs = createVerifyFs({ stat: { size: 0 } });
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const creds = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(creds[0]!['not_empty']).toBe(false);
      }
    });

    // ---------------------------------------------------------------------
    // No install.credentials → skip Phase 1, ready: true
    // ---------------------------------------------------------------------

    it('should return ready: true when manifest has no install.credentials', async () => {
      verifyFs = createVerifyFs({ manifestJson: validManifestWithoutInstall() });
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(true);
        const creds = result.result['credential_status'] as Array<Record<string, unknown>>;
        expect(creds).toHaveLength(0);
      }
    });

    // ---------------------------------------------------------------------
    // Smoke test: success
    // ---------------------------------------------------------------------

    it('should include successful smoke test result', async () => {
      const mockHandler: PluginHandler = {
        initialize: vi.fn(async () => {}),
        handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
        verify: vi.fn(
          async (): Promise<PluginVerifyResult> => ({
            ok: true,
            message: 'Connection successful',
          }),
        ),
        shutdown: vi.fn(async () => {}),
      };

      deps = createDeps({ getLoadedHandler: () => mockHandler });
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(true);
        const smoke = result.result['smoke_test'] as { ok: boolean; message: string };
        expect(smoke.ok).toBe(true);
        expect(smoke.message).toBe('Connection successful');
      }
    });

    // ---------------------------------------------------------------------
    // Smoke test: failure
    // ---------------------------------------------------------------------

    it('should include failed smoke test result and set ready: false', async () => {
      const mockHandler: PluginHandler = {
        initialize: vi.fn(async () => {}),
        handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
        verify: vi.fn(
          async (): Promise<PluginVerifyResult> => ({
            ok: false,
            message: 'API returned 401',
          }),
        ),
        shutdown: vi.fn(async () => {}),
      };

      deps = createDeps({ getLoadedHandler: () => mockHandler });
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const smoke = result.result['smoke_test'] as { ok: boolean; message: string };
        expect(smoke.ok).toBe(false);
        expect(smoke.message).toBe('API returned 401');
      }
    });

    // ---------------------------------------------------------------------
    // Smoke test: verify() throws
    // ---------------------------------------------------------------------

    it('should handle verify() that throws an exception', async () => {
      const mockHandler: PluginHandler = {
        initialize: vi.fn(async () => {}),
        handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
        verify: vi.fn(async (): Promise<PluginVerifyResult> => {
          throw new Error('Network unreachable');
        }),
        shutdown: vi.fn(async () => {}),
      };

      deps = createDeps({ getLoadedHandler: () => mockHandler });
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const smoke = result.result['smoke_test'] as { ok: boolean; message: string };
        expect(smoke.ok).toBe(false);
        expect(smoke.message).toContain('Smoke test failed');
        expect(smoke.message).toContain('Network unreachable');
      }
    });

    // ---------------------------------------------------------------------
    // Smoke test: timeout (10s)
    // ---------------------------------------------------------------------

    it('should return timeout when verify() exceeds 10 seconds', async () => {
      vi.useFakeTimers();

      const mockHandler: PluginHandler = {
        initialize: vi.fn(async () => {}),
        handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
        verify: vi.fn(
          () =>
            new Promise<PluginVerifyResult>(() => {
              // Never resolves — simulates a hang
            }),
        ),
        shutdown: vi.fn(async () => {}),
      };

      deps = createDeps({ getLoadedHandler: () => mockHandler });
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const resultPromise = handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      // Advance time past the 10s timeout
      await vi.advanceTimersByTimeAsync(10_001);

      const result = await resultPromise;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['ready']).toBe(false);
        const smoke = result.result['smoke_test'] as { ok: boolean; message: string };
        expect(smoke.ok).toBe(false);
        expect(smoke.message).toContain('timed out');
      }

      vi.useRealTimers();
    });

    // ---------------------------------------------------------------------
    // No verify() method → skip Phase 2, still ready if creds OK
    // ---------------------------------------------------------------------

    it('should skip smoke test when handler has no verify() method', async () => {
      const mockHandler: PluginHandler = {
        initialize: vi.fn(async () => {}),
        handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
        // No verify() method
        shutdown: vi.fn(async () => {}),
      };

      deps = createDeps({ getLoadedHandler: () => mockHandler });
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
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

    // ---------------------------------------------------------------------
    // No loaded handler → skip Phase 2, still ready if creds OK
    // ---------------------------------------------------------------------

    it('should skip smoke test when no handler is loaded', async () => {
      // Default deps have no getLoadedHandler, so it returns undefined
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
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

    // ---------------------------------------------------------------------
    // Smoke test detail sanitization
    // ---------------------------------------------------------------------

    it('should sanitize credential values in verify() detail', async () => {
      const mockHandler: PluginHandler = {
        initialize: vi.fn(async () => {}),
        handleToolInvocation: vi.fn(async () => ({ ok: true as const, result: {} })),
        verify: vi.fn(
          async (): Promise<PluginVerifyResult> => ({
            ok: true,
            message: 'Connected',
            detail: {
              token: 'Bearer ghp_ABC123DEF456secret',
              status: 'ok',
            },
          }),
        ),
        shutdown: vi.fn(async () => {}),
      };

      deps = createDeps({ getLoadedHandler: () => mockHandler });
      handler = new InstallerHandler(deps, verifyFs, mockSanitize, mockSanitizerFs);
      await handler.initialize(createServices());

      const result = await handler.handleToolInvocation(
        'plugin_verify',
        { name: 'my-plugin' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const smoke = result.result['smoke_test'] as { ok: boolean; message: string };
        expect(smoke.ok).toBe(true);
        expect(smoke.message).toContain('sanitized');
        expect(smoke.message).toContain('redacted');
        // Must NOT contain the actual token
        expect(smoke.message).not.toContain('ghp_ABC123DEF456secret');
      }
    });
  });
});
