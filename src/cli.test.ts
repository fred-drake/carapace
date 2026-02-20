import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseArgs, runCommand, doctor, start, stop, status, uninstall, auth } from './cli.js';
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
    exec: vi.fn().mockResolvedValue({ stdout: '10.0.0\n', stderr: '' }),
    resolveModule: vi.fn().mockReturnValue('/path/to/module'),
    pluginDirs: [],
    socketPath: '/run/sockets',
    dirExists: vi.fn().mockReturnValue(true),
    isWritable: vi.fn().mockReturnValue(true),
    userHome: '/home/user',
    dirSize: vi.fn().mockReturnValue(4096),
    removeDir: vi.fn(),
    readFile: vi.fn().mockReturnValue(''),
    writeFile: vi.fn(),
    shellConfigPaths: vi.fn().mockReturnValue([]),
    listDir: vi.fn().mockReturnValue([]),
    confirm: vi.fn().mockResolvedValue(true),
    promptSecret: vi.fn().mockResolvedValue('sk-ant-api03-testkey123'),
    promptString: vi.fn().mockResolvedValue('oauth-test-token'),
    validateApiKey: vi.fn().mockResolvedValue({ valid: true }),
    fileExists: vi.fn().mockReturnValue(false),
    writeFileSecure: vi.fn(),
    fileStat: vi.fn().mockReturnValue(null),
    fileMode: vi.fn().mockReturnValue(0o40700),
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

  it('parses the uninstall command', () => {
    const result = parseArgs(['node', 'carapace', 'uninstall']);
    expect(result.command).toBe('uninstall');
  });

  it('parses --yes flag with uninstall', () => {
    const result = parseArgs(['node', 'carapace', 'uninstall', '--yes']);
    expect(result.command).toBe('uninstall');
    expect(result.flags['yes']).toBe(true);
  });

  it('parses --dry-run flag with uninstall', () => {
    const result = parseArgs(['node', 'carapace', 'uninstall', '--dry-run']);
    expect(result.command).toBe('uninstall');
    expect(result.flags['dry-run']).toBe(true);
  });

  it('parses auth command with subcommand', () => {
    const result = parseArgs(['node', 'carapace', 'auth', 'api-key']);
    expect(result.command).toBe('auth');
    expect(result.subcommand).toBe('api-key');
  });

  it('parses auth login subcommand', () => {
    const result = parseArgs(['node', 'carapace', 'auth', 'login']);
    expect(result.command).toBe('auth');
    expect(result.subcommand).toBe('login');
  });

  it('parses auth status subcommand', () => {
    const result = parseArgs(['node', 'carapace', 'auth', 'status']);
    expect(result.command).toBe('auth');
    expect(result.subcommand).toBe('status');
  });

  it('parses auth without subcommand', () => {
    const result = parseArgs(['node', 'carapace', 'auth']);
    expect(result.command).toBe('auth');
    expect(result.subcommand).toBe('');
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

  it('dispatches to uninstall command', async () => {
    const deps = createTestDeps();
    const code = await runCommand('uninstall', deps, { yes: true });
    expect(code).toBe(0);
    expect(deps.removeDir).toHaveBeenCalled();
  });

  it('passes flags to uninstall command', async () => {
    const deps = createTestDeps();
    const code = await runCommand('uninstall', deps, { 'dry-run': true });
    expect(code).toBe(0);
    expect(deps.removeDir).not.toHaveBeenCalled();
  });

  it('shows uninstall in usage text', async () => {
    const deps = createTestDeps();
    await runCommand('', deps);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('uninstall'));
  });

  it('dispatches auth api-key subcommand', async () => {
    const deps = createTestDeps();
    const code = await runCommand('auth', deps, {}, 'api-key');
    expect(code).toBe(0);
    expect(deps.promptSecret).toHaveBeenCalled();
  });

  it('dispatches auth status subcommand', async () => {
    const deps = createTestDeps();
    const code = await runCommand('auth', deps, {}, 'status');
    expect(code).toBe(0);
  });

  it('shows auth usage for unknown auth subcommand', async () => {
    const deps = createTestDeps();
    const code = await runCommand('auth', deps, {}, 'unknown');
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Unknown auth subcommand'));
  });

  it('shows auth usage when no auth subcommand given', async () => {
    const deps = createTestDeps();
    const code = await runCommand('auth', deps, {}, '');
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('auth'));
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
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('requires >= 22'));
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

  it('shows fix suggestions on failure', async () => {
    const deps = createTestDeps({ nodeVersion: 'v18.0.0' });
    await doctor(deps);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Fix:'));
  });

  it('reports pnpm availability', async () => {
    const deps = createTestDeps();
    const code = await doctor(deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('pnpm'));
  });

  it('fails when pnpm is not found', async () => {
    const deps = createTestDeps({
      exec: vi.fn().mockRejectedValue(new Error('not found')),
    });
    const code = await doctor(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('pnpm'));
  });

  it('reports zeromq check', async () => {
    const deps = createTestDeps();
    const code = await doctor(deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('ZeroMQ'));
  });

  it('reports sqlite check', async () => {
    const deps = createTestDeps();
    const code = await doctor(deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('SQLite'));
  });

  it('reports socket path check', async () => {
    const deps = createTestDeps();
    const code = await doctor(deps);
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('Socket path'));
  });

  it('fails when socket path is not writable', async () => {
    const deps = createTestDeps({
      isWritable: vi.fn().mockReturnValue(false),
    });
    const code = await doctor(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Socket path'));
  });

  it('shows all checks summary', async () => {
    const deps = createTestDeps();
    await doctor(deps);
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

// ---------------------------------------------------------------------------
// uninstall (CLI bridge)
// ---------------------------------------------------------------------------

describe('uninstall', () => {
  it('removes CARAPACE_HOME with --yes flag', async () => {
    const deps = createTestDeps();
    const code = await uninstall(deps, { yes: true });
    expect(code).toBe(0);
    expect(deps.removeDir).toHaveBeenCalledWith(deps.home);
  });

  it('does not remove in dry-run mode', async () => {
    const deps = createTestDeps();
    const code = await uninstall(deps, { 'dry-run': true });
    expect(code).toBe(0);
    expect(deps.removeDir).not.toHaveBeenCalled();
  });

  it('asks for confirmation without --yes', async () => {
    const deps = createTestDeps();
    await uninstall(deps, {});
    expect(deps.confirm).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// auth (CLI bridge)
// ---------------------------------------------------------------------------

describe('auth', () => {
  it('dispatches api-key subcommand', async () => {
    const deps = createTestDeps();
    const code = await auth(deps, 'api-key');
    expect(code).toBe(0);
    expect(deps.writeFileSecure).toHaveBeenCalledWith(
      expect.stringContaining('anthropic-api-key'),
      expect.any(String),
      0o600,
    );
  });

  it('dispatches login subcommand', async () => {
    const deps = createTestDeps();
    const code = await auth(deps, 'login');
    expect(code).toBe(0);
    expect(deps.writeFileSecure).toHaveBeenCalledWith(
      expect.stringContaining('claude-oauth-token'),
      expect.any(String),
      0o600,
    );
  });

  it('dispatches status subcommand', async () => {
    const deps = createTestDeps();
    const code = await auth(deps, 'status');
    expect(code).toBe(0);
  });

  it('shows auth usage for empty subcommand', async () => {
    const deps = createTestDeps();
    const code = await auth(deps, '');
    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('api-key'));
  });

  it('returns error for unknown subcommand', async () => {
    const deps = createTestDeps();
    const code = await auth(deps, 'bogus');
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// start — image staleness check
// ---------------------------------------------------------------------------

describe('start image staleness check', () => {
  afterEach(() => {
    delete process.env.SKIP_IMAGE_BUILD;
  });

  it('auto-rebuilds when image is stale', async () => {
    const buildImage = vi.fn().mockResolvedValue({
      tag: 'carapace:2.1.49-abc1234',
      gitSha: 'abc1234',
      claudeVersion: '2.1.49',
      carapaceVersion: '0.0.1',
      buildDate: '2026-02-20T00:00:00Z',
    });
    const deps = createTestDeps({
      resolveGitSha: vi.fn().mockResolvedValue('def5678'),
      inspectImageLabels: vi.fn().mockResolvedValue({
        'org.opencontainers.image.revision': 'abc1234',
      }),
      buildImage,
      projectRoot: '/project',
      imageName: 'carapace:latest',
    });
    await start(deps);
    expect(buildImage).toHaveBeenCalledWith('/project');
    expect(deps.stdout).toHaveBeenCalledWith('Image stale, rebuilding...');
  });

  it('skips rebuild when image is current', async () => {
    const buildImage = vi.fn();
    const deps = createTestDeps({
      resolveGitSha: vi.fn().mockResolvedValue('abc1234'),
      inspectImageLabels: vi.fn().mockResolvedValue({
        'org.opencontainers.image.revision': 'abc1234',
      }),
      buildImage,
      projectRoot: '/project',
      imageName: 'carapace:latest',
    });
    await start(deps);
    expect(buildImage).not.toHaveBeenCalled();
  });

  it('builds when image is missing', async () => {
    const buildImage = vi.fn().mockResolvedValue({
      tag: 'carapace:latest-abc1234',
      gitSha: 'abc1234',
      claudeVersion: 'latest',
      carapaceVersion: '0.0.1',
      buildDate: '2026-02-20T00:00:00Z',
    });
    const deps = createTestDeps({
      resolveGitSha: vi.fn().mockResolvedValue('abc1234'),
      inspectImageLabels: vi.fn().mockRejectedValue(new Error('not found')),
      buildImage,
      projectRoot: '/project',
      imageName: 'carapace:latest',
    });
    await start(deps);
    expect(buildImage).toHaveBeenCalledWith('/project');
    expect(deps.stdout).toHaveBeenCalledWith('Container image not found, building...');
  });

  it('skips check with SKIP_IMAGE_BUILD=1', async () => {
    process.env.SKIP_IMAGE_BUILD = '1';
    const buildImage = vi.fn();
    const runtime = new MockContainerRuntime('docker');
    vi.spyOn(runtime, 'imageExists').mockResolvedValue(true);
    const deps = createTestDeps({
      resolveGitSha: vi.fn().mockResolvedValue('abc1234'),
      inspectImageLabels: vi.fn().mockResolvedValue({
        'org.opencontainers.image.revision': 'old1234',
      }),
      buildImage,
      projectRoot: '/project',
      imageName: 'carapace:latest',
      runtimes: [runtime],
    });
    await start(deps);
    expect(buildImage).not.toHaveBeenCalled();
    expect(deps.stdout).toHaveBeenCalledWith('Skipping image build check (SKIP_IMAGE_BUILD=1)');
  });

  it('fails with SKIP_IMAGE_BUILD when no image exists', async () => {
    process.env.SKIP_IMAGE_BUILD = '1';
    const runtime = new MockContainerRuntime('docker');
    vi.spyOn(runtime, 'imageExists').mockResolvedValue(false);
    const deps = createTestDeps({
      resolveGitSha: vi.fn(),
      inspectImageLabels: vi.fn(),
      buildImage: vi.fn(),
      projectRoot: '/project',
      imageName: 'carapace:latest',
      runtimes: [runtime],
    });
    const code = await start(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(
      'No container image found. Run `carapace update` or unset SKIP_IMAGE_BUILD.',
    );
  });

  it('returns 1 when image build fails', async () => {
    const deps = createTestDeps({
      resolveGitSha: vi.fn().mockResolvedValue('abc1234'),
      inspectImageLabels: vi.fn().mockRejectedValue(new Error('not found')),
      buildImage: vi.fn().mockRejectedValue(new Error('build exploded')),
      projectRoot: '/project',
      imageName: 'carapace:latest',
    });
    const code = await start(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith('Image build failed: build exploded');
  });

  it('warns and continues when git SHA resolution fails', async () => {
    const deps = createTestDeps({
      resolveGitSha: vi.fn().mockRejectedValue(new Error('git not found')),
      inspectImageLabels: vi.fn(),
      buildImage: vi.fn(),
      projectRoot: '/project',
      imageName: 'carapace:latest',
    });
    const code = await start(deps);
    expect(code).toBe(0);
    expect(deps.stderr).toHaveBeenCalledWith(
      'Warning: Could not check image staleness: git not found',
    );
  });
});
