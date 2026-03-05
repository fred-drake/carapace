import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkNodeVersion,
  checkContainerRuntime,
  checkPnpm,
  checkZeromq,
  checkSqlite,
  checkPluginDirs,
  checkSocketPath,
  checkSocketPermissions,
  checkStaleSockets,
  checkSocketPathLength,
  checkImageVersion,
  checkPlugins,
  runAllChecks,
  runLiveVerification,
  type HealthCheckResult,
  type HealthCheckDeps,
} from './health-checks.js';
import { MockContainerRuntime } from './container/mock-runtime.js';
import type { PluginHandler, PluginLoadResult, PluginSource } from './plugin-handler.js';
import type { DiscoveredPlugin } from './plugin-loader.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createTestDeps(overrides?: Partial<HealthCheckDeps>): HealthCheckDeps {
  return {
    nodeVersion: 'v22.5.0',
    runtimes: [new MockContainerRuntime('docker')],
    exec: async () => ({ stdout: '10.0.0\n', stderr: '' }),
    resolveModule: () => '/path/to/module',
    pluginDirs: [],
    socketPath: '/run/sockets',
    dirExists: () => true,
    isWritable: () => true,
    fileMode: () => 0o40700,
    listDir: () => [],
    platform: 'linux',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkNodeVersion
// ---------------------------------------------------------------------------

describe('checkNodeVersion', () => {
  it('passes for Node.js 22+', () => {
    const result = checkNodeVersion('v22.5.0');
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('22.5.0');
  });

  it('passes for Node.js 23', () => {
    const result = checkNodeVersion('v23.0.0');
    expect(result.status).toBe('pass');
  });

  it('fails for Node.js 20', () => {
    const result = checkNodeVersion('v20.1.0');
    expect(result.status).toBe('fail');
    expect(result.fix).toBeDefined();
    expect(result.fix).toMatch(/22/);
  });

  it('fails for unparseable version', () => {
    const result = checkNodeVersion('unknown');
    expect(result.status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// checkContainerRuntime
// ---------------------------------------------------------------------------

describe('checkContainerRuntime', () => {
  it('passes when a runtime is available', async () => {
    const rt = new MockContainerRuntime('docker');
    const result = await checkContainerRuntime([rt]);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('docker');
  });

  it('passes with version info', async () => {
    const rt = new MockContainerRuntime('docker');
    const result = await checkContainerRuntime([rt]);
    expect(result.detail).toContain('Mock docker');
  });

  it('fails when no runtimes are available', async () => {
    const rt = new MockContainerRuntime('docker');
    rt.setAvailable(false);
    const result = await checkContainerRuntime([rt]);
    expect(result.status).toBe('fail');
    expect(result.fix).toBeDefined();
    expect(result.fix).toMatch(/docker|podman/i);
  });

  it('skips broken runtimes and finds the next', async () => {
    const broken = new MockContainerRuntime('docker');
    broken.setAvailableError(new Error('daemon not running'));
    const working = new MockContainerRuntime('podman');

    const result = await checkContainerRuntime([broken, working]);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('podman');
  });
});

// ---------------------------------------------------------------------------
// checkPnpm
// ---------------------------------------------------------------------------

describe('checkPnpm', () => {
  it('passes when pnpm is available', async () => {
    const exec = async () => ({ stdout: '10.28.0\n', stderr: '' });
    const result = await checkPnpm(exec);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('10.28.0');
  });

  it('fails when pnpm is not found', async () => {
    const exec = async () => {
      throw new Error('command not found: pnpm');
    };
    const result = await checkPnpm(exec);
    expect(result.status).toBe('fail');
    expect(result.fix).toMatch(/npm install.*pnpm/i);
  });
});

// ---------------------------------------------------------------------------
// checkZeromq
// ---------------------------------------------------------------------------

describe('checkZeromq', () => {
  it('passes when zeromq can be resolved', () => {
    const result = checkZeromq(() => '/path/to/zeromq/index.js');
    expect(result.status).toBe('pass');
  });

  it('fails when zeromq cannot be resolved', () => {
    const result = checkZeromq(() => {
      throw new Error('Cannot find module');
    });
    expect(result.status).toBe('fail');
    expect(result.fix).toMatch(/zeromq|zmq/i);
  });
});

// ---------------------------------------------------------------------------
// checkSqlite
// ---------------------------------------------------------------------------

describe('checkSqlite', () => {
  it('passes when better-sqlite3 can be resolved', () => {
    const result = checkSqlite(() => '/path/to/better-sqlite3/index.js');
    expect(result.status).toBe('pass');
  });

  it('fails when better-sqlite3 cannot be resolved', () => {
    const result = checkSqlite(() => {
      throw new Error('Cannot find module');
    });
    expect(result.status).toBe('fail');
    expect(result.fix).toMatch(/better-sqlite3|sqlite/i);
  });
});

// ---------------------------------------------------------------------------
// checkPluginDirs
// ---------------------------------------------------------------------------

describe('checkPluginDirs', () => {
  it('passes when all plugin directories exist', () => {
    const result = checkPluginDirs(['/plugins/core', '/plugins/user'], (p) => p.length > 0);
    expect(result.status).toBe('pass');
  });

  it('passes with empty dirs list', () => {
    const result = checkPluginDirs([], () => true);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('no extra');
  });

  it('fails when a plugin directory does not exist', () => {
    const result = checkPluginDirs(
      ['/plugins/core', '/plugins/missing'],
      (p) => p === '/plugins/core',
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('/plugins/missing');
    expect(result.fix).toMatch(/create|mkdir/i);
  });
});

// ---------------------------------------------------------------------------
// checkSocketPath
// ---------------------------------------------------------------------------

describe('checkSocketPath', () => {
  it('passes when socket directory is writable', () => {
    const result = checkSocketPath('/run/sockets', () => true);
    expect(result.status).toBe('pass');
  });

  it('fails when socket directory is not writable', () => {
    const result = checkSocketPath('/run/sockets', () => false);
    expect(result.status).toBe('fail');
    expect(result.fix).toMatch(/permissions|chmod/i);
  });
});

// ---------------------------------------------------------------------------
// checkSocketPermissions
// ---------------------------------------------------------------------------

describe('checkSocketPermissions', () => {
  it('passes when permissions are 0700', () => {
    const result = checkSocketPermissions('/run/sockets', () => 0o40700);
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('700');
  });

  it('fails when permissions are too open (0755)', () => {
    const result = checkSocketPermissions('/run/sockets', () => 0o40755);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('755');
    expect(result.fix).toMatch(/chmod 700/);
  });

  it('fails when permissions are 0777', () => {
    const result = checkSocketPermissions('/run/sockets', () => 0o40777);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('777');
  });

  it('warns when permissions cannot be read', () => {
    const result = checkSocketPermissions('/run/sockets', () => null);
    expect(result.status).toBe('warn');
    expect(result.fix).toMatch(/mkdir/);
  });
});

// ---------------------------------------------------------------------------
// checkStaleSockets
// ---------------------------------------------------------------------------

describe('checkStaleSockets', () => {
  it('passes when no socket files exist', () => {
    const result = checkStaleSockets('/run/sockets', () => []);
    expect(result.status).toBe('pass');
  });

  it('passes when directory has non-sock files', () => {
    const result = checkStaleSockets('/run/sockets', () => ['readme.txt', '.gitkeep']);
    expect(result.status).toBe('pass');
  });

  it('warns when stale socket files are found', () => {
    const result = checkStaleSockets('/run/sockets', () => [
      'server-request.sock',
      'server-events.sock',
    ]);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('2 stale');
    expect(result.fix).toMatch(/rm/);
  });

  it('includes socket filenames in detail', () => {
    const result = checkStaleSockets('/run/sockets', () => ['old-session-request.sock']);
    expect(result.detail).toContain('old-session-request.sock');
  });
});

// ---------------------------------------------------------------------------
// checkSocketPathLength
// ---------------------------------------------------------------------------

describe('checkSocketPathLength', () => {
  it('passes for short paths on linux', () => {
    const result = checkSocketPathLength('/run/sockets', 'linux');
    expect(result.status).toBe('pass');
  });

  it('passes for short paths on darwin', () => {
    const result = checkSocketPathLength('/run/sockets', 'darwin');
    expect(result.status).toBe('pass');
  });

  it('fails for very long paths on darwin (104-byte limit)', () => {
    const longPath = '/a'.repeat(60);
    const result = checkSocketPathLength(longPath, 'darwin');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('104');
    expect(result.fix).toMatch(/shorter path/i);
  });

  it('includes platform in detail', () => {
    const result = checkSocketPathLength('/run/sockets', 'darwin');
    expect(result.detail).toContain('darwin');
  });
});

// ---------------------------------------------------------------------------
// runAllChecks
// ---------------------------------------------------------------------------

describe('runAllChecks', () => {
  it('returns results for all checks', async () => {
    const results = await runAllChecks(createTestDeps());
    expect(results.length).toBeGreaterThanOrEqual(7);
  });

  it('all checks pass with good deps', async () => {
    const results = await runAllChecks(createTestDeps());
    const failed = results.filter((r) => r.status === 'fail');
    expect(failed).toHaveLength(0);
  });

  it('reports failures without crashing on other checks', async () => {
    const results = await runAllChecks(
      createTestDeps({
        nodeVersion: 'v18.0.0',
        exec: async () => {
          throw new Error('not found');
        },
      }),
    );

    const nodeCheck = results.find((r) => r.name === 'node-version');
    const pnpmCheck = results.find((r) => r.name === 'pnpm');
    expect(nodeCheck!.status).toBe('fail');
    expect(pnpmCheck!.status).toBe('fail');

    // Other checks should still be present
    const runtimeCheck = results.find((r) => r.name === 'container-runtime');
    expect(runtimeCheck!.status).toBe('pass');
  });

  it('each result has name and status', async () => {
    const results = await runAllChecks(createTestDeps());
    for (const result of results) {
      expect(result.name).toBeDefined();
      expect(result.name.length).toBeGreaterThan(0);
      expect(['pass', 'fail', 'warn']).toContain(result.status);
    }
  });

  it('failed results include fix suggestions', async () => {
    const results = await runAllChecks(
      createTestDeps({
        nodeVersion: 'v18.0.0',
        isWritable: () => false,
      }),
    );
    const failures = results.filter((r) => r.status === 'fail');
    for (const f of failures) {
      expect(f.fix).toBeDefined();
      expect(f.fix!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// checkImageVersion
// ---------------------------------------------------------------------------

describe('checkImageVersion', () => {
  it('passes when image is current', async () => {
    const deps = createTestDeps({
      inspectImageLabels: vi.fn().mockResolvedValue({
        'org.opencontainers.image.revision': 'abc1234',
        'org.opencontainers.image.version': '0.0.1',
        'ai.carapace.claude-code-version': '2.1.49',
        'org.opencontainers.image.created': '2026-02-20T00:00:00Z',
      }),
      resolveGitSha: vi.fn().mockResolvedValue('abc1234'),
      imageName: 'carapace:latest',
    });
    const results = await runAllChecks(deps);
    const check = results.find((r) => r.name === 'image-version');
    expect(check).toBeDefined();
    expect(check!.status).toBe('pass');
    expect(check!.detail).toContain('2.1.49');
  });

  it('warns when image is stale', async () => {
    const deps = createTestDeps({
      inspectImageLabels: vi.fn().mockResolvedValue({
        'org.opencontainers.image.revision': 'abc1234',
        'org.opencontainers.image.version': '0.0.1',
        'ai.carapace.claude-code-version': '2.1.49',
        'org.opencontainers.image.created': '2026-02-20T00:00:00Z',
      }),
      resolveGitSha: vi.fn().mockResolvedValue('def5678'),
      imageName: 'carapace:latest',
    });
    const results = await runAllChecks(deps);
    const check = results.find((r) => r.name === 'image-version');
    expect(check!.status).toBe('warn');
    expect(check!.detail).toContain('abc1234');
    expect(check!.detail).toContain('def5678');
  });

  it('fails when image not found', async () => {
    const deps = createTestDeps({
      inspectImageLabels: vi.fn().mockRejectedValue(new Error('not found')),
      resolveGitSha: vi.fn().mockResolvedValue('abc1234'),
      imageName: 'carapace:latest',
    });
    const results = await runAllChecks(deps);
    const check = results.find((r) => r.name === 'image-version');
    expect(check!.status).toBe('fail');
  });

  it('passes with not-configured when deps are missing', async () => {
    const deps = createTestDeps();
    const results = await runAllChecks(deps);
    const check = results.find((r) => r.name === 'image-version');
    expect(check!.status).toBe('pass');
    expect(check!.detail).toContain('not configured');
  });

  it('fails when image has empty labels', async () => {
    const deps = createTestDeps({
      inspectImageLabels: vi.fn().mockResolvedValue({}),
      resolveGitSha: vi.fn().mockResolvedValue('abc1234'),
      imageName: 'carapace:latest',
    });
    const results = await runAllChecks(deps);
    const check = results.find((r) => r.name === 'image-version');
    expect(check!.status).toBe('fail');
    expect(check!.detail).toContain('no version labels');
  });

  it('passes without staleness check when resolveGitSha is not configured', async () => {
    const deps = createTestDeps({
      inspectImageLabels: vi.fn().mockResolvedValue({
        'org.opencontainers.image.revision': 'abc1234',
        'ai.carapace.claude-code-version': '2.1.49',
      }),
      imageName: 'carapace:latest',
      // No resolveGitSha
    });
    const results = await runAllChecks(deps);
    const check = results.find((r) => r.name === 'image-version');
    expect(check!.status).toBe('pass');
    expect(check!.detail).toContain('2.1.49');
  });

  it('passes when resolveGitSha throws (git not available)', async () => {
    const deps = createTestDeps({
      inspectImageLabels: vi.fn().mockResolvedValue({
        'org.opencontainers.image.revision': 'abc1234',
        'ai.carapace.claude-code-version': '2.1.49',
      }),
      resolveGitSha: vi.fn().mockRejectedValue(new Error('git not found')),
      imageName: 'carapace:latest',
    });
    const results = await runAllChecks(deps);
    const check = results.find((r) => r.name === 'image-version');
    // Should still pass — can't check staleness but image has valid labels
    expect(check!.status).toBe('pass');
    expect(check!.detail).toContain('2.1.49');
  });

  it('includes fix suggestion when image is stale', async () => {
    const deps = createTestDeps({
      inspectImageLabels: vi.fn().mockResolvedValue({
        'org.opencontainers.image.revision': 'abc1234',
        'org.opencontainers.image.version': '0.0.1',
        'ai.carapace.claude-code-version': '2.1.49',
        'org.opencontainers.image.created': '2026-02-20T00:00:00Z',
      }),
      resolveGitSha: vi.fn().mockResolvedValue('def5678'),
      imageName: 'carapace:latest',
    });
    const results = await runAllChecks(deps);
    const check = results.find((r) => r.name === 'image-version');
    expect(check!.fix).toContain('carapace update');
  });
});

// ---------------------------------------------------------------------------
// checkPlugins
// ---------------------------------------------------------------------------

const VALID_MANIFEST = JSON.stringify({
  description: 'Test plugin',
  version: '1.0.0',
  app_compat: '>=0.1.0',
  author: { name: 'Test' },
  provides: { channels: [], tools: [] },
  subscribes: [],
});

const MANIFEST_WITH_TOOL = JSON.stringify({
  description: 'Plugin with tool',
  version: '0.2.0',
  app_compat: '>=0.1.0',
  author: { name: 'Test' },
  provides: {
    channels: [],
    tools: [
      {
        name: 'my_tool',
        description: 'A tool',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string' } },
        },
      },
    ],
  },
  subscribes: [],
});

const MANIFEST_WITH_CREDS = JSON.stringify({
  description: 'Plugin with creds',
  version: '0.1.0',
  app_compat: '>=0.1.0',
  author: { name: 'Test' },
  provides: { channels: [], tools: [] },
  subscribes: [],
  install: {
    credentials: [{ key: 'bot-token', description: 'Bot token', required: true }],
  },
});

const MANIFEST_WITH_OPTIONAL_CRED = JSON.stringify({
  description: 'Plugin with optional cred',
  version: '0.1.0',
  app_compat: '>=0.1.0',
  author: { name: 'Test' },
  provides: { channels: [], tools: [] },
  subscribes: [],
  install: {
    credentials: [
      { key: 'api-key', description: 'API key', required: true },
      { key: 'webhook-secret', description: 'Optional secret', required: false },
    ],
  },
});

describe('checkPlugins', () => {
  it('returns empty array when readFile is not provided (backward compat)', () => {
    const deps = createTestDeps();
    const results = checkPlugins(deps);
    expect(results).toEqual([]);
  });

  it('returns empty array when fileExists is not provided', () => {
    const deps = createTestDeps({ readFile: () => '' });
    const results = checkPlugins(deps);
    expect(results).toEqual([]);
  });

  it('passes for valid manifest with version and tool count', () => {
    const deps = createTestDeps({
      pluginDirs: ['/plugins'],
      listDir: (dir: string) => (dir === '/plugins' ? ['hello'] : []),
      readFile: () => MANIFEST_WITH_TOOL,
      fileExists: () => true,
    });
    const results = checkPlugins(deps);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pass');
    expect(results[0].detail).toContain('v0.2.0');
    expect(results[0].detail).toContain('1 tool');
  });

  it('reports correct plural for multiple tools', () => {
    const deps = createTestDeps({
      pluginDirs: ['/plugins'],
      listDir: (dir: string) => (dir === '/plugins' ? ['hello'] : []),
      readFile: () => VALID_MANIFEST,
      fileExists: () => true,
    });
    const results = checkPlugins(deps);
    expect(results[0].detail).toContain('0 tools');
  });

  it('fails for invalid JSON', () => {
    const deps = createTestDeps({
      pluginDirs: ['/plugins'],
      listDir: (dir: string) => (dir === '/plugins' ? ['bad'] : []),
      readFile: () => '{ not valid json',
      fileExists: () => true,
    });
    const results = checkPlugins(deps);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
    expect(results[0].detail).toContain('Invalid JSON');
  });

  it('fails for schema-invalid manifest', () => {
    const deps = createTestDeps({
      pluginDirs: ['/plugins'],
      listDir: (dir: string) => (dir === '/plugins' ? ['broken'] : []),
      readFile: () => JSON.stringify({ description: 'missing fields' }),
      fileExists: () => true,
    });
    const results = checkPlugins(deps);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
    expect(results[0].detail).toContain('Schema validation failed');
  });

  it('fails when required credential is missing', () => {
    const deps = createTestDeps({
      pluginDirs: ['/plugins'],
      credentialsPluginsDir: '/creds/plugins',
      listDir: (dir: string) => (dir === '/plugins' ? ['telegram'] : []),
      readFile: () => MANIFEST_WITH_CREDS,
      fileExists: (path: string) => {
        if (path.includes('bot-token')) return false;
        return true; // manifest.json exists
      },
    });
    const results = checkPlugins(deps);
    const credResult = results.find((r) => r.name === 'plugin-creds-telegram');
    expect(credResult).toBeDefined();
    expect(credResult!.status).toBe('fail');
    expect(credResult!.detail).toContain('bot-token');
    expect(credResult!.fix).toContain('/creds/plugins/telegram/bot-token');
  });

  it('passes when all credentials are present', () => {
    const deps = createTestDeps({
      pluginDirs: ['/plugins'],
      credentialsPluginsDir: '/creds/plugins',
      listDir: (dir: string) => (dir === '/plugins' ? ['telegram'] : []),
      readFile: () => MANIFEST_WITH_CREDS,
      fileExists: () => true,
    });
    const results = checkPlugins(deps);
    const credResult = results.find((r) => r.name === 'plugin-creds-telegram');
    expect(credResult).toBeDefined();
    expect(credResult!.status).toBe('pass');
    expect(credResult!.detail).toContain('1 credential present');
  });

  it('warns when optional credential is missing', () => {
    const deps = createTestDeps({
      pluginDirs: ['/plugins'],
      credentialsPluginsDir: '/creds/plugins',
      listDir: (dir: string) => (dir === '/plugins' ? ['svc'] : []),
      readFile: () => MANIFEST_WITH_OPTIONAL_CRED,
      fileExists: (path: string) => {
        if (path.includes('webhook-secret')) return false;
        return true;
      },
    });
    const results = checkPlugins(deps);
    const credResult = results.find((r) => r.name === 'plugin-creds-svc');
    expect(credResult).toBeDefined();
    expect(credResult!.status).toBe('warn');
    expect(credResult!.detail).toContain('webhook-secret');
  });

  it('does not emit credential result when no credentials declared', () => {
    const deps = createTestDeps({
      pluginDirs: ['/plugins'],
      credentialsPluginsDir: '/creds/plugins',
      listDir: (dir: string) => (dir === '/plugins' ? ['hello'] : []),
      readFile: () => VALID_MANIFEST,
      fileExists: () => true,
    });
    const results = checkPlugins(deps);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('plugin-hello');
  });

  it('skips non-existent plugin directory gracefully', () => {
    const deps = createTestDeps({
      pluginDirs: ['/nonexistent'],
      listDir: () => {
        throw new Error('ENOENT');
      },
      readFile: () => '',
      fileExists: () => false,
    });
    const results = checkPlugins(deps);
    expect(results).toEqual([]);
  });

  it('scans both pluginDirs and builtinPluginsDir', () => {
    const deps = createTestDeps({
      pluginDirs: ['/plugins'],
      builtinPluginsDir: '/builtin',
      listDir: (dir: string) => {
        if (dir === '/plugins') return ['user-plugin'];
        if (dir === '/builtin') return ['core-plugin'];
        return [];
      },
      readFile: () => VALID_MANIFEST,
      fileExists: () => true,
    });
    const results = checkPlugins(deps);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name)).toContain('plugin-user-plugin');
    expect(results.map((r) => r.name)).toContain('plugin-core-plugin');
  });

  it('runAllChecks includes plugin results when deps are wired', async () => {
    const deps = createTestDeps({
      pluginDirs: ['/plugins'],
      listDir: (dir: string) => (dir === '/plugins' ? ['test'] : []),
      readFile: () => VALID_MANIFEST,
      fileExists: () => true,
    });
    const results = await runAllChecks(deps);
    const pluginResult = results.find((r) => r.name === 'plugin-test');
    expect(pluginResult).toBeDefined();
    expect(pluginResult!.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// runLiveVerification
// ---------------------------------------------------------------------------

// Mock factories — set per test
let mockDiscovered: DiscoveredPlugin[] = [];
let mockLoadResults: PluginLoadResult[] = [];
let mockHandlers: Map<string, Partial<PluginHandler>> = new Map();
let mockShutdownAll: ReturnType<typeof vi.fn>;
let mockLoadPlugin: ReturnType<typeof vi.fn>;

vi.mock('./plugin-loader.js', () => ({
  PluginLoader: vi.fn().mockImplementation(() => ({
    loadAll: vi.fn(async () => mockLoadResults),
    discoverPlugins: vi.fn(async () => mockDiscovered),
    loadPlugin: vi.fn(async (...args: unknown[]) => mockLoadPlugin(...args)),
    getHandler: vi.fn((name: string) => mockHandlers.get(name)),
    shutdownAll: vi.fn(async () => mockShutdownAll()),
  })),
}));

vi.mock('./tool-catalog.js', () => ({
  ToolCatalog: vi.fn().mockImplementation(() => ({})),
}));

describe('runLiveVerification', () => {
  beforeEach(() => {
    mockDiscovered = [];
    mockLoadResults = [];
    mockHandlers = new Map();
    mockShutdownAll = vi.fn();
    mockLoadPlugin = vi.fn();
  });

  it('handler with verify() returning ok: true → PASS', async () => {
    const handler: Partial<PluginHandler> = {
      verify: vi.fn(async () => ({ ok: true, message: 'Bot @test is reachable' })),
    };
    mockLoadResults = [
      {
        ok: true as const,
        pluginName: 'telegram',
        manifest: JSON.parse(VALID_MANIFEST),
        handler: handler as PluginHandler,
        source: 'user' as PluginSource,
      },
    ];
    mockHandlers.set('telegram', handler);

    const results = await runLiveVerification({
      pluginsDir: '/plugins',
      credentialsPluginsDir: '/creds/plugins',
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pass');
    expect(results[0].detail).toBe('Bot @test is reachable');
    expect(results[0].name).toBe('live-telegram');
  });

  it('handler with verify() returning ok: false → FAIL', async () => {
    const handler: Partial<PluginHandler> = {
      verify: vi.fn(async () => ({ ok: false, message: '401 Unauthorized' })),
    };
    mockLoadResults = [
      {
        ok: true as const,
        pluginName: 'telegram',
        manifest: JSON.parse(VALID_MANIFEST),
        handler: handler as PluginHandler,
        source: 'user' as PluginSource,
      },
    ];
    mockHandlers.set('telegram', handler);

    const results = await runLiveVerification({
      pluginsDir: '/plugins',
      credentialsPluginsDir: '/creds/plugins',
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
    expect(results[0].detail).toBe('401 Unauthorized');
    expect(results[0].fix).toBeDefined();
  });

  it('handler without verify() → WARN', async () => {
    const handler: Partial<PluginHandler> = {};
    mockLoadResults = [
      {
        ok: true as const,
        pluginName: 'hello',
        manifest: JSON.parse(VALID_MANIFEST),
        handler: handler as PluginHandler,
        source: 'user' as PluginSource,
      },
    ];
    mockHandlers.set('hello', handler);

    const results = await runLiveVerification({
      pluginsDir: '/plugins',
      credentialsPluginsDir: '/creds/plugins',
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('warn');
    expect(results[0].detail).toContain('No verify()');
  });

  it('verify() that throws → FAIL with error message', async () => {
    const handler: Partial<PluginHandler> = {
      verify: vi.fn(async () => {
        throw new Error('Connection refused');
      }),
    };
    mockLoadResults = [
      {
        ok: true as const,
        pluginName: 'telegram',
        manifest: JSON.parse(VALID_MANIFEST),
        handler: handler as PluginHandler,
        source: 'user' as PluginSource,
      },
    ];
    mockHandlers.set('telegram', handler);

    const results = await runLiveVerification({
      pluginsDir: '/plugins',
      credentialsPluginsDir: '/creds/plugins',
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
    expect(results[0].detail).toBe('Connection refused');
  });

  it('verify() that times out → FAIL with timeout message', async () => {
    const handler: Partial<PluginHandler> = {
      verify: vi.fn(
        () => new Promise<never>(() => {}), // never resolves
      ),
    };
    mockLoadResults = [
      {
        ok: true as const,
        pluginName: 'slow-plugin',
        manifest: JSON.parse(VALID_MANIFEST),
        handler: handler as PluginHandler,
        source: 'user' as PluginSource,
      },
    ];
    mockHandlers.set('slow-plugin', handler);

    const results = await runLiveVerification({
      pluginsDir: '/plugins',
      credentialsPluginsDir: '/creds/plugins',
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
    expect(results[0].detail).toContain('timed out');
  }, 15_000);

  it('pluginName filter → only loads/verifies the named plugin', async () => {
    mockDiscovered = [
      { name: 'telegram', dir: '/plugins/telegram', source: 'user' },
      { name: 'hello', dir: '/plugins/hello', source: 'user' },
    ];

    const handler: Partial<PluginHandler> = {
      verify: vi.fn(async () => ({ ok: true, message: 'OK' })),
    };
    mockLoadPlugin.mockResolvedValue({
      ok: true,
      pluginName: 'telegram',
      manifest: JSON.parse(VALID_MANIFEST),
      handler,
      source: 'user',
    });
    mockHandlers.set('telegram', handler);

    const results = await runLiveVerification({
      pluginsDir: '/plugins',
      credentialsPluginsDir: '/creds/plugins',
      pluginName: 'telegram',
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('live-telegram');
    expect(results[0].status).toBe('pass');
  });

  it('pluginName not found → FAIL', async () => {
    mockDiscovered = [{ name: 'hello', dir: '/plugins/hello', source: 'user' }];

    const results = await runLiveVerification({
      pluginsDir: '/plugins',
      credentialsPluginsDir: '/creds/plugins',
      pluginName: 'nonexistent',
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
    expect(results[0].detail).toContain('not found');
  });

  it('failed plugins from loadAll() → skipped', async () => {
    const handler: Partial<PluginHandler> = {
      verify: vi.fn(async () => ({ ok: true, message: 'OK' })),
    };
    mockLoadResults = [
      {
        ok: false as const,
        pluginName: 'broken',
        error: 'Bad manifest',
        category: 'invalid_manifest',
      },
      {
        ok: true as const,
        pluginName: 'good',
        manifest: JSON.parse(VALID_MANIFEST),
        handler: handler as PluginHandler,
        source: 'user' as PluginSource,
      },
    ];
    mockHandlers.set('good', handler);

    const results = await runLiveVerification({
      pluginsDir: '/plugins',
      credentialsPluginsDir: '/creds/plugins',
    });

    // Only the good plugin should have a live result
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('live-good');
  });

  it('shutdownAll() called after verification', async () => {
    mockLoadResults = [];

    await runLiveVerification({
      pluginsDir: '/plugins',
      credentialsPluginsDir: '/creds/plugins',
    });

    expect(mockShutdownAll).toHaveBeenCalled();
  });

  it('shutdownAll() called even when verify throws', async () => {
    const handler: Partial<PluginHandler> = {
      verify: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    mockLoadResults = [
      {
        ok: true as const,
        pluginName: 'crashy',
        manifest: JSON.parse(VALID_MANIFEST),
        handler: handler as PluginHandler,
        source: 'user' as PluginSource,
      },
    ];
    mockHandlers.set('crashy', handler);

    await runLiveVerification({
      pluginsDir: '/plugins',
      credentialsPluginsDir: '/creds/plugins',
    });

    expect(mockShutdownAll).toHaveBeenCalled();
  });

  it('single plugin load failure → FAIL result', async () => {
    mockDiscovered = [{ name: 'bad', dir: '/plugins/bad', source: 'user' }];
    mockLoadPlugin.mockResolvedValue({
      ok: false,
      pluginName: 'bad',
      error: 'Missing handler.ts',
      category: 'missing_handler',
    });

    const results = await runLiveVerification({
      pluginsDir: '/plugins',
      credentialsPluginsDir: '/creds/plugins',
      pluginName: 'bad',
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
    expect(results[0].detail).toContain('Missing handler.ts');
  });
});
