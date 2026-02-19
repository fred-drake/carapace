import { describe, it, expect, vi } from 'vitest';
import {
  runUninstall,
  scanShellConfigs,
  formatSize,
  type UninstallDeps,
  type UninstallOptions,
} from './uninstall.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeps(overrides?: Partial<UninstallDeps>): UninstallDeps {
  return {
    stdout: vi.fn(),
    stderr: vi.fn(),
    home: '/home/user/.carapace',
    userHome: '/home/user',
    readPidFile: vi.fn().mockReturnValue(null),
    processExists: vi.fn().mockReturnValue(false),
    confirm: vi.fn().mockResolvedValue(true),
    dirExists: vi.fn().mockReturnValue(true),
    dirSize: vi.fn().mockReturnValue(4096),
    removeDir: vi.fn(),
    readFile: vi.fn().mockReturnValue(''),
    writeFile: vi.fn(),
    shellConfigPaths: vi.fn().mockReturnValue([]),
    listDir: vi.fn().mockReturnValue(['bin', 'lib', 'plugins', 'data', 'credentials', 'run']),
    ...overrides,
  };
}

function opts(overrides?: Partial<UninstallOptions>): UninstallOptions {
  return { yes: false, dryRun: false, ...overrides };
}

// ---------------------------------------------------------------------------
// formatSize
// ---------------------------------------------------------------------------

describe('formatSize', () => {
  it('formats bytes', () => {
    expect(formatSize(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatSize(2048)).toBe('2.0 KB');
  });

  it('formats megabytes', () => {
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('formats gigabytes', () => {
    expect(formatSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });
});

// ---------------------------------------------------------------------------
// scanShellConfigs
// ---------------------------------------------------------------------------

describe('scanShellConfigs', () => {
  it('detects PATH export referencing CARAPACE_HOME/bin', () => {
    const results = scanShellConfigs(
      ['/home/user/.bashrc'],
      '/home/user/.carapace',
      () => `export PATH="/home/user/.carapace/bin:$PATH"`,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe('/home/user/.bashrc');
    expect(results[0]!.lineNumber).toBe(1);
  });

  it('detects fish set -x PATH entries', () => {
    const results = scanShellConfigs(
      ['/home/user/.config/fish/config.fish'],
      '/home/user/.carapace',
      () => `set -x PATH /home/user/.carapace/bin $PATH`,
    );
    expect(results).toHaveLength(1);
  });

  it('detects $CARAPACE_HOME variable references', () => {
    const results = scanShellConfigs(
      ['/home/user/.zshrc'],
      '/home/user/.carapace',
      () => `export PATH="$CARAPACE_HOME/bin:$PATH"`,
    );
    expect(results).toHaveLength(1);
  });

  it('returns empty when no matches', () => {
    const results = scanShellConfigs(
      ['/home/user/.bashrc'],
      '/home/user/.carapace',
      () => `export PATH="/usr/bin:$PATH"`,
    );
    expect(results).toHaveLength(0);
  });

  it('skips files that cannot be read', () => {
    const results = scanShellConfigs(['/home/user/.bashrc'], '/home/user/.carapace', () => {
      throw new Error('ENOENT');
    });
    expect(results).toHaveLength(0);
  });

  it('reports correct line numbers for multi-line files', () => {
    const results = scanShellConfigs(
      ['/home/user/.bashrc'],
      '/home/user/.carapace',
      () => `# some stuff\n# more stuff\nexport PATH="/home/user/.carapace/bin:$PATH"\n# end`,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.lineNumber).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// runUninstall — running session detection
// ---------------------------------------------------------------------------

describe('runUninstall — running sessions', () => {
  it('warns when a session is running and asks to proceed', async () => {
    const deps = createDeps({
      readPidFile: vi.fn().mockReturnValue(12345),
      processExists: vi.fn().mockReturnValue(true),
      confirm: vi.fn().mockResolvedValue(false),
    });
    const code = await runUninstall(deps, opts());
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('running'));
    expect(code).toBe(1);
  });

  it('proceeds when user confirms despite running session', async () => {
    const deps = createDeps({
      readPidFile: vi.fn().mockReturnValue(12345),
      processExists: vi.fn().mockReturnValue(true),
    });
    const code = await runUninstall(deps, opts({ yes: true }));
    expect(code).toBe(0);
    expect(deps.removeDir).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runUninstall — confirmation flow
// ---------------------------------------------------------------------------

describe('runUninstall — confirmation', () => {
  it('shows what will be deleted with sizes', async () => {
    const deps = createDeps();
    await runUninstall(deps, opts());
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasSize = allCalls.some((c: string) => /\d+(\.\d+)?\s*(B|KB|MB|GB)/.test(c));
    expect(hasSize).toBe(true);
  });

  it('asks for confirmation before deleting', async () => {
    const deps = createDeps();
    await runUninstall(deps, opts());
    expect(deps.confirm).toHaveBeenCalled();
  });

  it('aborts when user declines confirmation', async () => {
    const deps = createDeps({
      confirm: vi.fn().mockResolvedValue(false),
    });
    const code = await runUninstall(deps, opts());
    expect(code).toBe(1);
    expect(deps.removeDir).not.toHaveBeenCalled();
  });

  it('skips confirmation with --yes flag', async () => {
    const deps = createDeps();
    const code = await runUninstall(deps, opts({ yes: true }));
    expect(code).toBe(0);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.removeDir).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runUninstall — dry-run
// ---------------------------------------------------------------------------

describe('runUninstall — dry-run', () => {
  it('shows what would be deleted without acting', async () => {
    const deps = createDeps();
    const code = await runUninstall(deps, opts({ dryRun: true }));
    expect(code).toBe(0);
    expect(deps.removeDir).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('indicates dry-run mode in output', async () => {
    const deps = createDeps();
    await runUninstall(deps, opts({ dryRun: true }));
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasDryRun = allCalls.some((c: string) => /dry.run/i.test(c));
    expect(hasDryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runUninstall — deletion
// ---------------------------------------------------------------------------

describe('runUninstall — deletion', () => {
  it('removes CARAPACE_HOME directory', async () => {
    const deps = createDeps();
    const code = await runUninstall(deps, opts({ yes: true }));
    expect(code).toBe(0);
    expect(deps.removeDir).toHaveBeenCalledWith('/home/user/.carapace');
  });

  it('reports success after deletion', async () => {
    const deps = createDeps();
    await runUninstall(deps, opts({ yes: true }));
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasRemoved = allCalls.some((c: string) => /removed|uninstall/i.test(c));
    expect(hasRemoved).toBe(true);
  });

  it('handles missing CARAPACE_HOME gracefully', async () => {
    const deps = createDeps({
      dirExists: vi.fn().mockReturnValue(false),
    });
    const code = await runUninstall(deps, opts({ yes: true }));
    expect(code).toBe(0);
    expect(deps.removeDir).not.toHaveBeenCalled();
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasNothing = allCalls.some((c: string) => /nothing|not found|does not exist/i.test(c));
    expect(hasNothing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runUninstall — PATH cleanup
// ---------------------------------------------------------------------------

describe('runUninstall — PATH cleanup', () => {
  it('detects and removes PATH modifications from shell configs', async () => {
    const bashrc = `# stuff\nexport PATH="/home/user/.carapace/bin:$PATH"\n# end`;
    const deps = createDeps({
      shellConfigPaths: vi.fn().mockReturnValue(['/home/user/.bashrc']),
      readFile: vi.fn().mockReturnValue(bashrc),
    });
    await runUninstall(deps, opts({ yes: true }));
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/home/user/.bashrc',
      expect.not.stringContaining('.carapace/bin'),
    );
  });

  it('preserves non-carapace lines in shell configs', async () => {
    const bashrc = `# stuff\nexport PATH="/home/user/.carapace/bin:$PATH"\nexport FOO=bar`;
    const deps = createDeps({
      shellConfigPaths: vi.fn().mockReturnValue(['/home/user/.bashrc']),
      readFile: vi.fn().mockReturnValue(bashrc),
    });
    await runUninstall(deps, opts({ yes: true }));
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/home/user/.bashrc',
      expect.stringContaining('export FOO=bar'),
    );
  });

  it('does not write shell config if no carapace lines found', async () => {
    const deps = createDeps({
      shellConfigPaths: vi.fn().mockReturnValue(['/home/user/.bashrc']),
      readFile: vi.fn().mockReturnValue('export FOO=bar'),
    });
    await runUninstall(deps, opts({ yes: true }));
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('reports which shell configs were modified', async () => {
    const bashrc = `export PATH="/home/user/.carapace/bin:$PATH"`;
    const deps = createDeps({
      shellConfigPaths: vi.fn().mockReturnValue(['/home/user/.bashrc']),
      readFile: vi.fn().mockReturnValue(bashrc),
    });
    await runUninstall(deps, opts({ yes: true }));
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasReport = allCalls.some((c: string) => c.includes('.bashrc'));
    expect(hasReport).toBe(true);
  });

  it('skips PATH cleanup in dry-run mode', async () => {
    const bashrc = `export PATH="/home/user/.carapace/bin:$PATH"`;
    const deps = createDeps({
      shellConfigPaths: vi.fn().mockReturnValue(['/home/user/.bashrc']),
      readFile: vi.fn().mockReturnValue(bashrc),
    });
    await runUninstall(deps, opts({ dryRun: true }));
    expect(deps.writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runUninstall — CLI integration
// ---------------------------------------------------------------------------

describe('runUninstall — CLI integration', () => {
  it('lists subdirectories with their sizes', async () => {
    const deps = createDeps({
      listDir: vi.fn().mockReturnValue(['bin', 'data', 'plugins']),
      dirSize: vi.fn().mockReturnValue(8192),
    });
    await runUninstall(deps, opts());
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasSubdirs = allCalls.some((c: string) => c.includes('bin') || c.includes('data'));
    expect(hasSubdirs).toBe(true);
  });
});
