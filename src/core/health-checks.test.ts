import { describe, it, expect } from 'vitest';
import {
  checkNodeVersion,
  checkContainerRuntime,
  checkPnpm,
  checkZeromq,
  checkSqlite,
  checkPluginDirs,
  checkSocketPath,
  runAllChecks,
  type HealthCheckResult,
  type HealthCheckDeps,
} from './health-checks.js';
import { MockContainerRuntime } from './container/mock-runtime.js';

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
// runAllChecks
// ---------------------------------------------------------------------------

describe('runAllChecks', () => {
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
      ...overrides,
    };
  }

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
