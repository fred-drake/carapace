/**
 * Tests for the install script (DEVOPS-16).
 *
 * Validates:
 *  1. Script exists and starts with #!/bin/sh
 *  2. POSIX-only — no bashisms
 *  3. Security hardening: umask 077, trap cleanup, no eval, no sudo
 *  4. Platform detection for macOS and Linux
 *  5. Architecture detection for arm64 and x86_64
 *  6. SHA-256 checksum verification (fail-closed)
 *  7. Transactional install with rollback
 *  8. Container image pull + cosign verify
 *  9. PATH modification for bash/zsh/fish
 * 10. Flags: --dry-run, --yes, --no-modify-path, --runtime, --version
 * 11. Piped execution detection
 * 12. Existing install detection
 * 13. Proxy variable passthrough
 * 14. Interactive UX elements
 * 15. Node.js prerequisite check
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/install.sh');

function getScript(): string {
  return readFileSync(SCRIPT_PATH, 'utf-8');
}

// ---------------------------------------------------------------------------
// File structure
// ---------------------------------------------------------------------------

describe('install script file', () => {
  it('exists at scripts/install.sh', () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  it('starts with POSIX shebang', () => {
    const content = getScript();
    expect(content.startsWith('#!/bin/sh')).toBe(true);
  });

  it('has SCRIPT_VERSION variable near the top', () => {
    const content = getScript();
    const lines = content.split('\n').slice(0, 30);
    expect(lines.some((l) => l.match(/^SCRIPT_VERSION=/))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security hardening
// ---------------------------------------------------------------------------

describe('security hardening', () => {
  it('sets umask 077 before any other operation', () => {
    const content = getScript();
    // umask should appear before any mkdir, curl, or other operations
    const umaskIndex = content.indexOf('umask 077');
    expect(umaskIndex).toBeGreaterThan(-1);
    // Should be very early in the script (within first 40 lines)
    const linesBeforeUmask = content.substring(0, umaskIndex).split('\n').length;
    expect(linesBeforeUmask).toBeLessThan(40);
  });

  it('uses trap for cleanup on EXIT, INT, and TERM', () => {
    const content = getScript();
    expect(content).toMatch(/trap\b.*\bEXIT\b/);
    expect(content).toMatch(/trap\b.*\bINT\b/);
    expect(content).toMatch(/trap\b.*\bTERM\b/);
  });

  it('uses mktemp -d for temporary directory', () => {
    const content = getScript();
    expect(content).toContain('mktemp -d');
  });

  it('never uses eval', () => {
    const content = getScript();
    const lines = content.split('\n').filter((l) => !l.trim().startsWith('#'));
    const evalLines = lines.filter((l) => l.match(/\beval\b/));
    expect(evalLines).toHaveLength(0);
  });

  it('never calls sudo', () => {
    const content = getScript();
    const lines = content.split('\n').filter((l) => !l.trim().startsWith('#'));
    const sudoLines = lines.filter((l) => l.match(/\bsudo\b/));
    expect(sudoLines).toHaveLength(0);
  });

  it('uses set -eu for strict error handling', () => {
    const content = getScript();
    expect(content).toMatch(/set -e/);
  });

  it('does not have a --skip-verify flag', () => {
    const content = getScript();
    expect(content).not.toContain('skip-verify');
  });

  it('uses install -d -m 0700 for credential directory', () => {
    const content = getScript();
    expect(content).toMatch(/install\s+-d\s+-m\s+0700/);
  });
});

// ---------------------------------------------------------------------------
// No bashisms (POSIX compliance)
// ---------------------------------------------------------------------------

describe('POSIX compliance', () => {
  it('does not use [[ (bash-only test)', () => {
    const content = getScript();
    const lines = content.split('\n').filter((l) => !l.trim().startsWith('#'));
    const bashTests = lines.filter((l) => l.includes('[['));
    expect(bashTests).toHaveLength(0);
  });

  it('does not use bash-only arrays', () => {
    const content = getScript();
    const lines = content.split('\n').filter((l) => !l.trim().startsWith('#'));
    // POSIX shell doesn't have declare -a or array+=()
    const arrayLines = lines.filter((l) => l.match(/declare\s+-[aA]|\+=\s*\(/));
    expect(arrayLines).toHaveLength(0);
  });

  it('does not use function keyword', () => {
    const content = getScript();
    const lines = content.split('\n').filter((l) => !l.trim().startsWith('#'));
    // POSIX uses name() { not function name {
    const funcLines = lines.filter((l) => l.match(/^\s*function\s+\w+/));
    expect(funcLines).toHaveLength(0);
  });

  it('does not use bash process substitution', () => {
    const content = getScript();
    const lines = content.split('\n').filter((l) => !l.trim().startsWith('#'));
    const procSub = lines.filter((l) => l.match(/<\(|>\(/));
    expect(procSub).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

describe('platform detection', () => {
  it('detects macOS via uname', () => {
    const content = getScript();
    expect(content).toMatch(/uname/);
    expect(content).toMatch(/Darwin/);
  });

  it('detects Linux', () => {
    const content = getScript();
    expect(content).toMatch(/Linux/);
  });

  it('detects arm64 architecture', () => {
    const content = getScript();
    expect(content).toMatch(/arm64|aarch64/);
  });

  it('detects x86_64 architecture', () => {
    const content = getScript();
    expect(content).toMatch(/x86_64|amd64/);
  });
});

// ---------------------------------------------------------------------------
// Download and checksum verification
// ---------------------------------------------------------------------------

describe('download and verification', () => {
  it('downloads from GitHub Releases', () => {
    const content = getScript();
    expect(content).toMatch(/github\.com.*releases|GITHUB_RELEASE_URL/i);
  });

  it('uses HTTPS for downloads', () => {
    const content = getScript();
    // All download URLs should be HTTPS
    const curlLines = content.split('\n').filter((l) => l.includes('curl') && l.includes('http'));
    for (const line of curlLines) {
      if (line.trim().startsWith('#')) continue;
      // Should not have plain http:// (only https://)
      expect(line).not.toMatch(/http:\/\/[^$]/);
    }
  });

  it('performs SHA-256 checksum verification', () => {
    const content = getScript();
    expect(content).toMatch(/sha256|shasum/i);
  });

  it('aborts on checksum mismatch (fail-closed)', () => {
    const content = getScript();
    // After checksum verification, script should abort/exit on failure
    expect(content).toMatch(/checksum.*fail|verify.*fail|mismatch|abort/i);
  });
});

// ---------------------------------------------------------------------------
// Transactional install
// ---------------------------------------------------------------------------

describe('transactional install', () => {
  it('uses staging directory for extraction', () => {
    const content = getScript();
    expect(content).toMatch(/\.installing|staging/i);
  });

  it('uses atomic move to final location', () => {
    const content = getScript();
    // mv is the atomic operation for directory replacement
    expect(content).toContain('mv ');
  });

  it('implements rollback on failure', () => {
    const content = getScript();
    expect(content).toMatch(/rollback|cleanup|rm.*installing/i);
  });
});

// ---------------------------------------------------------------------------
// Container image
// ---------------------------------------------------------------------------

describe('container image', () => {
  it('pulls from GHCR', () => {
    const content = getScript();
    expect(content).toContain('ghcr.io');
  });

  it('verifies cosign signature', () => {
    const content = getScript();
    expect(content).toContain('cosign');
  });

  it('supports docker runtime', () => {
    const content = getScript();
    expect(content).toContain('docker');
  });

  it('supports podman runtime', () => {
    const content = getScript();
    expect(content).toContain('podman');
  });
});

// ---------------------------------------------------------------------------
// PATH modification
// ---------------------------------------------------------------------------

describe('PATH modification', () => {
  it('modifies bash config', () => {
    const content = getScript();
    expect(content).toMatch(/\.bashrc|\.bash_profile/);
  });

  it('modifies zsh config', () => {
    const content = getScript();
    expect(content).toContain('.zshrc');
  });

  it('modifies fish config', () => {
    const content = getScript();
    expect(content).toMatch(/fish_add_path|config\.fish/);
  });

  it('uses .bash_profile on macOS and .bashrc on Linux', () => {
    const content = getScript();
    expect(content).toContain('.bash_profile');
    expect(content).toContain('.bashrc');
  });

  it('supports --no-modify-path flag', () => {
    const content = getScript();
    expect(content).toContain('no-modify-path');
  });
});

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

describe('CLI flags', () => {
  it('supports --dry-run', () => {
    const content = getScript();
    expect(content).toContain('dry-run');
  });

  it('supports --yes for non-interactive mode', () => {
    const content = getScript();
    expect(content).toContain('--yes');
  });

  it('supports --runtime flag', () => {
    const content = getScript();
    expect(content).toContain('--runtime');
  });

  it('supports --version flag', () => {
    const content = getScript();
    expect(content).toContain('--version');
  });

  it('parses flags from command line arguments', () => {
    const content = getScript();
    // Should have a flag parsing loop or case statement
    expect(content).toMatch(/case\b.*\bin\b|getopts|while.*shift/);
  });
});

// ---------------------------------------------------------------------------
// Piped execution detection
// ---------------------------------------------------------------------------

describe('piped execution', () => {
  it('detects non-interactive mode via terminal check', () => {
    const content = getScript();
    expect(content).toMatch(/-t\s+0/);
  });

  it('shows notice when running in piped mode', () => {
    const content = getScript();
    expect(content).toMatch(/non-interactive|piped/i);
  });
});

// ---------------------------------------------------------------------------
// Existing install detection
// ---------------------------------------------------------------------------

describe('existing install detection', () => {
  it('checks for existing installation', () => {
    const content = getScript();
    expect(content).toMatch(/existing|already.*install|upgrade/i);
  });

  it('reads installed version', () => {
    const content = getScript();
    expect(content).toContain('version');
  });
});

// ---------------------------------------------------------------------------
// Proxy support
// ---------------------------------------------------------------------------

describe('proxy support', () => {
  it('respects HTTPS_PROXY', () => {
    const content = getScript();
    expect(content).toContain('HTTPS_PROXY');
  });

  it('respects HTTP_PROXY', () => {
    const content = getScript();
    expect(content).toContain('HTTP_PROXY');
  });
});

// ---------------------------------------------------------------------------
// Node.js prerequisite
// ---------------------------------------------------------------------------

describe('Node.js prerequisite', () => {
  it('checks for Node.js', () => {
    const content = getScript();
    expect(content).toMatch(/node\b.*--version|command -v node|which node/);
  });

  it('shows platform-specific install commands when missing', () => {
    const content = getScript();
    expect(content).toMatch(/brew|apt|dnf|nvm|fnm/);
  });
});

// ---------------------------------------------------------------------------
// Interactive UX
// ---------------------------------------------------------------------------

describe('interactive UX', () => {
  it('has a boxed header', () => {
    const content = getScript();
    // Unicode box-drawing or ASCII box characters
    expect(content).toMatch(/╭|┌|\+--/);
  });

  it('shows progress indicators', () => {
    const content = getScript();
    expect(content).toMatch(/✓|✗|OK|FAIL|\[x\]|>>>/i);
  });

  it('shows next steps after install', () => {
    const content = getScript();
    expect(content).toMatch(/carapace doctor|next step/i);
  });
});

// ---------------------------------------------------------------------------
// Default install location
// ---------------------------------------------------------------------------

describe('install location', () => {
  it('defaults to ~/.carapace/', () => {
    const content = getScript();
    expect(content).toContain('.carapace');
  });

  it('supports CARAPACE_HOME override', () => {
    const content = getScript();
    expect(content).toContain('CARAPACE_HOME');
  });
});
