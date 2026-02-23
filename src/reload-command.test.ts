import { describe, it, expect, vi } from 'vitest';
import { runReload, RELOAD_DIR_NAME, type ReloadDeps } from './reload-command.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDeps(overrides?: Partial<ReloadDeps>): ReloadDeps {
  return {
    stdout: vi.fn(),
    stderr: vi.fn(),
    home: '/tmp/test-carapace-home',
    readPidFile: vi.fn().mockReturnValue(12345),
    processExists: vi.fn().mockReturnValue(true),
    writeFile: vi.fn(),
    ensureDir: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runReload', () => {
  it('writes a reload trigger file and returns 0', () => {
    const deps = createTestDeps();
    const code = runReload(deps);
    expect(code).toBe(0);
    expect(deps.writeFile).toHaveBeenCalledOnce();
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('Reload requested'));
  });

  it('creates the reload directory', () => {
    const deps = createTestDeps();
    runReload(deps);
    expect(deps.ensureDir).toHaveBeenCalledWith(expect.stringContaining(RELOAD_DIR_NAME));
  });

  it('writes valid JSON trigger with null plugin for reload-all', () => {
    const deps = createTestDeps();
    runReload(deps);

    const writtenPath = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const writtenContent = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;

    expect(writtenPath).toMatch(/\.json$/);
    expect(writtenPath).toContain(RELOAD_DIR_NAME);

    const trigger = JSON.parse(writtenContent);
    expect(trigger.id).toBeDefined();
    expect(trigger.timestamp).toBeDefined();
    expect(trigger.plugin).toBeNull();
  });

  it('writes plugin name in trigger when specified', () => {
    const deps = createTestDeps();
    runReload(deps, 'my-plugin');

    const writtenContent = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const trigger = JSON.parse(writtenContent);
    expect(trigger.plugin).toBe('my-plugin');
  });

  it('prints plugin-specific message when plugin name given', () => {
    const deps = createTestDeps();
    runReload(deps, 'my-plugin');

    expect(deps.stdout).toHaveBeenCalledWith(
      expect.stringContaining('Reload requested for plugin "my-plugin"'),
    );
  });

  it('prints all-plugins message when no plugin specified', () => {
    const deps = createTestDeps();
    runReload(deps);

    expect(deps.stdout).toHaveBeenCalledWith(
      expect.stringContaining('Reload requested for all plugins'),
    );
  });

  it('includes a UUID in the output', () => {
    const deps = createTestDeps();
    runReload(deps);

    const stdoutCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const message = stdoutCalls.find((msg: string) => msg.includes('Reload requested'));
    expect(message).toMatch(/[0-9a-f-]{36}/);
  });

  it('returns 1 when Carapace is not running (no PID file)', () => {
    const deps = createTestDeps({
      readPidFile: vi.fn().mockReturnValue(null),
    });
    const code = runReload(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('not running'));
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('returns 1 when Carapace process is dead (stale PID)', () => {
    const deps = createTestDeps({
      processExists: vi.fn().mockReturnValue(false),
    });
    const code = runReload(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('stale PID'));
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('generates unique file names for each reload', () => {
    const deps = createTestDeps();
    runReload(deps);
    runReload(deps);

    const calls = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls;
    const path1 = calls[0][0] as string;
    const path2 = calls[1][0] as string;
    expect(path1).not.toBe(path2);
  });
});
