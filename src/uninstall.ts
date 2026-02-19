/**
 * Carapace uninstall command.
 *
 * Removes $CARAPACE_HOME after showing what will be deleted (with sizes).
 * Optionally cleans PATH modifications from shell config files.
 *
 * Features:
 *   - Running session detection (warns before proceeding)
 *   - Confirmation prompt (skipped with --yes)
 *   - Dry-run mode (--dry-run shows what would happen)
 *   - Shell config PATH cleanup (bash/zsh/fish)
 */

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/** Injectable dependencies for the uninstall command. */
export interface UninstallDeps {
  /** Write to stdout. */
  stdout: (msg: string) => void;
  /** Write to stderr. */
  stderr: (msg: string) => void;
  /** Resolved CARAPACE_HOME path. */
  home: string;
  /** User's home directory (for shell config scanning). */
  userHome: string;
  /** Read the PID from the PID file, or null if absent. */
  readPidFile: () => number | null;
  /** Check whether a process with the given PID exists. */
  processExists: (pid: number) => boolean;
  /** Ask user for confirmation. Returns true if confirmed. */
  confirm: (prompt: string) => Promise<boolean>;
  /** Check if a directory exists. */
  dirExists: (path: string) => boolean;
  /** Get total size of a directory in bytes. */
  dirSize: (path: string) => number;
  /** Remove a directory recursively. */
  removeDir: (path: string) => void;
  /** Read file contents as string. */
  readFile: (path: string) => string;
  /** Write string contents to a file. */
  writeFile: (path: string, content: string) => void;
  /** Return candidate shell config file paths. */
  shellConfigPaths: () => string[];
  /** List entries in a directory (basenames only). */
  listDir: (path: string) => string[];
}

/** Options controlling uninstall behaviour. */
export interface UninstallOptions {
  /** Skip confirmation prompt. */
  yes: boolean;
  /** Show what would be deleted without acting. */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Shell config match
// ---------------------------------------------------------------------------

/** A line in a shell config that references Carapace. */
export interface ShellConfigMatch {
  /** Absolute path to the shell config file. */
  path: string;
  /** 1-based line number of the match. */
  lineNumber: number;
  /** The matched line content. */
  line: string;
}

// ---------------------------------------------------------------------------
// formatSize
// ---------------------------------------------------------------------------

/** Format a byte count as a human-readable string. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// scanShellConfigs
// ---------------------------------------------------------------------------

/**
 * Scan shell config files for lines that reference Carapace PATH entries.
 *
 * Detects:
 *   - Literal paths containing `{home}/bin`
 *   - `$CARAPACE_HOME` variable references
 */
export function scanShellConfigs(
  configPaths: string[],
  home: string,
  readFile: (path: string) => string,
): ShellConfigMatch[] {
  const matches: ShellConfigMatch[] = [];

  for (const configPath of configPaths) {
    let content: string;
    try {
      content = readFile(configPath);
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (lineReferencesCarapace(line, home)) {
        matches.push({ path: configPath, lineNumber: i + 1, line });
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// runUninstall
// ---------------------------------------------------------------------------

/**
 * Run the uninstall command.
 *
 * @returns Exit code (0 = success, 1 = aborted/error).
 */
export async function runUninstall(
  deps: UninstallDeps,
  options: UninstallOptions,
): Promise<number> {
  const { home } = deps;
  const homeExists = deps.dirExists(home);

  // 1. Check for running sessions
  const pid = deps.readPidFile();
  if (pid !== null && deps.processExists(pid)) {
    deps.stderr(`Warning: Carapace is currently running (PID ${pid})`);
    if (!options.yes) {
      const proceed = await deps.confirm(
        'Carapace is running. Uninstalling may cause data loss. Continue?',
      );
      if (!proceed) {
        deps.stderr('Uninstall cancelled.');
        return 1;
      }
    }
  }

  // 2. Handle missing home
  if (!homeExists) {
    deps.stdout(`${home} does not exist. Nothing to remove.`);
    scanAndReportPathCleanup(deps, options);
    return 0;
  }

  // 3. Show what will be deleted
  showDeletionSummary(deps);

  // 4. Scan shell configs
  const shellMatches = scanShellConfigs(deps.shellConfigPaths(), home, deps.readFile);

  if (shellMatches.length > 0) {
    deps.stdout('\nShell config PATH entries to clean:');
    for (const match of shellMatches) {
      deps.stdout(`  ${match.path}:${match.lineNumber}: ${match.line.trim()}`);
    }
  }

  // 5. Dry-run: show summary and exit
  if (options.dryRun) {
    deps.stdout('\n[dry-run] No changes made.');
    return 0;
  }

  // 6. Confirm
  if (!options.yes) {
    const confirmed = await deps.confirm(`Remove ${home} and clean shell configs?`);
    if (!confirmed) {
      deps.stderr('Uninstall cancelled.');
      return 1;
    }
  }

  // 7. Clean shell configs
  cleanShellConfigs(deps, shellMatches);

  // 8. Remove CARAPACE_HOME
  deps.removeDir(home);
  deps.stdout(`\nRemoved ${home}`);
  deps.stdout('Carapace has been uninstalled.');

  return 0;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function showDeletionSummary(deps: UninstallDeps): void {
  const { home } = deps;
  const totalSize = deps.dirSize(home);

  deps.stdout(`\nThe following will be removed (${formatSize(totalSize)} total):`);
  deps.stdout(`  ${home}/`);

  try {
    const entries = deps.listDir(home);
    for (const entry of entries) {
      const entryPath = `${home}/${entry}`;
      let size = 0;
      try {
        size = deps.dirSize(entryPath);
      } catch {
        // Entry might be a file, not a directory
      }
      deps.stdout(`    ${entry}/  ${formatSize(size)}`);
    }
  } catch {
    // If we can't list, just show the total
  }
}

function scanAndReportPathCleanup(deps: UninstallDeps, options: UninstallOptions): void {
  const shellMatches = scanShellConfigs(deps.shellConfigPaths(), deps.home, deps.readFile);
  if (shellMatches.length === 0) return;

  deps.stdout('\nShell config PATH entries to clean:');
  for (const match of shellMatches) {
    deps.stdout(`  ${match.path}:${match.lineNumber}: ${match.line.trim()}`);
  }

  if (!options.dryRun && (options.yes || true)) {
    cleanShellConfigs(deps, shellMatches);
  }
}

function cleanShellConfigs(deps: UninstallDeps, matches: ShellConfigMatch[]): void {
  // Group matches by file
  const byFile = new Map<string, Set<number>>();
  for (const match of matches) {
    if (!byFile.has(match.path)) {
      byFile.set(match.path, new Set());
    }
    byFile.get(match.path)!.add(match.lineNumber);
  }

  for (const [filePath, lineNumbers] of byFile) {
    let content: string;
    try {
      content = deps.readFile(filePath);
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const filtered = lines.filter((_, i) => !lineNumbers.has(i + 1));
    deps.writeFile(filePath, filtered.join('\n'));
    deps.stdout(`  Cleaned ${filePath}`);
  }
}

function lineReferencesCarapace(line: string, home: string): boolean {
  // Check for literal home path (e.g. /home/user/.carapace/bin)
  if (line.includes(`${home}/bin`) || line.includes(`${home}/`)) {
    // Only match PATH-related lines, not arbitrary comments
    if (
      line.includes('PATH') ||
      line.includes('path') ||
      line.includes('set -x') ||
      line.includes('set -gx')
    ) {
      return true;
    }
  }

  // Check for $CARAPACE_HOME variable reference in PATH context
  if (line.includes('CARAPACE_HOME') && (line.includes('PATH') || line.includes('path'))) {
    return true;
  }

  return false;
}
