/**
 * TOML-based configuration loader for Carapace.
 *
 * Reads `config.toml` from `$CARAPACE_HOME`, parses it with smol-toml,
 * validates against the ARCH-05 schema, and returns a fully typed
 * `CarapaceConfig`. Also provides version file read/write and a
 * convenience `initialize()` that sets up everything at startup.
 *
 * See docs/INSTALL_STRATEGY.md §2 and §8.
 */

import { parse as parseTOML } from 'smol-toml';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig, ensureDirectoryStructure, DEFAULT_CONFIG } from '../types/config.js';
import type { CarapaceConfig, DirectoryStructure } from '../types/config.js';

// ---------------------------------------------------------------------------
// loadConfig()
// ---------------------------------------------------------------------------

/**
 * Load and validate `config.toml` from a Carapace home directory.
 *
 * If `config.toml` does not exist or is empty, returns `DEFAULT_CONFIG`.
 * Throws on invalid TOML syntax or schema validation errors.
 */
export function loadConfig(home: string): CarapaceConfig {
  const configPath = join(home, 'config.toml');

  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  const content = readFileSync(configPath, 'utf-8');
  if (content.trim().length === 0) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = parseTOML(content);
  return parseConfig(raw as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Version file
// ---------------------------------------------------------------------------

/**
 * Read the installed version from `$CARAPACE_HOME/version`.
 *
 * Returns `null` if the file does not exist. Returns the trimmed
 * content otherwise (may be empty string for an empty file).
 */
export function readVersion(home: string): string | null {
  const versionPath = join(home, 'version');

  if (!existsSync(versionPath)) {
    return null;
  }

  return readFileSync(versionPath, 'utf-8').trim();
}

/**
 * Write the installed version to `$CARAPACE_HOME/version`.
 *
 * Appends a trailing newline for POSIX convention.
 */
export function writeVersion(version: string, home: string): void {
  const versionPath = join(home, 'version');
  writeFileSync(versionPath, version + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// initialize()
// ---------------------------------------------------------------------------

/** Result of `initialize()` — everything needed at startup. */
export interface InitResult {
  config: CarapaceConfig;
  dirs: DirectoryStructure;
  version: string | null;
}

/**
 * Initialize a Carapace home directory.
 *
 * 1. Ensures the directory structure exists (idempotent).
 * 2. Loads `config.toml` (or applies defaults).
 * 3. Reads the version file (or returns null).
 *
 * Safe to call on every startup.
 */
export function initialize(home: string): InitResult {
  const dirs = ensureDirectoryStructure(home);
  const config = loadConfig(home);
  const version = readVersion(home);

  return { config, dirs, version };
}
