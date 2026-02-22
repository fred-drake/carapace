/**
 * InstallerHandler — plugin_install and plugin_verify tools for Carapace.
 *
 * A special built-in handler that installs and verifies third-party plugins
 * from git repositories. Dependencies are injected directly via constructor
 * (not discovered from disk like regular plugins).
 *
 * plugin_install flow: validate name → check reserved/collision → clone →
 * sanitize → validate manifest → return success with credential instructions.
 * On any post-clone failure, the cloned directory is removed synchronously.
 *
 * plugin_verify flow: read manifest → check credential file metadata
 * (never contents) → optional smoke test via handler.verify() → return
 * readiness status.
 */

import { readFileSync, existsSync, rmSync, lstatSync, type Stats } from 'node:fs';
import { join } from 'node:path';

import _Ajv, { type ErrorObject } from 'ajv';
// Ajv ESM interop: default export is the constructor
const Ajv = _Ajv.default ?? _Ajv;

import type {
  PluginHandler,
  PluginVerifyResult,
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
  /** Callback to look up an already-loaded plugin handler by name. */
  getLoadedHandler?: (name: string) => PluginHandler | undefined;
}

// ---------------------------------------------------------------------------
// Injectable filesystem for testing
// ---------------------------------------------------------------------------

/**
 * Minimal stat result exposing only the fields plugin_verify needs.
 * Avoids coupling to the full fs.Stats type.
 */
export interface FileStat {
  isSymbolicLink(): boolean;
  mode: number;
  size: number;
}

/**
 * Filesystem operations used by InstallerHandler, injectable for testing.
 */
export interface InstallerFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: BufferEncoding): string;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  lstatSync(path: string): FileStat;
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
// Credential status reported by plugin_verify
// ---------------------------------------------------------------------------

/** Per-credential check result returned by plugin_verify. */
export interface CredentialStatus {
  key: string;
  found: boolean;
  valid_permissions: boolean;
  not_empty: boolean;
  not_symlink: boolean;
}

/** Smoke test result embedded in the plugin_verify response. */
export interface SmokeTestResult {
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for the optional verify() smoke test (10 seconds). */
const VERIFY_TIMEOUT_MS = 10_000;

/** Valid plugin name pattern: lowercase, starts with letter. */
const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

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
  private readonly getLoadedHandler: (name: string) => PluginHandler | undefined;
  private readonly fs: InstallerFs;
  private readonly sanitize: SanitizeFunction;
  private readonly sanitizerFs: SanitizerFs;
  private readonly responseSanitizer: ResponseSanitizer;

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
    this.getLoadedHandler = deps.getLoadedHandler ?? (() => undefined);
    this.fs = fsOverride ?? {
      existsSync,
      readFileSync,
      rmSync,
      lstatSync: (path: string): FileStat => {
        const stats: Stats = lstatSync(path);
        return {
          isSymbolicLink: () => stats.isSymbolicLink(),
          mode: stats.mode,
          size: stats.size,
        };
      },
    };
    this.sanitize = sanitizeOverride ?? sanitizeClonedRepo;
    this.sanitizerFs = sanitizerFsOverride ?? new RealSanitizerFs();
    this.responseSanitizer = new ResponseSanitizer();
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

    // Check plugin directory exists
    const pluginDir = join(this.pluginsDir, name);
    if (!this.fs.existsSync(pluginDir)) {
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Plugin "${name}" not found at ${pluginDir}`,
          retriable: false,
        },
      };
    }

    // Read manifest to get credential specs
    let manifest: PluginManifest;
    try {
      manifest = this.readAndValidateManifest(pluginDir);
    } catch (err: unknown) {
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

    // Phase 1: credential checks (never read file contents)
    const credentialSpecs = manifest.install?.credentials ?? [];
    const credentialStatus: CredentialStatus[] = credentialSpecs.map((spec) => {
      const credPath = join(this.credentialsDir, name, spec.key);
      return this.checkCredentialFile(credPath, spec.key);
    });

    // Phase 2: smoke test (if handler loaded and has verify())
    let smokeTest: SmokeTestResult | undefined;
    const loadedHandler = this.getLoadedHandler(name);
    if (loadedHandler && typeof loadedHandler.verify === 'function') {
      smokeTest = await this.runSmokeTest(loadedHandler);
    }

    // Compute readiness (Array#every returns true for empty arrays)
    const allCredsOk = credentialStatus.every(
      (c) => c.found && c.valid_permissions && c.not_empty && c.not_symlink,
    );
    const smokeTestOk = smokeTest === undefined || smokeTest.ok;
    const ready = allCredsOk && smokeTestOk;

    const result: Record<string, unknown> = {
      ready,
      plugin_name: name,
      credential_status: credentialStatus,
    };
    if (smokeTest !== undefined) {
      result['smoke_test'] = smokeTest;
    }

    return { ok: true as const, result };
  }

  /**
   * Check a single credential file's metadata without reading its contents.
   * Returns a status object describing what was found.
   */
  private checkCredentialFile(credPath: string, key: string): CredentialStatus {
    if (!this.fs.existsSync(credPath)) {
      return { key, found: false, valid_permissions: false, not_empty: false, not_symlink: false };
    }

    let stat: FileStat;
    try {
      stat = this.fs.lstatSync(credPath);
    } catch {
      return { key, found: false, valid_permissions: false, not_empty: false, not_symlink: false };
    }

    const notSymlink = !stat.isSymbolicLink();
    // 0o600 (read/write owner) or 0o400 (read-only owner) — check lower 9 bits
    const permBits = stat.mode & 0o777;
    const validPermissions = permBits === 0o600 || permBits === 0o400;
    const notEmpty = stat.size > 0;

    return {
      key,
      found: true,
      valid_permissions: validPermissions,
      not_empty: notEmpty,
      not_symlink: notSymlink,
    };
  }

  /**
   * Run the optional verify() smoke test on a loaded handler with a timeout.
   * Sanitizes the result detail to strip any leaked credentials.
   */
  private async runSmokeTest(handler: PluginHandler): Promise<SmokeTestResult> {
    try {
      const result = await Promise.race<PluginVerifyResult | 'timeout'>([
        handler.verify!(),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), VERIFY_TIMEOUT_MS),
        ),
      ]);

      if (result === 'timeout') {
        return { ok: false, message: 'Smoke test timed out after 10 seconds' };
      }

      // Sanitize the detail field to strip any accidentally leaked credentials
      let message = result.message;
      if (result.detail) {
        const sanitized = this.responseSanitizer.sanitize(result.detail);
        // If detail contained credentials, append a note but don't expose them
        if (sanitized.redactedPaths.length > 0) {
          message = `${message} (detail sanitized: ${sanitized.redactedPaths.length} field(s) redacted)`;
        }
      }

      return { ok: result.ok, message };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Smoke test failed: ${message}` };
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

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
