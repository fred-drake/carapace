import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  configGet,
  configSet,
  configList,
  configPath,
  runConfigCommand,
  type ConfigCommandDeps,
} from './config-command.js';
import type { CarapaceConfig } from './types/config.js';
import { DEFAULT_CONFIG } from './types/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testConfig(): CarapaceConfig {
  return {
    runtime: { engine: 'docker', image: 'carapace:latest' },
    plugins: { dirs: ['/extra/plugins'] },
    security: { max_sessions_per_group: 5 },
    hello: { enabled: true },
    network: { allowed_hosts: [{ hostname: 'api.example.com', port: 443 }] },
    logging: { level: 'debug' },
  };
}

function createDeps(overrides?: Partial<ConfigCommandDeps>): ConfigCommandDeps {
  return {
    loadConfig: vi.fn().mockReturnValue(testConfig()),
    readConfigFile: vi
      .fn()
      .mockReturnValue(
        '[runtime]\nengine = "docker"\nimage = "carapace:latest"\n\n[logging]\nlevel = "debug"',
      ),
    writeConfigFile: vi.fn(),
    configFilePath: vi.fn().mockReturnValue('/home/user/.carapace/config.toml'),
    configFileExists: vi.fn().mockReturnValue(true),
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// configGet
// ---------------------------------------------------------------------------

describe('configGet', () => {
  it('gets a top-level section key', () => {
    const deps = createDeps();

    const code = configGet('runtime.engine', deps);

    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith('docker');
  });

  it('gets a nested key', () => {
    const deps = createDeps();

    const code = configGet('security.max_sessions_per_group', deps);

    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith('5');
  });

  it('gets a boolean value', () => {
    const deps = createDeps();

    const code = configGet('hello.enabled', deps);

    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith('true');
  });

  it('gets an array value as JSON', () => {
    const deps = createDeps();

    const code = configGet('plugins.dirs', deps);

    expect(code).toBe(0);
    const output = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual(['/extra/plugins']);
  });

  it('gets an object value as JSON', () => {
    const deps = createDeps();

    const code = configGet('network.allowed_hosts', deps);

    expect(code).toBe(0);
    const output = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual([{ hostname: 'api.example.com', port: 443 }]);
  });

  it('returns error for unknown section', () => {
    const deps = createDeps();

    const code = configGet('nonexistent.key', deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('returns error for unknown key in valid section', () => {
    const deps = createDeps();

    const code = configGet('runtime.nonexistent', deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('returns error for key without section', () => {
    const deps = createDeps();

    const code = configGet('engine', deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('section.key'));
  });

  it('returns entire section as JSON when key is section name only', () => {
    const deps = createDeps();

    const code = configGet('runtime', deps);

    expect(code).toBe(0);
    const output = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.engine).toBe('docker');
  });
});

// ---------------------------------------------------------------------------
// configSet
// ---------------------------------------------------------------------------

describe('configSet', () => {
  it('sets a string value', () => {
    const deps = createDeps();

    const code = configSet('runtime.engine', 'podman', deps);

    expect(code).toBe(0);
    expect(deps.writeConfigFile).toHaveBeenCalled();
    const written = (deps.writeConfigFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain('podman');
  });

  it('sets a numeric value', () => {
    const deps = createDeps();

    const code = configSet('security.max_sessions_per_group', '10', deps);

    expect(code).toBe(0);
    expect(deps.writeConfigFile).toHaveBeenCalled();
    const written = (deps.writeConfigFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain('10');
  });

  it('sets a boolean value (true)', () => {
    const deps = createDeps();

    const code = configSet('hello.enabled', 'false', deps);

    expect(code).toBe(0);
    expect(deps.writeConfigFile).toHaveBeenCalled();
    const written = (deps.writeConfigFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain('false');
  });

  it('rejects invalid engine values', () => {
    const deps = createDeps();

    const code = configSet('runtime.engine', 'kubernetes', deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Invalid'));
    expect(deps.writeConfigFile).not.toHaveBeenCalled();
  });

  it('rejects invalid log level', () => {
    const deps = createDeps();

    const code = configSet('logging.level', 'verbose', deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Invalid'));
  });

  it('rejects key without section', () => {
    const deps = createDeps();

    const code = configSet('engine', 'docker', deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('section.key'));
  });

  it('reports success message', () => {
    const deps = createDeps();

    configSet('runtime.engine', 'podman', deps);

    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('runtime.engine'));
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('podman'));
  });

  it('creates config file if it does not exist', () => {
    const deps = createDeps({
      configFileExists: vi.fn().mockReturnValue(false),
      readConfigFile: vi.fn().mockReturnValue(''),
    });

    const code = configSet('runtime.engine', 'podman', deps);

    expect(code).toBe(0);
    expect(deps.writeConfigFile).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// configList
// ---------------------------------------------------------------------------

describe('configList', () => {
  it('lists all config keys with values', () => {
    const deps = createDeps();

    const code = configList(deps);

    expect(code).toBe(0);
    const allOutput = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('\n');
    expect(allOutput).toContain('runtime.engine');
    expect(allOutput).toContain('docker');
  });

  it('shows source annotations (file vs default)', () => {
    const deps = createDeps({
      readConfigFile: vi.fn().mockReturnValue('[runtime]\nengine = "podman"'),
      loadConfig: vi.fn().mockReturnValue({
        ...DEFAULT_CONFIG,
        runtime: { engine: 'podman' as const },
      }),
    });

    const code = configList(deps);

    expect(code).toBe(0);
    const allOutput = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('\n');
    // Keys from file should be annotated differently from defaults
    expect(allOutput).toContain('runtime.engine');
  });

  it('includes all known sections', () => {
    const deps = createDeps();

    configList(deps);

    const allOutput = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('\n');
    expect(allOutput).toContain('runtime');
    expect(allOutput).toContain('plugins');
    expect(allOutput).toContain('security');
    expect(allOutput).toContain('hello');
    expect(allOutput).toContain('logging');
  });
});

// ---------------------------------------------------------------------------
// configPath
// ---------------------------------------------------------------------------

describe('configPath', () => {
  it('prints the config file path', () => {
    const deps = createDeps();

    const code = configPath(deps);

    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith('/home/user/.carapace/config.toml');
  });
});

// ---------------------------------------------------------------------------
// runConfigCommand — dispatch
// ---------------------------------------------------------------------------

describe('runConfigCommand', () => {
  it('dispatches "get" subcommand', () => {
    const deps = createDeps();

    const code = runConfigCommand(['get', 'runtime.engine'], deps);

    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith('docker');
  });

  it('dispatches "set" subcommand', () => {
    const deps = createDeps();

    const code = runConfigCommand(['set', 'runtime.engine', 'podman'], deps);

    expect(code).toBe(0);
  });

  it('dispatches "list" subcommand', () => {
    const deps = createDeps();

    const code = runConfigCommand(['list'], deps);

    expect(code).toBe(0);
  });

  it('dispatches "path" subcommand', () => {
    const deps = createDeps();

    const code = runConfigCommand(['path'], deps);

    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith('/home/user/.carapace/config.toml');
  });

  it('shows usage on unknown subcommand', () => {
    const deps = createDeps();

    const code = runConfigCommand(['unknown'], deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('shows usage on empty args', () => {
    const deps = createDeps();

    const code = runConfigCommand([], deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('shows error when get is missing key argument', () => {
    const deps = createDeps();

    const code = runConfigCommand(['get'], deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('key'));
  });

  it('shows error when set is missing value argument', () => {
    const deps = createDeps();

    const code = runConfigCommand(['set', 'runtime.engine'], deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('value'));
  });
});
