import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CarapaceConfig, RuntimeConfig } from './config.js';
import {
  resolveHome,
  ensureDirectoryStructure,
  parseConfig,
  DEFAULT_CONFIG,
  CARAPACE_SUBDIRS,
} from './config.js';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// resolveHome()
// ---------------------------------------------------------------------------

describe('resolveHome', () => {
  const originalEnv = process.env['CARAPACE_HOME'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['CARAPACE_HOME'] = originalEnv;
    } else {
      delete process.env['CARAPACE_HOME'];
    }
  });

  it('returns $CARAPACE_HOME when set', () => {
    process.env['CARAPACE_HOME'] = '/custom/path';
    expect(resolveHome()).toBe('/custom/path');
  });

  it('returns $CARAPACE_HOME with trailing slash stripped', () => {
    process.env['CARAPACE_HOME'] = '/custom/path/';
    expect(resolveHome()).toBe('/custom/path');
  });

  it('falls back to ~/.carapace when $CARAPACE_HOME is not set', () => {
    delete process.env['CARAPACE_HOME'];
    const result = resolveHome();
    const expected = join(process.env['HOME'] ?? '', '.carapace');
    expect(result).toBe(expected);
  });

  it('falls back to ~/.carapace when $CARAPACE_HOME is empty string', () => {
    process.env['CARAPACE_HOME'] = '';
    const result = resolveHome();
    const expected = join(process.env['HOME'] ?? '', '.carapace');
    expect(result).toBe(expected);
  });

  it('expands ~ in $CARAPACE_HOME', () => {
    process.env['CARAPACE_HOME'] = '~/my-carapace';
    const result = resolveHome();
    const home = process.env['HOME'] ?? '';
    expect(result).toBe(join(home, 'my-carapace'));
  });

  it('returns absolute path from $CARAPACE_HOME', () => {
    process.env['CARAPACE_HOME'] = '/absolute/path';
    const result = resolveHome();
    expect(result).toBe('/absolute/path');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_CONFIG
// ---------------------------------------------------------------------------

describe('DEFAULT_CONFIG', () => {
  it('has runtime defaults', () => {
    expect(DEFAULT_CONFIG.runtime.engine).toBe('docker');
    expect(DEFAULT_CONFIG.runtime.image).toBeUndefined();
  });

  it('has plugins defaults', () => {
    expect(DEFAULT_CONFIG.plugins.dirs).toEqual([]);
  });

  it('has security defaults', () => {
    expect(DEFAULT_CONFIG.security.max_sessions_per_group).toBe(3);
  });

  it('has hello defaults', () => {
    expect(DEFAULT_CONFIG.hello.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseConfig()
// ---------------------------------------------------------------------------

describe('parseConfig', () => {
  it('returns defaults for empty input', () => {
    const result = parseConfig({});
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it('merges runtime section', () => {
    const result = parseConfig({
      runtime: { engine: 'podman' },
    });
    expect(result.runtime.engine).toBe('podman');
    expect(result.runtime.image).toBeUndefined();
  });

  it('merges plugins section', () => {
    const result = parseConfig({
      plugins: { dirs: ['/extra/plugins'] },
    });
    expect(result.plugins.dirs).toEqual(['/extra/plugins']);
  });

  it('merges security section', () => {
    const result = parseConfig({
      security: { max_sessions_per_group: 5 },
    });
    expect(result.security.max_sessions_per_group).toBe(5);
  });

  it('merges hello section', () => {
    const result = parseConfig({
      hello: { enabled: false },
    });
    expect(result.hello.enabled).toBe(false);
  });

  it('accepts apple-container as engine', () => {
    const result = parseConfig({
      runtime: { engine: 'apple-container' },
    });
    expect(result.runtime.engine).toBe('apple-container');
  });

  it('rejects invalid engine value', () => {
    expect(() => parseConfig({ runtime: { engine: 'lxc' } })).toThrow(/invalid.*engine/i);
  });

  it('rejects negative max_sessions_per_group', () => {
    expect(() => parseConfig({ security: { max_sessions_per_group: -1 } })).toThrow(
      /max_sessions_per_group/,
    );
  });

  it('rejects zero max_sessions_per_group', () => {
    expect(() => parseConfig({ security: { max_sessions_per_group: 0 } })).toThrow(
      /max_sessions_per_group/,
    );
  });

  it('rejects non-integer max_sessions_per_group', () => {
    expect(() => parseConfig({ security: { max_sessions_per_group: 2.5 } })).toThrow(
      /max_sessions_per_group/,
    );
  });

  it('preserves unknown top-level sections for extensibility', () => {
    const result = parseConfig({
      custom_plugin_section: { foo: 'bar' },
    });
    // Unknown sections should be passed through without error
    expect((result as Record<string, unknown>)['custom_plugin_section']).toEqual({
      foo: 'bar',
    });
  });

  it('rejects non-array plugins.dirs', () => {
    expect(() => parseConfig({ plugins: { dirs: '/not/an/array' as unknown } })).toThrow(
      /dirs.*array/i,
    );
  });

  it('rejects non-string entries in plugins.dirs', () => {
    expect(() => parseConfig({ plugins: { dirs: [123 as unknown] } })).toThrow(/dirs.*string/i);
  });

  it('parses network section with allowed_hosts', () => {
    const result = parseConfig({
      network: {
        allowed_hosts: [
          { hostname: 'api.anthropic.com', port: 443 },
          { hostname: 'custom.api.com', port: 8443 },
        ],
      },
    });
    expect(result.network.allowed_hosts).toHaveLength(2);
    expect(result.network.allowed_hosts![0].hostname).toBe('api.anthropic.com');
    expect(result.network.allowed_hosts![1].port).toBe(8443);
  });

  it('uses default empty allowed_hosts when network section is absent', () => {
    const result = parseConfig({});
    expect(result.network.allowed_hosts).toBeUndefined();
  });

  it('rejects non-array network.allowed_hosts', () => {
    expect(() => parseConfig({ network: { allowed_hosts: 'not-an-array' as unknown } })).toThrow(
      /allowed_hosts.*array/i,
    );
  });

  it('rejects allowed_hosts entries without hostname', () => {
    expect(() => parseConfig({ network: { allowed_hosts: [{ port: 443 }] } })).toThrow(
      /hostname.*string/i,
    );
  });

  it('rejects allowed_hosts entries without port', () => {
    expect(() =>
      parseConfig({ network: { allowed_hosts: [{ hostname: 'example.com' }] } }),
    ).toThrow(/port.*number/i);
  });

  it('rejects allowed_hosts entries with invalid port', () => {
    expect(() =>
      parseConfig({
        network: { allowed_hosts: [{ hostname: 'example.com', port: -1 }] },
      }),
    ).toThrow(/port.*1.*65535/i);
  });

  it('parses logging section with valid level', () => {
    const result = parseConfig({ logging: { level: 'debug' } });
    expect(result.logging.level).toBe('debug');
  });

  it('defaults logging level to info when logging section is absent', () => {
    const result = parseConfig({});
    expect(result.logging.level).toBe('info');
  });

  it('rejects invalid logging level', () => {
    expect(() => parseConfig({ logging: { level: 'verbose' } })).toThrow(
      /invalid.*logging\.level/i,
    );
  });
});

// ---------------------------------------------------------------------------
// CarapaceConfig type
// ---------------------------------------------------------------------------

describe('CarapaceConfig type structure', () => {
  it('is constructable with all sections', () => {
    const config: CarapaceConfig = {
      runtime: { engine: 'docker' },
      plugins: { dirs: [] },
      security: { max_sessions_per_group: 3 },
      network: {},
      logging: { level: 'info' },
      hello: { enabled: true },
    };
    expect(config.runtime.engine).toBe('docker');
    expect(config.plugins.dirs).toEqual([]);
    expect(config.security.max_sessions_per_group).toBe(3);
    expect(config.hello.enabled).toBe(true);
  });

  it('runtime config allows image field', () => {
    const runtime: RuntimeConfig = {
      engine: 'docker',
      image: 'ghcr.io/fred-drake/carapace-agent@sha256:abc123',
    };
    expect(runtime.image).toBe('ghcr.io/fred-drake/carapace-agent@sha256:abc123');
  });
});

// ---------------------------------------------------------------------------
// CARAPACE_SUBDIRS
// ---------------------------------------------------------------------------

describe('CARAPACE_SUBDIRS', () => {
  it('lists all required subdirectories', () => {
    expect(CARAPACE_SUBDIRS).toContain('bin');
    expect(CARAPACE_SUBDIRS).toContain('lib');
    expect(CARAPACE_SUBDIRS).toContain('lib/dist');
    expect(CARAPACE_SUBDIRS).toContain('lib/node_modules');
    expect(CARAPACE_SUBDIRS).toContain('lib/plugins');
    expect(CARAPACE_SUBDIRS).toContain('plugins');
    expect(CARAPACE_SUBDIRS).toContain('data');
    expect(CARAPACE_SUBDIRS).toContain('data/audit');
    expect(CARAPACE_SUBDIRS).toContain('data/memory');
    expect(CARAPACE_SUBDIRS).toContain('credentials');
    expect(CARAPACE_SUBDIRS).toContain('run');
    expect(CARAPACE_SUBDIRS).toContain('run/sockets');
  });
});

// ---------------------------------------------------------------------------
// ensureDirectoryStructure()
// ---------------------------------------------------------------------------

describe('ensureDirectoryStructure', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = join(tmpdir(), `carapace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('creates all required subdirectories', () => {
    const result = ensureDirectoryStructure(testRoot);
    for (const subdir of CARAPACE_SUBDIRS) {
      expect(existsSync(join(testRoot, subdir))).toBe(true);
    }
    expect(result.root).toBe(testRoot);
  });

  it('returns DirectoryStructure with correct paths', () => {
    const result = ensureDirectoryStructure(testRoot);
    expect(result.root).toBe(testRoot);
    expect(result.bin).toBe(join(testRoot, 'bin'));
    expect(result.lib).toBe(join(testRoot, 'lib'));
    expect(result.plugins).toBe(join(testRoot, 'plugins'));
    expect(result.data).toBe(join(testRoot, 'data'));
    expect(result.credentials).toBe(join(testRoot, 'credentials'));
    expect(result.run).toBe(join(testRoot, 'run'));
    expect(result.sockets).toBe(join(testRoot, 'run/sockets'));
    expect(result.configFile).toBe(join(testRoot, 'config.toml'));
  });

  it('is idempotent — calling twice does not error', () => {
    ensureDirectoryStructure(testRoot);
    expect(() => ensureDirectoryStructure(testRoot)).not.toThrow();
  });

  it('sets credentials directory to 0700', () => {
    ensureDirectoryStructure(testRoot);
    const stats = statSync(join(testRoot, 'credentials'));
    // 0o700 = rwx------ (owner only)
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('sets run/sockets directory to 0700', () => {
    ensureDirectoryStructure(testRoot);
    const stats = statSync(join(testRoot, 'run/sockets'));
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('creates root directory if it does not exist', () => {
    const nested = join(testRoot, 'deep', 'nested');
    ensureDirectoryStructure(nested);
    expect(existsSync(nested)).toBe(true);
  });

  it('classifies directories as mutable or immutable', () => {
    const result = ensureDirectoryStructure(testRoot);
    // Mutable directories (user-writable at runtime)
    expect(result.mutableDirs).toContain(join(testRoot, 'plugins'));
    expect(result.mutableDirs).toContain(join(testRoot, 'data'));
    expect(result.mutableDirs).toContain(join(testRoot, 'data/audit'));
    expect(result.mutableDirs).toContain(join(testRoot, 'data/memory'));
    expect(result.mutableDirs).toContain(join(testRoot, 'credentials'));
    expect(result.mutableDirs).toContain(join(testRoot, 'run'));
    expect(result.mutableDirs).toContain(join(testRoot, 'run/sockets'));
    // Immutable directories (installed artifacts, read-only)
    expect(result.immutableDirs).toContain(join(testRoot, 'bin'));
    expect(result.immutableDirs).toContain(join(testRoot, 'lib'));
    expect(result.immutableDirs).toContain(join(testRoot, 'lib/dist'));
    expect(result.immutableDirs).toContain(join(testRoot, 'lib/node_modules'));
    expect(result.immutableDirs).toContain(join(testRoot, 'lib/plugins'));
  });
});
