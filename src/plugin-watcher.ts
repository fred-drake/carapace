/**
 * Plugin hot reload / watch mode for Carapace.
 *
 * Monitors `plugins/` for file changes and automatically reloads
 * affected plugins: re-validates manifest, re-compiles handler,
 * re-registers tools in the router. Clear terminal output shows
 * what was reloaded and success/failure.
 *
 * Enabled via `carapace start --watch`.
 */

import type { ValidationResult } from './validate-manifest.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Events emitted during the watch/reload cycle. */
export type WatcherEventType =
  | 'change_detected'
  | 'validating'
  | 'reload_success'
  | 'reload_failed';

/** A structured watcher event for output. */
export interface WatcherEvent {
  type: WatcherEventType;
  timestamp: string;
  pluginName: string;
  detail?: string;
}

/** Result of reloading a single plugin. */
export interface ReloadResult {
  success: boolean;
  pluginName: string;
  errors: string[];
}

/** Handle returned by watchDir, used to stop watching. */
export interface WatchHandle {
  close: () => void;
}

/** Result of compiling a handler. */
export interface CompileResult {
  success: boolean;
  error?: string;
}

/** Injectable dependencies for the PluginWatcher. */
export interface PluginWatcherDeps {
  /** Watch a directory for file changes. Calls callback with relative file path. */
  watchDir: (dir: string, onChange: (filePath: string) => void) => WatchHandle;
  /** Validate a plugin's manifest. Takes plugin name (directory name). */
  validatePlugin: (pluginName: string) => ValidationResult;
  /** Compile a plugin's handler. Takes plugin name (directory name). */
  compileHandler: (pluginName: string) => Promise<CompileResult>;
  /** Register a plugin's tools in the router. */
  registerTools: (pluginName: string) => void;
  /** Unregister a plugin's tools from the router. */
  unregisterTools: (pluginName: string) => void;
  /** List plugin directory names in the plugins folder. */
  listPluginDirs: () => string[];
  /** Output function for watcher events. */
  output: (line: string) => void;
  /** Clock function returning ISO timestamps. */
  now: () => string;
}

/** Configuration options for the watcher. */
export interface WatcherOptions {
  /** Debounce interval in milliseconds. Defaults to 300. */
  debounceMs?: number;
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
} as const;

// ---------------------------------------------------------------------------
// Ignored path segments
// ---------------------------------------------------------------------------

const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.DS_Store']);

// ---------------------------------------------------------------------------
// PluginWatcher
// ---------------------------------------------------------------------------

export class PluginWatcher {
  private readonly pluginsDir: string;
  private readonly deps: PluginWatcherDeps;
  private readonly debounceMs: number;
  private handle: WatchHandle | null = null;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(pluginsDir: string, deps: PluginWatcherDeps, options?: WatcherOptions) {
    this.pluginsDir = pluginsDir;
    this.deps = deps;
    this.debounceMs = options?.debounceMs ?? 300;
  }

  /** Start watching the plugins directory. */
  start(): void {
    if (this.handle) return;

    this.handle = this.deps.watchDir(this.pluginsDir, (filePath: string) => {
      this.onFileChange(filePath);
    });
  }

  /** Stop watching. */
  stop(): void {
    if (!this.handle) return;

    this.handle.close();
    this.handle = null;

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /** Whether the watcher is currently active. */
  isWatching(): boolean {
    return this.handle !== null;
  }

  /**
   * Reload a specific plugin. Can be called directly (not just via watch).
   *
   * Steps: validate → compile → unregister old tools → register new tools.
   */
  async reloadPlugin(pluginName: string): Promise<ReloadResult> {
    this.emitEvent({ type: 'validating', pluginName });

    // 1. Validate manifest
    const validation = this.deps.validatePlugin(pluginName);
    if (!validation.valid) {
      const errors = validation.errors.map((e) => e.message);
      this.emitEvent({
        type: 'reload_failed',
        pluginName,
        detail: errors.join('; '),
      });
      return { success: false, pluginName, errors };
    }

    // 2. Compile handler
    const compile = await this.deps.compileHandler(pluginName);
    if (!compile.success) {
      const errors = [compile.error ?? 'Unknown compile error'];
      this.emitEvent({
        type: 'reload_failed',
        pluginName,
        detail: errors[0],
      });
      return { success: false, pluginName, errors };
    }

    // 3. Re-register tools (unregister first, then register)
    try {
      this.deps.unregisterTools(pluginName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitEvent({
        type: 'reload_failed',
        pluginName,
        detail: `Failed to unregister tools: ${msg}`,
      });
      return { success: false, pluginName, errors: [msg] };
    }

    try {
      this.deps.registerTools(pluginName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitEvent({
        type: 'reload_failed',
        pluginName,
        detail: `Failed to register tools: ${msg}`,
      });
      return { success: false, pluginName, errors: [msg] };
    }

    this.emitEvent({ type: 'reload_success', pluginName });
    return { success: true, pluginName, errors: [] };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private onFileChange(filePath: string): void {
    // Extract plugin name (first path segment)
    const pluginName = filePath.split('/')[0];
    if (!pluginName) return;

    // Check for ignored path segments
    const segments = filePath.split('/');
    if (segments.some((seg) => IGNORED_SEGMENTS.has(seg) || seg.startsWith('.'))) {
      return;
    }

    this.emitEvent({
      type: 'change_detected',
      pluginName,
      detail: filePath,
    });

    // Debounce: clear any pending timer for this plugin, then set a new one
    const existing = this.debounceTimers.get(pluginName);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(pluginName);
      // Fire and forget — errors are reported via output, never thrown
      this.reloadPlugin(pluginName).catch(() => {
        // Should not happen since reloadPlugin catches internally
      });
    }, this.debounceMs);

    this.debounceTimers.set(pluginName, timer);
  }

  private emitEvent(event: Omit<WatcherEvent, 'timestamp'>): void {
    const timestamp = this.deps.now();
    const time = extractTime(timestamp);
    const { type, pluginName, detail } = event as WatcherEvent;

    let color: string;
    let label: string;
    switch (type) {
      case 'change_detected':
        color = ANSI.cyan;
        label = 'change_detected';
        break;
      case 'validating':
        color = ANSI.dim;
        label = 'validating';
        break;
      case 'reload_success':
        color = ANSI.green;
        label = 'reload_success';
        break;
      case 'reload_failed':
        color = ANSI.red;
        label = 'reload_failed';
        break;
    }

    let line = `[${time}] ${color}${label}${ANSI.reset}  ${ANSI.yellow}${pluginName}${ANSI.reset}`;
    if (detail) {
      line += `  ${ANSI.dim}${detail}${ANSI.reset}`;
    }

    this.deps.output(line);
  }
}

/** Extract HH:MM:SS.mmm from an ISO timestamp. */
function extractTime(iso: string): string {
  const match = iso.match(/(\d{2}:\d{2}:\d{2}\.\d{3})/);
  return match ? match[1] : iso;
}
