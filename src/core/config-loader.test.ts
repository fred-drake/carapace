import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, readVersion, writeVersion, initialize } from './config-loader.js';
import { DEFAULT_CONFIG } from '../types/config.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTempRoot(): string {
  const root = join(
    tmpdir(),
    `carapace-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// loadConfig()
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = createTempRoot();
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('returns DEFAULT_CONFIG when config.toml does not exist', () => {
    const config = loadConfig(testRoot);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('parses a minimal config.toml with runtime section', () => {
    writeFileSync(join(testRoot, 'config.toml'), `[runtime]\nengine = "podman"\n`, 'utf-8');
    const config = loadConfig(testRoot);
    expect(config.runtime.engine).toBe('podman');
  });

  it('parses config.toml with all sections', () => {
    const toml = `
[runtime]
engine = "apple-container"
image = "ghcr.io/fred-drake/carapace-agent@sha256:abc123"

[plugins]
dirs = ["/extra/plugins", "~/my-plugins"]

[security]
max_sessions_per_group = 5

[hello]
enabled = false
`;
    writeFileSync(join(testRoot, 'config.toml'), toml, 'utf-8');
    const config = loadConfig(testRoot);
    expect(config.runtime.engine).toBe('apple-container');
    expect(config.runtime.image).toBe('ghcr.io/fred-drake/carapace-agent@sha256:abc123');
    expect(config.plugins.dirs).toEqual(['/extra/plugins', '~/my-plugins']);
    expect(config.security.max_sessions_per_group).toBe(5);
    expect(config.hello.enabled).toBe(false);
  });

  it('applies defaults for missing sections', () => {
    writeFileSync(join(testRoot, 'config.toml'), `[runtime]\nengine = "docker"\n`, 'utf-8');
    const config = loadConfig(testRoot);
    expect(config.plugins.dirs).toEqual([]);
    expect(config.security.max_sessions_per_group).toBe(3);
    expect(config.hello.enabled).toBe(true);
  });

  it('preserves unknown top-level sections', () => {
    const toml = `
[custom_section]
key = "value"
`;
    writeFileSync(join(testRoot, 'config.toml'), toml, 'utf-8');
    const config = loadConfig(testRoot);
    expect((config as Record<string, unknown>)['custom_section']).toEqual({
      key: 'value',
    });
  });

  it('throws on invalid TOML syntax', () => {
    writeFileSync(join(testRoot, 'config.toml'), 'this is not valid toml [[[', 'utf-8');
    expect(() => loadConfig(testRoot)).toThrow();
  });

  it('throws on invalid engine value', () => {
    writeFileSync(join(testRoot, 'config.toml'), `[runtime]\nengine = "lxc"\n`, 'utf-8');
    expect(() => loadConfig(testRoot)).toThrow(/invalid.*engine/i);
  });

  it('throws on invalid security values', () => {
    writeFileSync(
      join(testRoot, 'config.toml'),
      `[security]\nmax_sessions_per_group = -1\n`,
      'utf-8',
    );
    expect(() => loadConfig(testRoot)).toThrow(/max_sessions_per_group/);
  });

  it('handles TOML comments correctly', () => {
    const toml = `
# This is a comment
[runtime]
engine = "docker" # inline comment
`;
    writeFileSync(join(testRoot, 'config.toml'), toml, 'utf-8');
    const config = loadConfig(testRoot);
    expect(config.runtime.engine).toBe('docker');
  });

  it('handles empty config.toml', () => {
    writeFileSync(join(testRoot, 'config.toml'), '', 'utf-8');
    const config = loadConfig(testRoot);
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});

// ---------------------------------------------------------------------------
// readVersion()
// ---------------------------------------------------------------------------

describe('readVersion', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = createTempRoot();
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('returns null when version file does not exist', () => {
    expect(readVersion(testRoot)).toBeNull();
  });

  it('reads version from file', () => {
    writeFileSync(join(testRoot, 'version'), '1.2.3\n', 'utf-8');
    expect(readVersion(testRoot)).toBe('1.2.3');
  });

  it('trims whitespace from version string', () => {
    writeFileSync(join(testRoot, 'version'), '  1.0.0-beta.1  \n', 'utf-8');
    expect(readVersion(testRoot)).toBe('1.0.0-beta.1');
  });

  it('returns empty string for empty version file', () => {
    writeFileSync(join(testRoot, 'version'), '', 'utf-8');
    expect(readVersion(testRoot)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// writeVersion()
// ---------------------------------------------------------------------------

describe('writeVersion', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = createTempRoot();
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('writes version to file with trailing newline', () => {
    writeVersion('2.0.0', testRoot);
    const content = readFileSync(join(testRoot, 'version'), 'utf-8');
    expect(content).toBe('2.0.0\n');
  });

  it('overwrites existing version file', () => {
    writeFileSync(join(testRoot, 'version'), '1.0.0\n', 'utf-8');
    writeVersion('2.0.0', testRoot);
    const content = readFileSync(join(testRoot, 'version'), 'utf-8');
    expect(content).toBe('2.0.0\n');
  });

  it('written version is readable by readVersion', () => {
    writeVersion('3.1.4', testRoot);
    expect(readVersion(testRoot)).toBe('3.1.4');
  });
});

// ---------------------------------------------------------------------------
// initialize()
// ---------------------------------------------------------------------------

describe('initialize', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = createTempRoot();
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('creates directory structure and returns config with defaults', () => {
    const result = initialize(testRoot);
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.dirs.root).toBe(testRoot);
    expect(result.version).toBeNull();
    expect(existsSync(join(testRoot, 'bin'))).toBe(true);
    expect(existsSync(join(testRoot, 'data'))).toBe(true);
    expect(existsSync(join(testRoot, 'credentials'))).toBe(true);
  });

  it('loads existing config.toml during initialization', () => {
    writeFileSync(join(testRoot, 'config.toml'), `[runtime]\nengine = "podman"\n`, 'utf-8');
    const result = initialize(testRoot);
    expect(result.config.runtime.engine).toBe('podman');
  });

  it('reads existing version during initialization', () => {
    writeFileSync(join(testRoot, 'version'), '1.5.0\n', 'utf-8');
    const result = initialize(testRoot);
    expect(result.version).toBe('1.5.0');
  });

  it('returns all three fields: config, dirs, version', () => {
    writeFileSync(join(testRoot, 'config.toml'), `[runtime]\nengine = "docker"\n`, 'utf-8');
    writeFileSync(join(testRoot, 'version'), '2.0.0\n', 'utf-8');
    const result = initialize(testRoot);
    expect(result.config.runtime.engine).toBe('docker');
    expect(result.dirs.bin).toBe(join(testRoot, 'bin'));
    expect(result.dirs.sockets).toBe(join(testRoot, 'run/sockets'));
    expect(result.dirs.configFile).toBe(join(testRoot, 'config.toml'));
    expect(result.version).toBe('2.0.0');
  });

  it('is idempotent', () => {
    initialize(testRoot);
    expect(() => initialize(testRoot)).not.toThrow();
  });
});
