/**
 * Carapace configuration schema and CARAPACE_HOME resolution.
 *
 * Defines the TypeScript types for config.toml sections, the
 * $CARAPACE_HOME resolution algorithm, and the directory structure
 * contract. See docs/INSTALL_STRATEGY.md §2 and §8.
 */

import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Container engine union
// ---------------------------------------------------------------------------

/** Supported container runtime engines. */
export type ContainerEngine = 'docker' | 'podman' | 'apple-container';

const VALID_ENGINES: ReadonlySet<string> = new Set<ContainerEngine>([
  'docker',
  'podman',
  'apple-container',
]);

// ---------------------------------------------------------------------------
// Config section types
// ---------------------------------------------------------------------------

/** `[runtime]` section of config.toml. */
export interface RuntimeConfig {
  engine: ContainerEngine;
  image?: string;
}

/** `[plugins]` section of config.toml. */
export interface PluginsConfig {
  dirs: string[];
}

/** `[security]` section of config.toml. */
export interface SecurityConfig {
  max_sessions_per_group: number;
}

/** `[hello]` section of config.toml. */
export interface HelloConfig {
  enabled: boolean;
}

/** A single allowed host entry in the network allowlist. */
export interface AllowedHost {
  hostname: string;
  port: number;
}

/** `[network]` section of config.toml. */
export interface NetworkConfig {
  allowed_hosts?: AllowedHost[];
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

/**
 * Full Carapace configuration.
 *
 * Known sections are strongly typed. Unknown top-level keys are
 * preserved as-is for forward compatibility — future sections can
 * be added without breaking existing config files.
 */
export interface CarapaceConfig {
  runtime: RuntimeConfig;
  plugins: PluginsConfig;
  security: SecurityConfig;
  hello: HelloConfig;
  network: NetworkConfig;
  [section: string]: unknown;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default configuration applied when config.toml is absent or partial. */
export const DEFAULT_CONFIG: CarapaceConfig = {
  runtime: { engine: 'docker' },
  plugins: { dirs: [] },
  security: { max_sessions_per_group: 3 },
  hello: { enabled: true },
  network: {},
};

// ---------------------------------------------------------------------------
// resolveHome()
// ---------------------------------------------------------------------------

/**
 * Resolve the Carapace home directory.
 *
 * Precedence:
 *  1. `$CARAPACE_HOME` environment variable (if non-empty)
 *  2. `~/.carapace/` default
 *
 * Trailing slashes are stripped. A leading `~` is expanded to the
 * user's home directory.
 */
export function resolveHome(): string {
  const envValue = process.env['CARAPACE_HOME'];
  if (envValue && envValue.length > 0) {
    let resolved = envValue;
    // Expand leading ~
    if (resolved.startsWith('~/') || resolved === '~') {
      resolved = join(homedir(), resolved.slice(2));
    }
    // Strip trailing slash
    if (resolved.length > 1 && resolved.endsWith('/')) {
      resolved = resolved.slice(0, -1);
    }
    return resolved;
  }
  return join(homedir(), '.carapace');
}

// ---------------------------------------------------------------------------
// Directory structure
// ---------------------------------------------------------------------------

/**
 * All subdirectories that must exist under `$CARAPACE_HOME`.
 * Order matters — parents are listed before children.
 */
export const CARAPACE_SUBDIRS = [
  'bin',
  'lib',
  'lib/dist',
  'lib/node_modules',
  'lib/plugins',
  'plugins',
  'data',
  'data/audit',
  'data/memory',
  'credentials',
  'run',
  'run/sockets',
] as const;

/** Subdirectories that require restricted permissions (0700). */
const RESTRICTED_DIRS: ReadonlySet<string> = new Set(['credentials', 'run/sockets']);

/** Subdirectories that are mutable at runtime. */
const MUTABLE_SUBDIRS: ReadonlySet<string> = new Set([
  'plugins',
  'data',
  'data/audit',
  'data/memory',
  'credentials',
  'run',
  'run/sockets',
]);

/** Result of `ensureDirectoryStructure()` with resolved paths. */
export interface DirectoryStructure {
  root: string;
  bin: string;
  lib: string;
  plugins: string;
  data: string;
  credentials: string;
  run: string;
  sockets: string;
  configFile: string;
  mutableDirs: string[];
  immutableDirs: string[];
}

/**
 * Create the `$CARAPACE_HOME` directory tree.
 *
 * Idempotent — safe to call on every startup. Creates all required
 * subdirectories and sets restricted permissions on sensitive dirs
 * (`credentials/` → 0700, `run/sockets/` → 0700).
 */
export function ensureDirectoryStructure(root: string): DirectoryStructure {
  // Create root (and any missing parents)
  mkdirSync(root, { recursive: true });

  const mutableDirs: string[] = [];
  const immutableDirs: string[] = [];

  for (const subdir of CARAPACE_SUBDIRS) {
    const fullPath = join(root, subdir);
    mkdirSync(fullPath, { recursive: true });

    if (RESTRICTED_DIRS.has(subdir)) {
      chmodSync(fullPath, 0o700);
    }

    if (MUTABLE_SUBDIRS.has(subdir)) {
      mutableDirs.push(fullPath);
    } else {
      immutableDirs.push(fullPath);
    }
  }

  return {
    root,
    bin: join(root, 'bin'),
    lib: join(root, 'lib'),
    plugins: join(root, 'plugins'),
    data: join(root, 'data'),
    credentials: join(root, 'credentials'),
    run: join(root, 'run'),
    sockets: join(root, 'run/sockets'),
    configFile: join(root, 'config.toml'),
    mutableDirs,
    immutableDirs,
  };
}

// ---------------------------------------------------------------------------
// parseConfig()
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw config object (e.g. from TOML parsing) into
 * a fully typed `CarapaceConfig`. Applies defaults for missing sections
 * and validates known fields.
 *
 * Unknown top-level sections are passed through for extensibility.
 */
export function parseConfig(raw: Record<string, unknown>): CarapaceConfig {
  const result: Record<string, unknown> = {};

  // Copy unknown sections first (extensibility)
  for (const key of Object.keys(raw)) {
    if (!['runtime', 'plugins', 'security', 'hello', 'network'].includes(key)) {
      result[key] = raw[key];
    }
  }

  // --- runtime ---
  const rawRuntime = (raw['runtime'] ?? {}) as Record<string, unknown>;
  const engine = (rawRuntime['engine'] as string) ?? DEFAULT_CONFIG.runtime.engine;
  if (!VALID_ENGINES.has(engine)) {
    throw new Error(
      `Invalid runtime.engine: "${engine}". ` + `Must be one of: ${[...VALID_ENGINES].join(', ')}`,
    );
  }
  const runtime: RuntimeConfig = {
    engine: engine as ContainerEngine,
  };
  if (rawRuntime['image'] !== undefined) {
    runtime.image = rawRuntime['image'] as string;
  }
  result['runtime'] = runtime;

  // --- plugins ---
  const rawPlugins = (raw['plugins'] ?? {}) as Record<string, unknown>;
  const dirs = rawPlugins['dirs'] ?? DEFAULT_CONFIG.plugins.dirs;
  if (!Array.isArray(dirs)) {
    throw new Error('plugins.dirs must be an array');
  }
  for (const entry of dirs) {
    if (typeof entry !== 'string') {
      throw new Error('plugins.dirs entries must be strings');
    }
  }
  result['plugins'] = { dirs: dirs as string[] };

  // --- security ---
  const rawSecurity = (raw['security'] ?? {}) as Record<string, unknown>;
  const maxSessions =
    (rawSecurity['max_sessions_per_group'] as number | undefined) ??
    DEFAULT_CONFIG.security.max_sessions_per_group;
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error('security.max_sessions_per_group must be a positive integer');
  }
  result['security'] = { max_sessions_per_group: maxSessions };

  // --- hello ---
  const rawHello = (raw['hello'] ?? {}) as Record<string, unknown>;
  const enabled = (rawHello['enabled'] as boolean | undefined) ?? DEFAULT_CONFIG.hello.enabled;
  result['hello'] = { enabled };

  // --- network ---
  const rawNetwork = (raw['network'] ?? {}) as Record<string, unknown>;
  const networkConfig: NetworkConfig = {};
  if (rawNetwork['allowed_hosts'] !== undefined) {
    const hosts = rawNetwork['allowed_hosts'];
    if (!Array.isArray(hosts)) {
      throw new Error('network.allowed_hosts must be an array');
    }
    for (const entry of hosts) {
      const obj = entry as Record<string, unknown>;
      if (typeof obj['hostname'] !== 'string') {
        throw new Error('network.allowed_hosts entries must have a hostname string');
      }
      if (typeof obj['port'] !== 'number') {
        throw new Error('network.allowed_hosts entries must have a port number');
      }
      const p = obj['port'] as number;
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        throw new Error('network.allowed_hosts port must be an integer between 1 and 65535');
      }
    }
    networkConfig.allowed_hosts = hosts as AllowedHost[];
  }
  result['network'] = networkConfig;

  return result as CarapaceConfig;
}
