import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PluginWatcher,
  type PluginWatcherDeps,
  type WatcherEvent,
  type WatcherEventType,
  type ReloadResult,
} from './plugin-watcher.js';
import type { ValidationResult } from './validate-manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validValidationResult(): ValidationResult {
  return { valid: true, errors: [], warnings: [] };
}

function invalidValidationResult(msg: string): ValidationResult {
  return {
    valid: false,
    errors: [{ field: 'manifest.json', message: msg }],
    warnings: [],
  };
}

function createDeps(overrides?: Partial<PluginWatcherDeps>): PluginWatcherDeps {
  return {
    watchDir: vi.fn().mockReturnValue({ close: vi.fn() }),
    validatePlugin: vi.fn().mockReturnValue(validValidationResult()),
    compileHandler: vi.fn().mockResolvedValue({ success: true }),
    registerTools: vi.fn(),
    unregisterTools: vi.fn(),
    listPluginDirs: vi.fn().mockReturnValue(['weather']),
    output: vi.fn(),
    now: () => '2026-02-19T12:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// WatcherEventType
// ---------------------------------------------------------------------------

describe('WatcherEventType', () => {
  it('includes change_detected', () => {
    const t: WatcherEventType = 'change_detected';
    expect(t).toBe('change_detected');
  });

  it('includes validating', () => {
    const t: WatcherEventType = 'validating';
    expect(t).toBe('validating');
  });

  it('includes reload_success', () => {
    const t: WatcherEventType = 'reload_success';
    expect(t).toBe('reload_success');
  });

  it('includes reload_failed', () => {
    const t: WatcherEventType = 'reload_failed';
    expect(t).toBe('reload_failed');
  });
});

// ---------------------------------------------------------------------------
// PluginWatcher — start / stop
// ---------------------------------------------------------------------------

describe('PluginWatcher — lifecycle', () => {
  let deps: PluginWatcherDeps;
  let watcher: PluginWatcher;

  beforeEach(() => {
    deps = createDeps();
    watcher = new PluginWatcher('/plugins', deps);
  });

  afterEach(() => {
    watcher.stop();
  });

  it('starts watching the plugins directory', () => {
    watcher.start();

    expect(deps.watchDir).toHaveBeenCalledWith('/plugins', expect.any(Function));
  });

  it('can be stopped', () => {
    watcher.start();
    const closeFn = (deps.watchDir as ReturnType<typeof vi.fn>).mock.results[0].value.close;

    watcher.stop();

    expect(closeFn).toHaveBeenCalled();
  });

  it('does not throw when stopping without starting', () => {
    expect(() => watcher.stop()).not.toThrow();
  });

  it('reports started state', () => {
    expect(watcher.isWatching()).toBe(false);

    watcher.start();

    expect(watcher.isWatching()).toBe(true);
  });

  it('reports stopped state', () => {
    watcher.start();
    watcher.stop();

    expect(watcher.isWatching()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PluginWatcher — file change handling
// ---------------------------------------------------------------------------

describe('PluginWatcher — change handling', () => {
  let deps: PluginWatcherDeps;
  let watcher: PluginWatcher;
  let triggerChange: (filePath: string) => void;

  beforeEach(() => {
    deps = createDeps({
      watchDir: vi.fn().mockImplementation((_dir: string, callback: (filePath: string) => void) => {
        triggerChange = callback;
        return { close: vi.fn() };
      }),
    });
    watcher = new PluginWatcher('/plugins', deps);
    watcher.start();
  });

  afterEach(() => {
    watcher.stop();
  });

  it('detects plugin directory from changed file path', async () => {
    triggerChange('weather/manifest.json');

    // Give async reload a tick to process
    await vi.waitFor(() => {
      expect(deps.validatePlugin).toHaveBeenCalledWith('weather');
    });
  });

  it('validates the manifest on change', async () => {
    triggerChange('weather/handler.ts');

    await vi.waitFor(() => {
      expect(deps.validatePlugin).toHaveBeenCalledWith('weather');
    });
  });

  it('compiles the handler after successful validation', async () => {
    triggerChange('weather/handler.ts');

    await vi.waitFor(() => {
      expect(deps.compileHandler).toHaveBeenCalledWith('weather');
    });
  });

  it('re-registers tools after successful compile', async () => {
    triggerChange('weather/handler.ts');

    await vi.waitFor(() => {
      expect(deps.unregisterTools).toHaveBeenCalledWith('weather');
      expect(deps.registerTools).toHaveBeenCalledWith('weather');
    });
  });

  it('outputs change_detected event', async () => {
    triggerChange('weather/manifest.json');

    await vi.waitFor(() => {
      const calls = (deps.output as ReturnType<typeof vi.fn>).mock.calls;
      const detected = calls.find((c) => (c[0] as string).includes('change_detected'));
      expect(detected).toBeDefined();
    });
  });

  it('outputs reload_success on successful reload', async () => {
    triggerChange('weather/handler.ts');

    await vi.waitFor(() => {
      const calls = (deps.output as ReturnType<typeof vi.fn>).mock.calls;
      const success = calls.find((c) => (c[0] as string).includes('reload_success'));
      expect(success).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// PluginWatcher — validation failure
// ---------------------------------------------------------------------------

describe('PluginWatcher — validation failure', () => {
  let deps: PluginWatcherDeps;
  let watcher: PluginWatcher;
  let triggerChange: (filePath: string) => void;

  beforeEach(() => {
    deps = createDeps({
      watchDir: vi.fn().mockImplementation((_dir: string, callback: (filePath: string) => void) => {
        triggerChange = callback;
        return { close: vi.fn() };
      }),
      validatePlugin: vi.fn().mockReturnValue(invalidValidationResult('bad schema')),
    });
    watcher = new PluginWatcher('/plugins', deps);
    watcher.start();
  });

  afterEach(() => {
    watcher.stop();
  });

  it('does not compile handler on validation failure', async () => {
    triggerChange('weather/handler.ts');

    // Wait a tick then verify compile was NOT called
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.compileHandler).not.toHaveBeenCalled();
  });

  it('does not re-register tools on validation failure', async () => {
    triggerChange('weather/handler.ts');

    await new Promise((r) => setTimeout(r, 50));
    expect(deps.registerTools).not.toHaveBeenCalled();
  });

  it('outputs reload_failed with error details', async () => {
    triggerChange('weather/handler.ts');

    await vi.waitFor(() => {
      const calls = (deps.output as ReturnType<typeof vi.fn>).mock.calls;
      const failed = calls.find((c) => (c[0] as string).includes('reload_failed'));
      expect(failed).toBeDefined();
      expect(failed![0] as string).toContain('bad schema');
    });
  });

  it('does not crash the system on validation failure', async () => {
    triggerChange('weather/handler.ts');

    await new Promise((r) => setTimeout(r, 50));
    expect(watcher.isWatching()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PluginWatcher — compile failure
// ---------------------------------------------------------------------------

describe('PluginWatcher — compile failure', () => {
  let deps: PluginWatcherDeps;
  let watcher: PluginWatcher;
  let triggerChange: (filePath: string) => void;

  beforeEach(() => {
    deps = createDeps({
      watchDir: vi.fn().mockImplementation((_dir: string, callback: (filePath: string) => void) => {
        triggerChange = callback;
        return { close: vi.fn() };
      }),
      compileHandler: vi
        .fn()
        .mockResolvedValue({ success: false, error: 'SyntaxError: unexpected' }),
    });
    watcher = new PluginWatcher('/plugins', deps);
    watcher.start();
  });

  afterEach(() => {
    watcher.stop();
  });

  it('does not re-register tools on compile failure', async () => {
    triggerChange('weather/handler.ts');

    await new Promise((r) => setTimeout(r, 50));
    expect(deps.registerTools).not.toHaveBeenCalled();
  });

  it('outputs reload_failed with compile error', async () => {
    triggerChange('weather/handler.ts');

    await vi.waitFor(() => {
      const calls = (deps.output as ReturnType<typeof vi.fn>).mock.calls;
      const failed = calls.find((c) => (c[0] as string).includes('reload_failed'));
      expect(failed).toBeDefined();
      expect(failed![0] as string).toContain('SyntaxError');
    });
  });

  it('keeps watching after compile failure', async () => {
    triggerChange('weather/handler.ts');

    await new Promise((r) => setTimeout(r, 50));
    expect(watcher.isWatching()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PluginWatcher — debouncing
// ---------------------------------------------------------------------------

describe('PluginWatcher — debouncing', () => {
  let deps: PluginWatcherDeps;
  let watcher: PluginWatcher;
  let triggerChange: (filePath: string) => void;

  beforeEach(() => {
    deps = createDeps({
      watchDir: vi.fn().mockImplementation((_dir: string, callback: (filePath: string) => void) => {
        triggerChange = callback;
        return { close: vi.fn() };
      }),
    });
    watcher = new PluginWatcher('/plugins', deps, { debounceMs: 100 });
    watcher.start();
  });

  afterEach(() => {
    watcher.stop();
  });

  it('debounces rapid changes to the same plugin', async () => {
    triggerChange('weather/handler.ts');
    triggerChange('weather/handler.ts');
    triggerChange('weather/handler.ts');

    await vi.waitFor(() => {
      expect(deps.validatePlugin).toHaveBeenCalled();
    });

    // Should only have validated once despite 3 rapid changes
    expect(deps.validatePlugin).toHaveBeenCalledTimes(1);
  });

  it('handles changes to different plugins independently', async () => {
    (deps.listPluginDirs as ReturnType<typeof vi.fn>).mockReturnValue(['weather', 'calendar']);

    triggerChange('weather/handler.ts');
    triggerChange('calendar/handler.ts');

    await vi.waitFor(() => {
      expect(deps.validatePlugin).toHaveBeenCalledWith('weather');
      expect(deps.validatePlugin).toHaveBeenCalledWith('calendar');
    });
  });
});

// ---------------------------------------------------------------------------
// PluginWatcher — file filtering
// ---------------------------------------------------------------------------

describe('PluginWatcher — file filtering', () => {
  let deps: PluginWatcherDeps;
  let watcher: PluginWatcher;
  let triggerChange: (filePath: string) => void;

  beforeEach(() => {
    deps = createDeps({
      watchDir: vi.fn().mockImplementation((_dir: string, callback: (filePath: string) => void) => {
        triggerChange = callback;
        return { close: vi.fn() };
      }),
    });
    watcher = new PluginWatcher('/plugins', deps);
    watcher.start();
  });

  afterEach(() => {
    watcher.stop();
  });

  it('ignores changes to non-plugin files (node_modules)', async () => {
    triggerChange('weather/node_modules/pkg/index.js');

    await new Promise((r) => setTimeout(r, 50));
    expect(deps.validatePlugin).not.toHaveBeenCalled();
  });

  it('ignores hidden files (dotfiles)', async () => {
    triggerChange('weather/.git/index');

    await new Promise((r) => setTimeout(r, 50));
    expect(deps.validatePlugin).not.toHaveBeenCalled();
  });

  it('reacts to manifest.json changes', async () => {
    triggerChange('weather/manifest.json');

    await vi.waitFor(() => {
      expect(deps.validatePlugin).toHaveBeenCalledWith('weather');
    });
  });

  it('reacts to handler.ts changes', async () => {
    triggerChange('weather/handler.ts');

    await vi.waitFor(() => {
      expect(deps.validatePlugin).toHaveBeenCalledWith('weather');
    });
  });

  it('reacts to skill file changes', async () => {
    triggerChange('weather/skills/weather.md');

    await vi.waitFor(() => {
      expect(deps.validatePlugin).toHaveBeenCalledWith('weather');
    });
  });
});

// ---------------------------------------------------------------------------
// PluginWatcher — reloadPlugin (direct API)
// ---------------------------------------------------------------------------

describe('PluginWatcher — reloadPlugin', () => {
  let deps: PluginWatcherDeps;
  let watcher: PluginWatcher;

  beforeEach(() => {
    deps = createDeps();
    watcher = new PluginWatcher('/plugins', deps);
  });

  it('returns success on valid reload', async () => {
    const result = await watcher.reloadPlugin('weather');

    expect(result.success).toBe(true);
    expect(result.pluginName).toBe('weather');
  });

  it('returns failure with errors on validation failure', async () => {
    (deps.validatePlugin as ReturnType<typeof vi.fn>).mockReturnValue(
      invalidValidationResult('missing description'),
    );

    const result = await watcher.reloadPlugin('weather');

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('missing description');
  });

  it('returns failure with errors on compile failure', async () => {
    (deps.compileHandler as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'TypeError: x is not a function',
    });

    const result = await watcher.reloadPlugin('weather');

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes('TypeError'))).toBe(true);
  });

  it('unregisters old tools before registering new ones', async () => {
    const callOrder: string[] = [];
    (deps.unregisterTools as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('unregister');
    });
    (deps.registerTools as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('register');
    });

    await watcher.reloadPlugin('weather');

    expect(callOrder).toEqual(['unregister', 'register']);
  });

  it('does not register tools if unregister throws', async () => {
    (deps.unregisterTools as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('unregister failed');
    });

    const result = await watcher.reloadPlugin('weather');

    expect(result.success).toBe(false);
    expect(deps.registerTools).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PluginWatcher — output formatting
// ---------------------------------------------------------------------------

describe('PluginWatcher — output formatting', () => {
  let deps: PluginWatcherDeps;
  let watcher: PluginWatcher;

  beforeEach(() => {
    deps = createDeps();
    watcher = new PluginWatcher('/plugins', deps);
  });

  it('includes timestamp in output', async () => {
    await watcher.reloadPlugin('weather');

    const calls = (deps.output as ReturnType<typeof vi.fn>).mock.calls;
    const hasTimestamp = calls.some((c) => (c[0] as string).includes('12:00:00'));
    expect(hasTimestamp).toBe(true);
  });

  it('includes plugin name in output', async () => {
    await watcher.reloadPlugin('weather');

    const calls = (deps.output as ReturnType<typeof vi.fn>).mock.calls;
    const hasPlugin = calls.some((c) => (c[0] as string).includes('weather'));
    expect(hasPlugin).toBe(true);
  });

  it('shows what was reloaded on success', async () => {
    await watcher.reloadPlugin('weather');

    const calls = (deps.output as ReturnType<typeof vi.fn>).mock.calls;
    const success = calls.find((c) => (c[0] as string).includes('reload_success'));
    expect(success).toBeDefined();
    expect(success![0] as string).toContain('weather');
  });
});
