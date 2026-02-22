/**
 * InstallerHandler — plugin management tools for Carapace.
 *
 * A special built-in handler that manages third-party plugins:
 * install, list, remove, update, configure, and verify. Dependencies are
 * injected directly via constructor (not discovered from disk like
 * regular plugins).
 *
 * Tools:
 *   plugin_install   — clone a git repo, sanitize, validate manifest
 *   plugin_list      — scan pluginsDir for installed plugins
 *   plugin_remove    — delete a plugin directory (optionally creds)
 *   plugin_update    — fetch + checkout latest, re-sanitize, re-validate
 *   plugin_configure — write non-secret config values to config.json
 *   plugin_verify    — check credential files + optional smoke test
 */

import {
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';

import _Ajv, { type ErrorObject } from 'ajv';
// Ajv ESM interop: default export is the constructor
const Ajv = _Ajv.default ?? _Ajv;

import type {
  PluginHandler,
  CoreServices,
  PluginContext,
  ToolInvocationResult,
} from '../../core/plugin-handler.js';
import { ResponseSanitizer } from '../../core/response-sanitizer.js';
import { ErrorCode } from '../../types/errors.js';
import type { PluginManifest } from '../../types/manifest.js';
import { MANIFEST_JSON_SCHEMA } from '../../types/manifest-schema.js';
import type { GitOps } from './git-ops.js';
import { sanitizeClonedRepo, RealSanitizerFs } from './git-sanitizer.js';
import type { SanitizerFs, SanitizerGit } from './git-sanitizer.js';

// ---------------------------------------------------------------------------
// InstallerDeps
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into InstallerHandler by the factory.
 * None of these come from CoreServices — they are wired at construction.
 */
export interface InstallerDeps {
  pluginsDir: string;
  credentialsDir: string;
  carapaceHome: string;
  gitOps: GitOps;
  reservedNames: ReadonlySet<string>;
  /** Optional lookup for loaded plugin handlers — used by plugin_verify smoke test. */
  getLoadedHandler?: (name: string) => PluginHandler | undefined;
}

// ---------------------------------------------------------------------------
// Injectable filesystem for testing
// ---------------------------------------------------------------------------

/**
 * Filesystem operations used by InstallerHandler, injectable for testing.
 */
export interface InstallerFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: BufferEncoding): string;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  readdirSync(path: string): string[];
  writeFileSync(path: string, data: string, encoding: BufferEncoding): void;
  mkdirSync(path: string, options: { recursive: boolean }): void;
  lstatSync(path: string): Stats;
}

/**
 * Injectable sanitizer function for testing.
 */
export type SanitizeFunction = (
  repoDir: string,
  fsOps: SanitizerFs,
  git: SanitizerGit,
) => Promise<import('./git-sanitizer.js').SanitizationResult>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid plugin name pattern: lowercase, starts with letter. */
const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Timeout for plugin verify() smoke test in milliseconds. */
const VERIFY_TIMEOUT_MS = 10_000;

/** Allowed file permissions for credential files (owner-only). */
const ALLOWED_PERMISSIONS = new Set([0o600, 0o400]);

// ---------------------------------------------------------------------------
// InstallerHandler
// ---------------------------------------------------------------------------

export class InstallerHandler implements PluginHandler {
  private services: CoreServices | null = null;
  private readonly pluginsDir: string;
  private readonly credentialsDir: string;
  private readonly carapaceHome: string;
  private readonly gitOps: GitOps;
  private readonly reservedNames: ReadonlySet<string>;
  private readonly getLoadedHandler?: (name: string) => PluginHandler | undefined;
  private readonly fs: InstallerFs;
  private readonly sanitize: SanitizeFunction;
  private readonly sanitizerFs: SanitizerFs;
  private readonly sanitizer: ResponseSanitizer;

  constructor(
    deps: InstallerDeps,
    fsOverride?: InstallerFs,
    sanitizeOverride?: SanitizeFunction,
    sanitizerFsOverride?: SanitizerFs,
  ) {
    this.pluginsDir = deps.pluginsDir;
    this.credentialsDir = deps.credentialsDir;
    this.carapaceHome = deps.carapaceHome;
    this.gitOps = deps.gitOps;
    this.reservedNames = deps.reservedNames;
    this.getLoadedHandler = deps.getLoadedHandler;
    this.fs = fsOverride ?? {
      existsSync,
      readFileSync,
      rmSync,
      readdirSync,
      writeFileSync,
      mkdirSync,
      lstatSync,
    };
    this.sanitize = sanitizeOverride ?? sanitizeClonedRepo;
    this.sanitizerFs = sanitizerFsOverride ?? new RealSanitizerFs();
    this.sanitizer = new ResponseSanitizer();
  }

  async initialize(services: CoreServices): Promise<void> {
    this.services = services;
  }

  async handleToolInvocation(
    tool: string,
    args: Record<string, unknown>,
    _context: PluginContext,
  ): Promise<ToolInvocationResult> {
    switch (tool) {
      case 'plugin_install':
        return this.handlePluginInstall(args);
      case 'plugin_list':
        return this.handlePluginList(args);
      case 'plugin_remove':
        return this.handlePluginRemove(args);
      case 'plugin_update':
        return this.handlePluginUpdate(args);
      case 'plugin_configure':
        return this.handlePluginConfigure(args);
      case 'plugin_verify':
        return this.handlePluginVerify(args);
      default:
        return {
          ok: false,
          error: {
            code: ErrorCode.HANDLER_ERROR,
            message: `Unknown tool: "${tool}"`,
            retriable: false,
          },
        };
    }
  }

  async shutdown(): Promise<void> {
    this.services = null;
  }

  // -------------------------------------------------------------------------
  // plugin_install
  // -------------------------------------------------------------------------

  private async handlePluginInstall(args: Record<string, unknown>): Promise<ToolInvocationResult> {
    const url = args['url'] as string;
    if (!url || typeof url !== 'string') {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Missing required argument: url',
          retriable: false,
          field: 'url',
        },
      };
    }

    // Derive plugin name from URL or use override
    const name = this.deriveName(url, args['name'] as string | undefined);
    if (!name) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Could not derive plugin name from URL: ${url}`,
          retriable: false,
          field: 'url',
        },
      };
    }

    // Validate name pattern
    if (!NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Invalid plugin name "${name}". Must match pattern: ${NAME_PATTERN.source} (lowercase, starts with letter)`,
          retriable: false,
          field: 'name',
        },
      };
    }

    // Check reserved names
    if (this.reservedNames.has(name)) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Plugin name "${name}" is reserved and cannot be used`,
          retriable: false,
          field: 'name',
        },
      };
    }

    // Check collision
    const destDir = join(this.pluginsDir, name);
    if (this.fs.existsSync(destDir)) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Plugin "${name}" already exists at ${destDir}`,
          retriable: false,
          field: 'name',
        },
      };
    }

    // Clone
    try {
      await this.gitOps.clone(url, destDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Clone failed: ${message}`,
          retriable: true,
        },
      };
    }

    // Sanitize — on rejection, clean up and return error
    try {
      const sanitizeResult = await this.sanitize(destDir, this.sanitizerFs, this.gitOps);
      if (sanitizeResult.rejected) {
        this.fs.rmSync(destDir, { recursive: true, force: true });
        return {
          ok: false,
          error: {
            code: ErrorCode.HANDLER_ERROR,
            message: `Repository rejected: ${sanitizeResult.rejectionReasons.join('; ')}`,
            retriable: false,
          },
        };
      }
    } catch (err: unknown) {
      this.fs.rmSync(destDir, { recursive: true, force: true });
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Sanitization failed: ${message}`,
          retriable: false,
        },
      };
    }

    // Validate manifest
    let manifest: PluginManifest;
    try {
      manifest = this.readAndValidateManifest(destDir);
    } catch (err: unknown) {
      this.fs.rmSync(destDir, { recursive: true, force: true });
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Invalid manifest: ${message}`,
          retriable: false,
        },
      };
    }

    // Build credentials_needed
    const credentialsNeeded = (manifest.install?.credentials ?? []).map((cred) => ({
      key: cred.key,
      description: cred.description,
      required: cred.required,
      file: join(this.credentialsDir, name, cred.key),
      obtain_url: cred.obtain_url,
      format_hint: cred.format_hint,
    }));

    return {
      ok: true as const,
      result: {
        plugin_name: name,
        version: manifest.version,
        description: manifest.description,
        tools: manifest.provides.tools.map((t) => t.name),
        credentials_needed: credentialsNeeded,
      },
    };
  }

  // -------------------------------------------------------------------------
  // plugin_list
  // -------------------------------------------------------------------------

  private async handlePluginList(args: Record<string, unknown>): Promise<ToolInvocationResult> {
    const includeBuiltin = args['include_builtin'] === true;

    const plugins: Array<Record<string, unknown>> = [];

    // Scan pluginsDir for directories containing manifest.json
    let entries: string[];
    try {
      entries = this.fs.readdirSync(this.pluginsDir);
    } catch {
      // pluginsDir doesn't exist or isn't readable — return empty list
      entries = [];
    }

    for (const entry of entries) {
      const pluginDir = join(this.pluginsDir, entry);
      const manifestPath = join(pluginDir, 'manifest.json');

      if (!this.fs.existsSync(manifestPath)) {
        continue;
      }

      let manifest: PluginManifest;
      try {
        manifest = this.readAndValidateManifest(pluginDir);
      } catch {
        // Skip plugins with invalid manifests — just note them
        plugins.push({
          name: entry,
          error: 'Invalid manifest',
        });
        continue;
      }

      const hasGit = this.fs.existsSync(join(pluginDir, '.git'));

      plugins.push({
        name: entry,
        version: manifest.version,
        description: manifest.description,
        tools: manifest.provides.tools.map((t) => t.name),
        installed_via_git: hasGit,
      });
    }

    // Optionally include built-in plugin names
    if (includeBuiltin) {
      for (const name of this.reservedNames) {
        plugins.push({
          name,
          builtin: true,
        });
      }
    }

    return {
      ok: true as const,
      result: { plugins },
    };
  }

  // -------------------------------------------------------------------------
  // plugin_remove
  // -------------------------------------------------------------------------

  private async handlePluginRemove(args: Record<string, unknown>): Promise<ToolInvocationResult> {
    const name = args['name'] as string;
    if (!name || typeof name !== 'string') {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Missing required argument: name',
          retriable: false,
          field: 'name',
        },
      };
    }

    // Reject built-in plugins
    if (this.reservedNames.has(name)) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Cannot remove built-in plugin "${name}"`,
          retriable: false,
          field: 'name',
        },
      };
    }

    // Verify plugin exists
    const pluginDir = join(this.pluginsDir, name);
    if (!this.fs.existsSync(pluginDir)) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Plugin "${name}" not found at ${pluginDir}`,
          retriable: false,
          field: 'name',
        },
      };
    }

    // Remove plugin directory
    this.fs.rmSync(pluginDir, { recursive: true, force: true });

    // Optionally remove credentials
    const removeCredentials = args['remove_credentials'] === true;
    let credentialsRetained = true;

    if (removeCredentials) {
      const credDir = join(this.credentialsDir, name);
      if (this.fs.existsSync(credDir)) {
        this.fs.rmSync(credDir, { recursive: true, force: true });
      }
      credentialsRetained = false;
    }

    return {
      ok: true as const,
      result: {
        removed: name,
        credentials_retained: credentialsRetained,
        requires_restart: true,
      },
    };
  }

  // -------------------------------------------------------------------------
  // plugin_update
  // -------------------------------------------------------------------------

  private async handlePluginUpdate(args: Record<string, unknown>): Promise<ToolInvocationResult> {
    const name = args['name'] as string;
    if (!name || typeof name !== 'string') {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Missing required argument: name',
          retriable: false,
          field: 'name',
        },
      };
    }

    const pluginDir = join(this.pluginsDir, name);

    // Verify plugin exists
    if (!this.fs.existsSync(pluginDir)) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Plugin "${name}" not found at ${pluginDir}`,
          retriable: false,
          field: 'name',
        },
      };
    }

    // Verify .git directory exists (installed via git)
    const gitDir = join(pluginDir, '.git');
    if (!this.fs.existsSync(gitDir)) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Plugin "${name}" was not installed via git (no .git directory)`,
          retriable: false,
          field: 'name',
        },
      };
    }

    // Read old manifest before update
    let oldManifest: PluginManifest;
    try {
      oldManifest = this.readAndValidateManifest(pluginDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Could not read current manifest: ${message}`,
          retriable: false,
        },
      };
    }

    const oldVersion = oldManifest.version;
    const oldCredentialKeys = new Set((oldManifest.install?.credentials ?? []).map((c) => c.key));

    // Fetch latest from remote
    try {
      await this.gitOps.fetch(pluginDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Fetch failed: ${message}`,
          retriable: true,
        },
      };
    }

    // Checkout default branch latest
    let defaultBranch: string;
    try {
      defaultBranch = await this.gitOps.getDefaultBranch(pluginDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Could not determine default branch: ${message}`,
          retriable: false,
        },
      };
    }

    try {
      await this.gitOps.checkout(pluginDir, `origin/${defaultBranch}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Checkout failed: ${message}`,
          retriable: true,
        },
      };
    }

    // Re-sanitize after fetch
    try {
      const sanitizeResult = await this.sanitize(pluginDir, this.sanitizerFs, this.gitOps);
      if (sanitizeResult.rejected) {
        return {
          ok: false,
          error: {
            code: ErrorCode.HANDLER_ERROR,
            message: `Updated repository rejected: ${sanitizeResult.rejectionReasons.join('; ')}`,
            retriable: false,
          },
        };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Sanitization failed after update: ${message}`,
          retriable: false,
        },
      };
    }

    // Re-validate manifest
    let newManifest: PluginManifest;
    try {
      newManifest = this.readAndValidateManifest(pluginDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Invalid manifest after update: ${message}`,
          retriable: false,
        },
      };
    }

    // Compare credential requirements
    const newCredentials = newManifest.install?.credentials ?? [];
    const newCredentialKeys = newCredentials.filter((c) => !oldCredentialKeys.has(c.key));

    const result: Record<string, unknown> = {
      plugin_name: name,
      old_version: oldVersion,
      new_version: newManifest.version,
      requires_restart: true,
    };

    if (newCredentialKeys.length > 0) {
      result['new_credentials_needed'] = newCredentialKeys.map((cred) => ({
        key: cred.key,
        description: cred.description,
        required: cred.required,
        file: join(this.credentialsDir, name, cred.key),
        obtain_url: cred.obtain_url,
        format_hint: cred.format_hint,
      }));
    }

    return {
      ok: true as const,
      result,
    };
  }

  // -------------------------------------------------------------------------
  // plugin_configure
  // -------------------------------------------------------------------------

  private async handlePluginConfigure(
    args: Record<string, unknown>,
  ): Promise<ToolInvocationResult> {
    const name = args['name'] as string;
    if (!name || typeof name !== 'string') {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Missing required argument: name',
          retriable: false,
          field: 'name',
        },
      };
    }

    const key = args['key'] as string;
    if (!key || typeof key !== 'string') {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Missing required argument: key',
          retriable: false,
          field: 'key',
        },
      };
    }

    const value = args['value'];
    if (value === undefined) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Missing required argument: value',
          retriable: false,
          field: 'value',
        },
      };
    }

    const pluginDir = join(this.pluginsDir, name);

    // Verify plugin exists
    if (!this.fs.existsSync(pluginDir)) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Plugin "${name}" not found at ${pluginDir}`,
          retriable: false,
          field: 'name',
        },
      };
    }

    // Read manifest to get config_schema
    let manifest: PluginManifest;
    try {
      manifest = this.readAndValidateManifest(pluginDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Could not read manifest: ${message}`,
          retriable: false,
        },
      };
    }

    if (!manifest.config_schema) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Plugin "${name}" does not declare a config_schema`,
          retriable: false,
        },
      };
    }

    const schemaProperties = manifest.config_schema.properties;
    if (!schemaProperties[key]) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Unknown config key "${key}". Valid keys: ${Object.keys(schemaProperties).join(', ')}`,
          retriable: false,
          field: 'key',
        },
      };
    }

    // Validate value type against schema
    const propSchema = schemaProperties[key]!;
    const typeValid = this.validateConfigValue(value, propSchema.type);
    if (!typeValid) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Value for key "${key}" must be of type "${propSchema.type}", got ${typeof value}`,
          retriable: false,
          field: 'value',
        },
      };
    }

    // Read existing config.json or create empty
    const configPath = join(pluginDir, 'config.json');
    let config: Record<string, unknown> = {};
    if (this.fs.existsSync(configPath)) {
      try {
        const raw = this.fs.readFileSync(configPath, 'utf-8');
        config = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // If config.json is corrupted, start fresh
        config = {};
      }
    }

    // Set the value
    config[key] = value;

    // Write back
    this.fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    return {
      ok: true as const,
      result: {
        plugin_name: name,
        key,
        value,
      },
    };
  }

  // -------------------------------------------------------------------------
  // plugin_verify
  // -------------------------------------------------------------------------

  private async handlePluginVerify(args: Record<string, unknown>): Promise<ToolInvocationResult> {
    const name = args['name'] as string;
    if (!name || typeof name !== 'string') {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Missing required argument: name',
          retriable: false,
          field: 'name',
        },
      };
    }

    // Verify plugin exists
    const pluginDir = join(this.pluginsDir, name);
    if (!this.fs.existsSync(pluginDir)) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Plugin "${name}" not found at ${pluginDir}`,
          retriable: false,
          field: 'name',
        },
      };
    }

    // Read manifest
    let manifest: PluginManifest;
    try {
      manifest = this.readAndValidateManifest(pluginDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Could not read manifest: ${message}`,
          retriable: false,
        },
      };
    }

    // Phase 1: Credential checks
    const credentialSpecs = manifest.install?.credentials ?? [];
    const credentialStatus: Array<Record<string, unknown>> = [];
    let allCredentialsOk = true;

    for (const cred of credentialSpecs) {
      const credPath = join(this.credentialsDir, name, cred.key);
      const status: Record<string, unknown> = {
        key: cred.key,
        required: cred.required,
        path: credPath,
      };

      // Check if file exists
      let stats: Stats;
      try {
        stats = this.fs.lstatSync(credPath);
      } catch {
        status['ok'] = false;
        status['error'] = 'File not found';
        if (cred.required) allCredentialsOk = false;
        credentialStatus.push(status);
        continue;
      }

      // Check for symlink
      if (stats.isSymbolicLink()) {
        status['ok'] = false;
        status['error'] = 'File is a symlink (not allowed)';
        if (cred.required) allCredentialsOk = false;
        credentialStatus.push(status);
        continue;
      }

      // Check permissions (mode & 0o777 to get permission bits)
      const perms = stats.mode & 0o777;
      if (!ALLOWED_PERMISSIONS.has(perms)) {
        status['ok'] = false;
        status['error'] = `Incorrect permissions: 0${perms.toString(8)} (expected 0600 or 0400)`;
        if (cred.required) allCredentialsOk = false;
        credentialStatus.push(status);
        continue;
      }

      // Check non-empty
      if (stats.size === 0) {
        status['ok'] = false;
        status['error'] = 'File is empty';
        if (cred.required) allCredentialsOk = false;
        credentialStatus.push(status);
        continue;
      }

      status['ok'] = true;
      credentialStatus.push(status);
    }

    // Phase 2: Smoke test (if handler loaded and implements verify())
    let smokeTest: Record<string, unknown> | undefined;

    if (this.getLoadedHandler) {
      const loadedHandler = this.getLoadedHandler(name);
      if (loadedHandler?.verify) {
        try {
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error('Verify timed out after 10 seconds')),
              VERIFY_TIMEOUT_MS,
            );
          });
          const verifyResult = await Promise.race([loadedHandler.verify(), timeoutPromise]);

          // Sanitize detail to strip any credential values
          const sanitizedDetail = verifyResult.detail
            ? (this.sanitizer.sanitize(verifyResult.detail).value as Record<string, unknown>)
            : undefined;

          smokeTest = {
            ok: verifyResult.ok,
            message: verifyResult.message,
            ...(sanitizedDetail !== undefined && { detail: sanitizedDetail }),
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          smokeTest = {
            ok: false,
            message: `Smoke test failed: ${message}`,
          };
        }
      }
    }

    // Compute overall readiness
    const smokeTestPassed = smokeTest === undefined || smokeTest['ok'] === true;
    const ready = allCredentialsOk && smokeTestPassed;

    const result: Record<string, unknown> = {
      ready,
      plugin_name: name,
      credential_status: credentialStatus,
    };

    if (smokeTest !== undefined) {
      result['smoke_test'] = smokeTest;
    }

    return {
      ok: true as const,
      result,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Validate a config value against a JSON schema type string.
   */
  private validateConfigValue(value: unknown, expectedType: string): boolean {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
      case 'integer':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      default:
        return true;
    }
  }

  /**
   * Derive a plugin name from a git URL. Strips trailing `.git` suffix
   * and uses the last path segment. User can override with an explicit name.
   */
  private deriveName(url: string, override?: string): string | null {
    if (override) {
      return override;
    }

    // Handle both https:// and git@ URLs
    // https://github.com/user/repo.git → repo
    // git@github.com:user/repo.git → repo
    let pathPart: string;

    if (url.startsWith('git@')) {
      // git@github.com:user/repo.git
      const colonIdx = url.indexOf(':');
      if (colonIdx === -1) return null;
      pathPart = url.substring(colonIdx + 1);
    } else {
      // https://github.com/user/repo.git
      try {
        const parsed = new URL(url);
        pathPart = parsed.pathname;
      } catch {
        return null;
      }
    }

    // Get last segment, strip .git suffix
    const segments = pathPart.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return null;

    let name = segments[segments.length - 1]!;
    if (name.endsWith('.git')) {
      name = name.slice(0, -4);
    }

    return name.length > 0 ? name : null;
  }

  /**
   * Read and validate manifest.json from a cloned plugin directory.
   * Throws on any error (missing file, invalid JSON, schema violation).
   */
  private readAndValidateManifest(pluginDir: string): PluginManifest {
    const manifestPath = join(pluginDir, 'manifest.json');
    let raw: string;
    try {
      raw = this.fs.readFileSync(manifestPath, 'utf-8');
    } catch {
      throw new Error('Could not read manifest.json');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('manifest.json is not valid JSON');
    }

    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(MANIFEST_JSON_SCHEMA);
    if (!validate(parsed)) {
      const errors =
        validate.errors?.map((e: ErrorObject) => `${e.instancePath} ${e.message}`).join('; ') ?? '';
      throw new Error(`Schema validation failed: ${errors}`);
    }

    return parsed as PluginManifest;
  }
}
