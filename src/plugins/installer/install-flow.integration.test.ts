/**
 * Integration tests for the full plugin install/verify/update/remove lifecycle.
 *
 * Uses real git repos (local bare repos via file:// URLs), real filesystem,
 * and real sanitization — no mocks. A test-only LocalGitOps adapter allows
 * file:// URLs that production RealGitOps rejects.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { InstallerHandler, type InstallerDeps } from './handler.js';
import type { GitOps, CloneOptions } from './git-ops.js';
import { RealGitOps } from './git-ops.js';
import type { CoreServices, PluginContext } from '../../core/plugin-handler.js';
import { createPluginRepo, updatePluginRepo } from '../../testing/fixtures/create-plugin-repo.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// LocalGitOps — test adapter that allows file:// URLs
// ---------------------------------------------------------------------------

/**
 * A GitOps implementation for integration tests that allows file:// URLs.
 * Production RealGitOps rejects file:// for security. This adapter bypasses
 * URL validation for clone but delegates all other operations to RealGitOps.
 */
class LocalGitOps implements GitOps {
  private readonly real = new RealGitOps();

  async clone(url: string, destDir: string, opts?: CloneOptions): Promise<void> {
    // Skip URL validation for file:// — go straight to git clone
    const depth = opts?.depth ?? 1;
    const singleBranch = opts?.singleBranch ?? true;

    const args: string[] = [
      'clone',
      `--depth=${depth}`,
      '--config',
      'core.hooksPath=/dev/null',
      '--config',
      'core.symlinks=false',
    ];

    if (singleBranch) {
      args.push('--single-branch');
    }

    if (opts?.branch) {
      args.push('--branch', opts.branch);
    }

    args.push(url, destDir);

    await execFile('git', args, { timeout: 60_000, maxBuffer: 1024 * 1024 });
  }

  async fetch(repoDir: string): Promise<void> {
    return this.real.fetch(repoDir);
  }

  async checkout(repoDir: string, ref: string): Promise<void> {
    return this.real.checkout(repoDir, ref);
  }

  async getRemoteUrl(repoDir: string): Promise<string> {
    return this.real.getRemoteUrl(repoDir);
  }

  async getCurrentRef(repoDir: string): Promise<string> {
    return this.real.getCurrentRef(repoDir);
  }

  async getDefaultBranch(repoDir: string): Promise<string> {
    return this.real.getDefaultBranch(repoDir);
  }

  async configUnset(repoDir: string, key: string): Promise<void> {
    // Use --local to only unset from repo-local config.
    // Ignore errors when key doesn't exist in local config (exit code 5).
    try {
      await execFile('git', ['config', '--local', '--unset', key], {
        cwd: repoDir,
        timeout: 60_000,
      });
    } catch {
      // Key may not exist in local config — that's fine
    }
  }

  async configList(repoDir: string): Promise<Map<string, string>> {
    // Use --local to only list repo-local config, avoiding system/global
    // keys like credential.helper that can't be unset locally.
    const { stdout } = await execFile('git', ['config', '--local', '--list'], {
      cwd: repoDir,
      timeout: 60_000,
    });
    const result = new Map<string, string>();

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const configKey = trimmed.substring(0, eqIdx);
      const value = trimmed.substring(eqIdx + 1);
      result.set(configKey, value);
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Valid manifest fixtures
// ---------------------------------------------------------------------------

function validManifestWithCreds(): Record<string, unknown> {
  return {
    description: 'A test plugin with credentials',
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
          key: 'API_KEY',
          description: 'The API key for the service',
          required: true,
          obtain_url: 'https://example.com/keys',
        },
      ],
    },
  };
}

function validManifestNoCreds(): Record<string, unknown> {
  return {
    description: 'A plugin without credentials',
    version: '1.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Test Author' },
    provides: {
      channels: [],
      tools: [
        {
          name: 'simple_tool',
          description: 'A simple tool',
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
  };
}

function invalidManifest(): Record<string, unknown> {
  // Missing required fields: version, app_compat, author, provides, subscribes
  return {
    description: 'This manifest is incomplete',
  };
}

function updatedManifestWithCreds(): Record<string, unknown> {
  return {
    description: 'A test plugin with credentials (updated)',
    version: '2.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Test Author' },
    provides: {
      channels: [],
      tools: [
        {
          name: 'test_tool',
          description: 'A test tool (updated)',
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
          key: 'API_KEY',
          description: 'The API key for the service',
          required: true,
          obtain_url: 'https://example.com/keys',
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
    getAuditLog: async () => [],
    getToolCatalog: () => [],
    getSessionInfo: () => ({ group: '', sessionId: '', startedAt: '' }),
    readCredential: () => '',
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('InstallerHandler integration tests', () => {
  let rootTmpDir: string;
  let pluginsDir: string;
  let credentialsDir: string;
  let carapaceHome: string;
  let gitOps: LocalGitOps;
  let handler: InstallerHandler;
  let context: PluginContext;

  beforeEach(async () => {
    rootTmpDir = mkdtempSync(join(tmpdir(), 'carapace-integ-'));
    pluginsDir = join(rootTmpDir, 'plugins');
    credentialsDir = join(rootTmpDir, 'credentials', 'plugins');
    carapaceHome = rootTmpDir;
    mkdirSync(pluginsDir, { recursive: true });
    mkdirSync(credentialsDir, { recursive: true });

    gitOps = new LocalGitOps();
    context = createContext();

    const deps: InstallerDeps = {
      pluginsDir,
      credentialsDir,
      carapaceHome,
      gitOps,
      reservedNames: new Set(['installer', 'memory']),
    };

    handler = new InstallerHandler(deps);
    await handler.initialize(createServices());
  });

  afterEach(() => {
    // Clean up temp directories -- use rmSync for simplicity
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(rootTmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: Install -> Verify (missing) -> Create creds -> Verify (ready)
  // -------------------------------------------------------------------------

  it('should install, verify missing creds, add creds, then verify ready', async () => {
    // Build fixture repo
    const repoTmpDir = mkdtempSync(join(tmpdir(), 'repo-'));
    const bareDir = await createPluginRepo(repoTmpDir, {
      manifest: validManifestWithCreds(),
    });
    const repoUrl = `file://${bareDir}`;

    // Step 1: Install
    const installResult = await handler.handleToolInvocation(
      'plugin_install',
      { url: repoUrl, name: 'test-plugin' },
      context,
    );

    expect(installResult.ok).toBe(true);
    if (!installResult.ok) return;
    expect(installResult.result['plugin_name']).toBe('test-plugin');
    expect(installResult.result['version']).toBe('1.0.0');
    expect(installResult.result['tools']).toEqual(['test_tool']);

    const credsNeeded = installResult.result['credentials_needed'] as Array<
      Record<string, unknown>
    >;
    expect(credsNeeded).toHaveLength(1);
    expect(credsNeeded[0]!['key']).toBe('API_KEY');

    // Step 2: Verify — should show ready: false (credential file missing)
    const verifyMissing = await handler.handleToolInvocation(
      'plugin_verify',
      { name: 'test-plugin' },
      context,
    );

    expect(verifyMissing.ok).toBe(true);
    if (!verifyMissing.ok) return;
    expect(verifyMissing.result['ready']).toBe(false);
    const credStatus1 = verifyMissing.result['credential_status'] as Array<Record<string, unknown>>;
    expect(credStatus1[0]!['ok']).toBe(false);
    expect(credStatus1[0]!['error']).toBe('File not found');

    // Step 3: Create credential files at the expected path with correct perms
    const credDir = join(credentialsDir, 'test-plugin');
    mkdirSync(credDir, { recursive: true });
    const credPath = join(credDir, 'API_KEY');
    writeFileSync(credPath, 'sk-test-key-12345', 'utf-8');
    chmodSync(credPath, 0o600);

    // Step 4: Verify again — should show ready: true
    const verifyReady = await handler.handleToolInvocation(
      'plugin_verify',
      { name: 'test-plugin' },
      context,
    );

    expect(verifyReady.ok).toBe(true);
    if (!verifyReady.ok) return;
    expect(verifyReady.result['ready']).toBe(true);
    const credStatus2 = verifyReady.result['credential_status'] as Array<Record<string, unknown>>;
    expect(credStatus2[0]!['ok']).toBe(true);

    // Cleanup fixture
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(repoTmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 2: Install -> Update -> Verify
  // -------------------------------------------------------------------------

  it('should install, update with new version, and show version change', async () => {
    // Build fixture repo
    const repoTmpDir = mkdtempSync(join(tmpdir(), 'repo-'));
    const bareDir = await createPluginRepo(repoTmpDir, {
      manifest: validManifestWithCreds(),
    });
    const repoUrl = `file://${bareDir}`;

    // Step 1: Install
    const installResult = await handler.handleToolInvocation(
      'plugin_install',
      { url: repoUrl, name: 'updatable-plugin' },
      context,
    );

    expect(installResult.ok).toBe(true);
    if (!installResult.ok) return;
    expect(installResult.result['version']).toBe('1.0.0');

    // Step 2: Push an update to the fixture repo (new version in manifest)
    await updatePluginRepo(repoTmpDir, bareDir, updatedManifestWithCreds());

    // Step 3: Update the plugin
    const updateResult = await handler.handleToolInvocation(
      'plugin_update',
      { name: 'updatable-plugin' },
      context,
    );

    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;
    expect(updateResult.result['old_version']).toBe('1.0.0');
    expect(updateResult.result['new_version']).toBe('2.0.0');
    expect(updateResult.result['requires_restart']).toBe(true);

    // Cleanup fixture
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(repoTmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 3: Install -> Remove -> Verify (not found)
  // -------------------------------------------------------------------------

  it('should install, remove, then verify returns not found', async () => {
    // Build fixture repo
    const repoTmpDir = mkdtempSync(join(tmpdir(), 'repo-'));
    const bareDir = await createPluginRepo(repoTmpDir, {
      manifest: validManifestNoCreds(),
    });
    const repoUrl = `file://${bareDir}`;

    // Step 1: Install
    const installResult = await handler.handleToolInvocation(
      'plugin_install',
      { url: repoUrl, name: 'removable-plugin' },
      context,
    );

    expect(installResult.ok).toBe(true);
    if (!installResult.ok) return;

    // Verify the plugin directory exists
    expect(existsSync(join(pluginsDir, 'removable-plugin'))).toBe(true);

    // Step 2: Remove
    const removeResult = await handler.handleToolInvocation(
      'plugin_remove',
      { name: 'removable-plugin' },
      context,
    );

    expect(removeResult.ok).toBe(true);
    if (!removeResult.ok) return;
    expect(removeResult.result['removed']).toBe('removable-plugin');

    // Verify directory is gone
    expect(existsSync(join(pluginsDir, 'removable-plugin'))).toBe(false);

    // Step 3: Verify should return error (plugin not found)
    const verifyResult = await handler.handleToolInvocation(
      'plugin_verify',
      { name: 'removable-plugin' },
      context,
    );

    expect(verifyResult.ok).toBe(false);
    if (verifyResult.ok) return;
    expect(verifyResult.error.message).toContain('not found');

    // Cleanup fixture
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(repoTmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 4: Install with name conflict -> error
  // -------------------------------------------------------------------------

  it('should reject installing a second plugin with the same name', async () => {
    // Build two fixture repos
    const repoTmpDir1 = mkdtempSync(join(tmpdir(), 'repo1-'));
    const bareDir1 = await createPluginRepo(repoTmpDir1, {
      manifest: validManifestNoCreds(),
    });

    const repoTmpDir2 = mkdtempSync(join(tmpdir(), 'repo2-'));
    const bareDir2 = await createPluginRepo(repoTmpDir2, {
      manifest: validManifestWithCreds(),
    });

    // Step 1: Install first plugin
    const installResult1 = await handler.handleToolInvocation(
      'plugin_install',
      { url: `file://${bareDir1}`, name: 'conflict-plugin' },
      context,
    );

    expect(installResult1.ok).toBe(true);

    // Step 2: Try installing another plugin with the same name
    const installResult2 = await handler.handleToolInvocation(
      'plugin_install',
      { url: `file://${bareDir2}`, name: 'conflict-plugin' },
      context,
    );

    expect(installResult2.ok).toBe(false);
    if (installResult2.ok) return;
    expect(installResult2.error.message).toContain('already exists');

    // Cleanup
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(repoTmpDir1, { recursive: true, force: true });
    rmSync(repoTmpDir2, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 5: Install invalid manifest -> cleanup
  // -------------------------------------------------------------------------

  it('should reject install of invalid manifest and leave no partial directory', async () => {
    // Build fixture repo with invalid manifest
    const repoTmpDir = mkdtempSync(join(tmpdir(), 'repo-'));
    const bareDir = await createPluginRepo(repoTmpDir, {
      manifest: invalidManifest(),
    });
    const repoUrl = `file://${bareDir}`;

    // Step 1: Install — should fail
    const installResult = await handler.handleToolInvocation(
      'plugin_install',
      { url: repoUrl, name: 'invalid-plugin' },
      context,
    );

    expect(installResult.ok).toBe(false);
    if (installResult.ok) return;
    expect(installResult.error.message).toContain('Invalid manifest');

    // Step 2: Verify no partial directory remains
    expect(existsSync(join(pluginsDir, 'invalid-plugin'))).toBe(false);

    // Cleanup fixture
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(repoTmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 6: Install -> List -> shows plugin
  // -------------------------------------------------------------------------

  it('should list an installed plugin after install', async () => {
    // Build fixture repo
    const repoTmpDir = mkdtempSync(join(tmpdir(), 'repo-'));
    const bareDir = await createPluginRepo(repoTmpDir, {
      manifest: validManifestNoCreds(),
    });
    const repoUrl = `file://${bareDir}`;

    // Install
    const installResult = await handler.handleToolInvocation(
      'plugin_install',
      { url: repoUrl, name: 'listed-plugin' },
      context,
    );
    expect(installResult.ok).toBe(true);

    // List
    const listResult = await handler.handleToolInvocation('plugin_list', {}, context);

    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const plugins = listResult.result['plugins'] as Array<Record<string, unknown>>;
    expect(plugins.length).toBeGreaterThanOrEqual(1);
    const found = plugins.find((p) => p['name'] === 'listed-plugin');
    expect(found).toBeDefined();
    expect(found!['version']).toBe('1.0.0');
    expect(found!['installed_via_git']).toBe(true);

    // Cleanup fixture
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(repoTmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 7: Verify plugin with no creds required -> ready: true immediately
  // -------------------------------------------------------------------------

  it('should verify ready: true for plugin with no credential requirements', async () => {
    // Build fixture repo
    const repoTmpDir = mkdtempSync(join(tmpdir(), 'repo-'));
    const bareDir = await createPluginRepo(repoTmpDir, {
      manifest: validManifestNoCreds(),
    });
    const repoUrl = `file://${bareDir}`;

    // Install
    const installResult = await handler.handleToolInvocation(
      'plugin_install',
      { url: repoUrl, name: 'nocreds-plugin' },
      context,
    );
    expect(installResult.ok).toBe(true);

    // Verify — should immediately be ready since no creds required
    const verifyResult = await handler.handleToolInvocation(
      'plugin_verify',
      { name: 'nocreds-plugin' },
      context,
    );

    expect(verifyResult.ok).toBe(true);
    if (!verifyResult.ok) return;
    expect(verifyResult.result['ready']).toBe(true);
    const credStatus = verifyResult.result['credential_status'] as Array<Record<string, unknown>>;
    expect(credStatus).toHaveLength(0);

    // Cleanup fixture
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(repoTmpDir, { recursive: true, force: true });
  });
});
