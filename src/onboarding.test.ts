import { describe, it, expect, beforeEach, vi } from 'vitest';
import { needsOnboarding, runOnboarding, generateConfigToml } from './onboarding.js';
import { MockContainerRuntime } from './core/container/mock-runtime.js';
import type { OnboardingDeps } from './onboarding.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDeps(overrides?: Partial<OnboardingDeps>): OnboardingDeps {
  return {
    stdout: vi.fn(),
    stderr: vi.fn(),
    home: '/tmp/test-carapace-home',
    platform: 'darwin',
    runtimes: [new MockContainerRuntime('docker')],
    configExists: vi.fn().mockReturnValue(false),
    writeConfig: vi.fn(),
    confirmRuntime: vi.fn().mockResolvedValue(true),
    ensureDirs: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// needsOnboarding
// ---------------------------------------------------------------------------

describe('needsOnboarding', () => {
  it('returns true when config does not exist', () => {
    const deps = createTestDeps({ configExists: vi.fn().mockReturnValue(false) });
    expect(needsOnboarding(deps)).toBe(true);
  });

  it('returns false when config already exists', () => {
    const deps = createTestDeps({ configExists: vi.fn().mockReturnValue(true) });
    expect(needsOnboarding(deps)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateConfigToml
// ---------------------------------------------------------------------------

describe('generateConfigToml', () => {
  it('generates TOML with the selected engine', () => {
    const toml = generateConfigToml('docker');
    expect(toml).toContain('[runtime]');
    expect(toml).toContain('engine = "docker"');
  });

  it('generates TOML for podman', () => {
    const toml = generateConfigToml('podman');
    expect(toml).toContain('engine = "podman"');
  });

  it('generates TOML for apple-container', () => {
    const toml = generateConfigToml('apple-container');
    expect(toml).toContain('engine = "apple-container"');
  });

  it('includes hello section enabled by default', () => {
    const toml = generateConfigToml('docker');
    expect(toml).toContain('[hello]');
    expect(toml).toContain('enabled = true');
  });

  it('includes security section with defaults', () => {
    const toml = generateConfigToml('docker');
    expect(toml).toContain('[security]');
    expect(toml).toContain('max_sessions_per_group = 3');
  });
});

// ---------------------------------------------------------------------------
// runOnboarding — full flow
// ---------------------------------------------------------------------------

describe('runOnboarding', () => {
  it('displays welcome message', async () => {
    const deps = createTestDeps();
    await runOnboarding(deps);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('Welcome to Carapace'));
  });

  it('detects and reports available runtimes', async () => {
    const deps = createTestDeps();
    await runOnboarding(deps);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('docker'));
  });

  it('asks user to confirm the detected runtime', async () => {
    const deps = createTestDeps();
    await runOnboarding(deps);
    expect(deps.confirmRuntime).toHaveBeenCalledOnce();
  });

  it('writes config.toml with confirmed engine', async () => {
    const deps = createTestDeps();
    await runOnboarding(deps);

    expect(deps.writeConfig).toHaveBeenCalledOnce();
    const [home, content] = (deps.writeConfig as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(home).toBe('/tmp/test-carapace-home');
    expect(content).toContain('engine = "docker"');
  });

  it('ensures directory structure before writing', async () => {
    const deps = createTestDeps();
    await runOnboarding(deps);

    expect(deps.ensureDirs).toHaveBeenCalledWith(deps.home);

    // ensureDirs should be called before writeConfig
    const ensureOrder = (deps.ensureDirs as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const writeOrder = (deps.writeConfig as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(ensureOrder).toBeLessThan(writeOrder);
  });

  it('runs hello.greet smoke test', async () => {
    const deps = createTestDeps();
    await runOnboarding(deps);

    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('hello.greet'));
  });

  it('displays Getting Started tips', async () => {
    const deps = createTestDeps();
    await runOnboarding(deps);

    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('Getting Started'));
  });

  it('returns 0 on success', async () => {
    const deps = createTestDeps();
    const code = await runOnboarding(deps);
    expect(code).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Error paths
  // -----------------------------------------------------------------------

  it('fails when no runtime is detected', async () => {
    const runtime = new MockContainerRuntime('docker');
    vi.spyOn(runtime, 'isAvailable').mockResolvedValue(false);

    const deps = createTestDeps({ runtimes: [runtime] });
    const code = await runOnboarding(deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('No container runtime'));
  });

  it('aborts when user declines the runtime', async () => {
    const deps = createTestDeps({
      confirmRuntime: vi.fn().mockResolvedValue(false),
    });
    const code = await runOnboarding(deps);

    expect(code).toBe(1);
    expect(deps.writeConfig).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Setup cancelled'));
  });

  it('selects from multiple runtimes by priority', async () => {
    const podman = new MockContainerRuntime('podman');
    const docker = new MockContainerRuntime('docker');

    const deps = createTestDeps({ runtimes: [docker, podman], platform: 'linux' });
    await runOnboarding(deps);

    // Podman has higher priority than Docker on Linux
    const confirmCall = (deps.confirmRuntime as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(confirmCall[0].runtime.name).toBe('podman');
  });

  it('prefers apple-container on darwin', async () => {
    const apple = new MockContainerRuntime('apple-container');
    const docker = new MockContainerRuntime('docker');

    const deps = createTestDeps({
      runtimes: [docker, apple],
      platform: 'darwin',
    });
    await runOnboarding(deps);

    const confirmCall = (deps.confirmRuntime as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(confirmCall[0].runtime.name).toBe('apple-container');
  });

  it('reports all available runtimes when multiple are found', async () => {
    const podman = new MockContainerRuntime('podman');
    const docker = new MockContainerRuntime('docker');

    const deps = createTestDeps({ runtimes: [docker, podman], platform: 'linux' });
    await runOnboarding(deps);

    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const availableLine = allCalls.find(
      (c: string) => c.includes('podman') && c.includes('docker'),
    );
    expect(availableLine).toBeDefined();
  });

  it('shows tips about carapace doctor and carapace start', async () => {
    const deps = createTestDeps();
    await runOnboarding(deps);

    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasDoctorTip = allCalls.some((c: string) => c.includes('carapace doctor'));
    const hasStartTip = allCalls.some((c: string) => c.includes('carapace start'));
    expect(hasDoctorTip).toBe(true);
    expect(hasStartTip).toBe(true);
  });
});
