import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseArgs, runCommand, doctor, start, stop, status } from './cli.js';
import { MockContainerRuntime } from './core/container/mock-runtime.js';
import type { CliDeps } from './cli.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDeps(overrides?: Partial<CliDeps>): CliDeps {
  return {
    stdout: vi.fn(),
    stderr: vi.fn(),
    home: '/tmp/test-carapace-home',
    nodeVersion: 'v22.0.0',
    platform: 'darwin',
    runtimes: [new MockContainerRuntime('docker')],
    readPidFile: vi.fn().mockReturnValue(null),
    writePidFile: vi.fn(),
    removePidFile: vi.fn(),
    processExists: vi.fn().mockReturnValue(false),
    sendSignal: vi.fn(),
    loadConfig: vi.fn().mockReturnValue({
      runtime: { engine: 'docker' },
      plugins: { dirs: [] },
      security: { max_sessions_per_group: 3 },
      hello: { enabled: true },
    }),
    ensureDirs: vi.fn().mockReturnValue({
      root: '/tmp/test-carapace-home',
      bin: '/tmp/test-carapace-home/bin',
      lib: '/tmp/test-carapace-home/lib',
      plugins: '/tmp/test-carapace-home/plugins',
      data: '/tmp/test-carapace-home/data',
      credentials: '/tmp/test-carapace-home/credentials',
      run: '/tmp/test-carapace-home/run',
      sockets: '/tmp/test-carapace-home/run/sockets',
      configFile: '/tmp/test-carapace-home/config.toml',
      mutableDirs: [],
      immutableDirs: [],
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses a subcommand from argv', () => {
    const result = parseArgs(['node', 'carapace', 'start']);
    expect(result.command).toBe('start');
  });

  it('parses the stop command', () => {
    const result = parseArgs(['node', 'carapace', 'stop']);
    expect(result.command).toBe('stop');
  });

  it('parses the status command', () => {
    const result = parseArgs(['node', 'carapace', 'status']);
    expect(result.command).toBe('status');
  });

  it('parses the doctor command', () => {
    const result = parseArgs(['node', 'carapace', 'doctor']);
    expect(result.command).toBe('doctor');
  });

  it('returns empty command when no subcommand is given', () => {
    const result = parseArgs(['node', 'carapace']);
    expect(result.command).toBe('');
  });

  it('parses --version flag', () => {
    const result = parseArgs(['node', 'carapace', '--version']);
    expect(result.flags['version']).toBe(true);
  });

  it('parses --help flag', () => {
    const result = parseArgs(['node', 'carapace', '--help']);
    expect(result.flags['help']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runCommand — dispatch
// ---------------------------------------------------------------------------

describe('runCommand', () => {
  it('dispatches to doctor command', async () => {
    const deps = createTestDeps();
    const code = await runCommand('doctor', deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalled();
  });

  it('shows usage for unknown commands', async () => {
    const deps = createTestDeps();
    const code = await runCommand('unknown', deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
  });

  it('shows usage for empty command', async () => {
    const deps = createTestDeps();
    const code = await runCommand('', deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('shows version for --version flag', async () => {
    const deps = createTestDeps();
    const code = await runCommand('--version', deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringMatching(/\d+\.\d+\.\d+/));
  });
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe('doctor', () => {
  it('reports Node.js version check as pass', async () => {
    const deps = createTestDeps({ nodeVersion: 'v22.5.0' });
    const code = await doctor(deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('Node.js'));
  });

  it('fails when Node.js version is too old', async () => {
    const deps = createTestDeps({ nodeVersion: 'v20.1.0' });
    const code = await doctor(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Node.js >= 22'));
  });

  it('reports container runtime availability', async () => {
    const deps = createTestDeps();
    const code = await doctor(deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('docker'));
  });

  it('fails when no container runtime is available', async () => {
    const runtime = new MockContainerRuntime('docker');
    vi.spyOn(runtime, 'isAvailable').mockResolvedValue(false);

    const deps = createTestDeps({ runtimes: [runtime] });
    const code = await doctor(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('No container runtime'));
  });

  it('reports config validation', async () => {
    const deps = createTestDeps();
    const code = await doctor(deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('config'));
  });

  it('reports config errors gracefully', async () => {
    const deps = createTestDeps({
      loadConfig: vi.fn().mockImplementation(() => {
        throw new Error('Invalid TOML syntax');
      }),
    });
    const code = await doctor(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Invalid TOML syntax'));
  });

  it('reports directory structure check', async () => {
    const deps = createTestDeps();
    const code = await doctor(deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('CARAPACE_HOME'));
  });

  it('reports directory structure errors', async () => {
    const deps = createTestDeps({
      ensureDirs: vi.fn().mockImplementation(() => {
        throw new Error('Permission denied');
      }),
    });
    const code = await doctor(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
  });

  it('shows all checks summary', async () => {
    const deps = createTestDeps();
    await doctor(deps);
    // Should report total checks
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const summary = allCalls.find((c: string) => c.includes('checks passed'));
    expect(summary).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe('start', () => {
  it('initializes directory structure', async () => {
    const deps = createTestDeps();
    await start(deps);
    expect(deps.ensureDirs).toHaveBeenCalledWith(deps.home);
  });

  it('loads configuration', async () => {
    const deps = createTestDeps();
    await start(deps);
    expect(deps.loadConfig).toHaveBeenCalledWith(deps.home);
  });

  it('detects container runtime', async () => {
    const deps = createTestDeps();
    const code = await start(deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('docker'));
  });

  it('writes PID file on start', async () => {
    const deps = createTestDeps();
    await start(deps);
    expect(deps.writePidFile).toHaveBeenCalled();
  });

  it('fails when no runtime is available', async () => {
    const runtime = new MockContainerRuntime('docker');
    vi.spyOn(runtime, 'isAvailable').mockResolvedValue(false);

    const deps = createTestDeps({ runtimes: [runtime] });
    const code = await start(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('No container runtime'));
  });

  it('fails when already running', async () => {
    const deps = createTestDeps({
      readPidFile: vi.fn().mockReturnValue(12345),
      processExists: vi.fn().mockReturnValue(true),
    });
    const code = await start(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it('cleans stale PID file and starts', async () => {
    const deps = createTestDeps({
      readPidFile: vi.fn().mockReturnValue(99999),
      processExists: vi.fn().mockReturnValue(false),
    });
    const code = await start(deps);
    expect(code).toBe(0);
    expect(deps.removePidFile).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe('stop', () => {
  it('sends signal to running process', async () => {
    const deps = createTestDeps({
      readPidFile: vi.fn().mockReturnValue(12345),
      processExists: vi.fn().mockReturnValue(true),
    });
    const code = await stop(deps);
    expect(code).toBe(0);
    expect(deps.sendSignal).toHaveBeenCalledWith(12345, 'SIGTERM');
  });

  it('reports error when not running', async () => {
    const deps = createTestDeps({
      readPidFile: vi.fn().mockReturnValue(null),
    });
    const code = await stop(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('not running'));
  });

  it('cleans stale PID file when process is gone', async () => {
    const deps = createTestDeps({
      readPidFile: vi.fn().mockReturnValue(99999),
      processExists: vi.fn().mockReturnValue(false),
    });
    const code = await stop(deps);
    expect(code).toBe(1);
    expect(deps.removePidFile).toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('not running'));
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('status', () => {
  it('reports running with PID when process exists', async () => {
    const deps = createTestDeps({
      readPidFile: vi.fn().mockReturnValue(12345),
      processExists: vi.fn().mockReturnValue(true),
    });
    const code = await status(deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('running'));
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('12345'));
  });

  it('reports not running when no PID file', async () => {
    const deps = createTestDeps({
      readPidFile: vi.fn().mockReturnValue(null),
    });
    const code = await status(deps);
    expect(code).toBe(1);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('not running'));
  });

  it('cleans stale PID and reports not running', async () => {
    const deps = createTestDeps({
      readPidFile: vi.fn().mockReturnValue(99999),
      processExists: vi.fn().mockReturnValue(false),
    });
    const code = await status(deps);
    expect(code).toBe(1);
    expect(deps.removePidFile).toHaveBeenCalled();
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('not running'));
  });
});
