/**
 * Config subcommand for Carapace CLI.
 *
 * Provides `carapace config` with subcommands:
 *   - `get <key>`          — Print a config value
 *   - `set <key> <value>`  — Set a config value in config.toml
 *   - `list`               — Show all config with source annotations
 *   - `path`               — Print config file path
 *
 * User-facing layer on top of the TOML config parser from ENG-20.
 */

import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';
import type { CarapaceConfig } from './types/config.js';
import { DEFAULT_CONFIG } from './types/config.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Injectable dependencies for config commands. */
export interface ConfigCommandDeps {
  /** Load and validate the config (returns merged config with defaults). */
  loadConfig: () => CarapaceConfig;
  /** Read the raw config.toml contents. Returns empty string if missing. */
  readConfigFile: () => string;
  /** Write new contents to config.toml. */
  writeConfigFile: (content: string) => void;
  /** Get the absolute path to config.toml. */
  configFilePath: () => string;
  /** Check if config.toml exists. */
  configFileExists: () => boolean;
  /** Write to stdout. */
  stdout: (msg: string) => void;
  /** Write to stderr. */
  stderr: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Validation rules for known keys
// ---------------------------------------------------------------------------

const VALID_ENGINES = new Set(['docker', 'podman', 'apple-container']);
const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/** Known sections and their simple scalar keys for validation. */
const KNOWN_SECTIONS: Record<string, Set<string>> = {
  runtime: new Set(['engine', 'image']),
  plugins: new Set(['dirs']),
  security: new Set(['max_sessions_per_group']),
  hello: new Set(['enabled']),
  network: new Set(['allowed_hosts']),
  logging: new Set(['level']),
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const CONFIG_USAGE = `Usage: carapace config <subcommand>

Subcommands:
  get <key>            Print a config value (e.g. runtime.engine)
  set <key> <value>    Set a config value in config.toml
  list                 Show all config with source annotations
  path                 Print config file path

Keys use dotted notation: section.key (e.g. runtime.engine, logging.level)`;

// ---------------------------------------------------------------------------
// runConfigCommand — dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a config subcommand.
 *
 * @param args - Arguments after "config" (e.g. ["get", "runtime.engine"]).
 * @param deps - Injectable dependencies.
 * @returns Exit code (0 = success, 1 = failure).
 */
export function runConfigCommand(args: string[], deps: ConfigCommandDeps): number {
  const subcommand = args[0];

  if (!subcommand) {
    deps.stderr(CONFIG_USAGE);
    return 1;
  }

  switch (subcommand) {
    case 'get': {
      const key = args[1];
      if (!key) {
        deps.stderr('Error: missing key argument\nUsage: carapace config get <key>');
        return 1;
      }
      return configGet(key, deps);
    }
    case 'set': {
      const key = args[1];
      const value = args[2];
      if (!key) {
        deps.stderr('Error: missing key argument\nUsage: carapace config set <key> <value>');
        return 1;
      }
      if (value === undefined) {
        deps.stderr('Error: missing value argument\nUsage: carapace config set <key> <value>');
        return 1;
      }
      return configSet(key, value, deps);
    }
    case 'list':
      return configList(deps);
    case 'path':
      return configPath(deps);
    default:
      deps.stderr(`Unknown subcommand: "${subcommand}"\n${CONFIG_USAGE}`);
      return 1;
  }
}

// ---------------------------------------------------------------------------
// configGet
// ---------------------------------------------------------------------------

/**
 * Print a config value to stdout.
 *
 * Supports dotted keys (`section.key`) and section-only keys (`section`).
 * Arrays and objects are printed as JSON. Scalars are printed as plain text.
 */
export function configGet(key: string, deps: ConfigCommandDeps): number {
  const config = deps.loadConfig();

  // Section-only key (no dot) — return entire section as JSON
  if (!key.includes('.')) {
    const section = config[key];
    if (section === undefined) {
      deps.stderr(`Error: key format must be section.key (e.g. runtime.engine)`);
      return 1;
    }
    deps.stdout(JSON.stringify(section, null, 2));
    return 0;
  }

  const { section, field } = parseKey(key);

  const sectionObj = config[section];
  if (sectionObj === undefined || typeof sectionObj !== 'object' || sectionObj === null) {
    deps.stderr(`Error: section "${section}" not found`);
    return 1;
  }

  const value = (sectionObj as Record<string, unknown>)[field];
  if (value === undefined) {
    deps.stderr(`Error: key "${key}" not found`);
    return 1;
  }

  deps.stdout(formatValue(value));
  return 0;
}

// ---------------------------------------------------------------------------
// configSet
// ---------------------------------------------------------------------------

/**
 * Set a config value in config.toml.
 *
 * Validates the value against known key constraints before writing.
 * Creates config.toml if it doesn't exist.
 */
export function configSet(key: string, rawValue: string, deps: ConfigCommandDeps): number {
  if (!key.includes('.')) {
    deps.stderr('Error: key format must be section.key (e.g. runtime.engine)');
    return 1;
  }

  const { section, field } = parseKey(key);

  // Validate against known constraints
  const validationError = validateSetValue(section, field, rawValue);
  if (validationError) {
    deps.stderr(`Error: Invalid value for ${key}: ${validationError}`);
    return 1;
  }

  // Read existing TOML (or start fresh)
  const existing = deps.configFileExists() ? deps.readConfigFile() : '';
  let parsed: Record<string, unknown>;
  try {
    parsed = existing.trim().length > 0 ? (parseTOML(existing) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }

  // Ensure section exists
  if (!parsed[section] || typeof parsed[section] !== 'object') {
    parsed[section] = {};
  }

  // Coerce value to the right type
  const coerced = coerceValue(section, field, rawValue);
  (parsed[section] as Record<string, unknown>)[field] = coerced;

  // Write back
  const toml = stringifyTOML(parsed as Record<string, unknown>);
  deps.writeConfigFile(toml);

  deps.stdout(`Set ${key} = ${formatValue(coerced)}`);
  return 0;
}

// ---------------------------------------------------------------------------
// configList
// ---------------------------------------------------------------------------

/**
 * List all config keys with their values and source annotations.
 *
 * Sources:
 *   - `(file)` — value comes from config.toml
 *   - `(default)` — value comes from defaults (not in config.toml)
 */
export function configList(deps: ConfigCommandDeps): number {
  const config = deps.loadConfig();

  // Parse the raw file to determine which keys are explicitly set
  let fileKeys: Record<string, Set<string>> = {};
  try {
    const raw = deps.readConfigFile();
    if (raw.trim().length > 0) {
      const parsed = parseTOML(raw) as Record<string, unknown>;
      fileKeys = extractFileKeys(parsed);
    }
  } catch {
    // If we can't parse the file, treat all as defaults
  }

  for (const section of Object.keys(KNOWN_SECTIONS)) {
    const sectionObj = config[section];
    if (!sectionObj || typeof sectionObj !== 'object') continue;

    for (const [field, value] of Object.entries(sectionObj as Record<string, unknown>)) {
      const isFromFile = fileKeys[section]?.has(field) ?? false;
      const source = isFromFile ? '(file)' : '(default)';
      const formatted = formatValue(value);
      deps.stdout(`${section}.${field} = ${formatted}  ${source}`);
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// configPath
// ---------------------------------------------------------------------------

/** Print the absolute path to config.toml. */
export function configPath(deps: ConfigCommandDeps): number {
  deps.stdout(deps.configFilePath());
  return 0;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function parseKey(key: string): { section: string; field: string } {
  const dot = key.indexOf('.');
  return {
    section: key.slice(0, dot),
    field: key.slice(dot + 1),
  };
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function extractFileKeys(parsed: Record<string, unknown>): Record<string, Set<string>> {
  const result: Record<string, Set<string>> = {};
  for (const [section, obj] of Object.entries(parsed)) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      result[section] = new Set(Object.keys(obj as Record<string, unknown>));
    }
  }
  return result;
}

/**
 * Validate a value being set against known constraints.
 * Returns an error message or null if valid.
 */
function validateSetValue(section: string, field: string, value: string): string | null {
  if (section === 'runtime' && field === 'engine') {
    if (!VALID_ENGINES.has(value)) {
      return `must be one of: ${[...VALID_ENGINES].join(', ')}`;
    }
  }

  if (section === 'logging' && field === 'level') {
    if (!VALID_LOG_LEVELS.has(value)) {
      return `must be one of: ${[...VALID_LOG_LEVELS].join(', ')}`;
    }
  }

  if (section === 'security' && field === 'max_sessions_per_group') {
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 1) {
      return 'must be a positive integer';
    }
  }

  if (section === 'hello' && field === 'enabled') {
    if (value !== 'true' && value !== 'false') {
      return 'must be true or false';
    }
  }

  return null;
}

/**
 * Coerce a string value to the appropriate type for TOML serialization.
 */
function coerceValue(section: string, field: string, value: string): unknown {
  // Boolean fields
  if (section === 'hello' && field === 'enabled') {
    return value === 'true';
  }

  // Numeric fields
  if (section === 'security' && field === 'max_sessions_per_group') {
    return parseInt(value, 10);
  }

  // Everything else is a string
  return value;
}
