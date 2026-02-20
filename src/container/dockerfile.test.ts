import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Read the Dockerfile
// ---------------------------------------------------------------------------

const DOCKERFILE_PATH = path.resolve(__dirname, '../../Dockerfile');
const dockerfile = fs.readFileSync(DOCKERFILE_PATH, 'utf-8');
const lines = dockerfile.split('\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if any line matches the given pattern. */
function hasLine(pattern: RegExp): boolean {
  return lines.some((line) => pattern.test(line));
}

/** Find all lines matching a pattern. */
function findLines(pattern: RegExp): string[] {
  return lines.filter((line) => pattern.test(line));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dockerfile', () => {
  it('exists and is readable', () => {
    expect(fs.existsSync(DOCKERFILE_PATH)).toBe(true);
    expect(dockerfile.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Multi-stage build
  // -----------------------------------------------------------------------

  describe('multi-stage build', () => {
    it('has a builder stage', () => {
      expect(hasLine(/^FROM\s+node:.*\s+AS\s+builder/)).toBe(true);
    });

    it('has a runtime stage', () => {
      expect(hasLine(/^FROM\s+node:.*\s+AS\s+runtime/)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Claude Code CLI installation
  // -----------------------------------------------------------------------

  describe('Claude Code CLI', () => {
    it('installs via native installer', () => {
      expect(hasLine(/claude\.ai\/install\.sh/)).toBe(true);
    });

    it('accepts a version build arg', () => {
      expect(hasLine(/ARG\s+CLAUDE_CODE_VERSION/)).toBe(true);
    });

    it('passes version to installer', () => {
      expect(hasLine(/install\.sh.*CLAUDE_CODE_VERSION/)).toBe(true);
    });

    it('disables auto-updater', () => {
      expect(hasLine(/DISABLE_AUTOUPDATER.*1/)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Entrypoint
  // -----------------------------------------------------------------------

  describe('entrypoint', () => {
    it('copies entrypoint.sh into the image', () => {
      expect(hasLine(/COPY.*entrypoint\.sh/)).toBe(true);
    });

    it('sets entrypoint.sh as the ENTRYPOINT', () => {
      const entrypointLines = findLines(/^ENTRYPOINT/);
      expect(entrypointLines.length).toBeGreaterThan(0);
      const last = entrypointLines[entrypointLines.length - 1];
      expect(last).toContain('entrypoint.sh');
    });
  });

  // -----------------------------------------------------------------------
  // IPC binary
  // -----------------------------------------------------------------------

  describe('ipc binary', () => {
    it('creates an ipc symlink or wrapper in PATH', () => {
      // The ipc binary is the compiled dist/ipc/main.js, exposed as "ipc" in PATH
      expect(
        hasLine(/ipc/) && (hasLine(/ln\s+-s/) || hasLine(/printf.*ipc/) || hasLine(/echo.*ipc/)),
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Security: user and directories
  // -----------------------------------------------------------------------

  describe('security', () => {
    it('runs as non-root user', () => {
      expect(hasLine(/^USER\s+/)).toBe(true);
    });

    it('creates writable directories for read-only root', () => {
      // /workspace, /home/node/.claude/, /tmp must be writable
      expect(hasLine(/mkdir.*\/workspace/)).toBe(true);
      expect(hasLine(/mkdir.*\.claude/)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // OCI labels
  // -----------------------------------------------------------------------

  describe('OCI labels', () => {
    it('accepts CARAPACE_VERSION build arg', () => {
      expect(hasLine(/ARG\s+CARAPACE_VERSION/)).toBe(true);
    });

    it('accepts GIT_SHA build arg', () => {
      expect(hasLine(/ARG\s+GIT_SHA/)).toBe(true);
    });

    it('accepts BUILD_DATE build arg', () => {
      expect(hasLine(/ARG\s+BUILD_DATE/)).toBe(true);
    });

    it('sets image revision label', () => {
      expect(hasLine(/org\.opencontainers\.image\.revision/)).toBe(true);
    });

    it('sets image version label', () => {
      expect(hasLine(/org\.opencontainers\.image\.version/)).toBe(true);
    });

    it('sets Claude Code version label', () => {
      expect(hasLine(/ai\.carapace\.claude-code-version/)).toBe(true);
    });

    it('sets image created label', () => {
      expect(hasLine(/org\.opencontainers\.image\.created/)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // ZeroMQ dependency
  // -----------------------------------------------------------------------

  describe('dependencies', () => {
    it('installs libzmq', () => {
      expect(hasLine(/libzmq/)).toBe(true);
    });
  });
});
