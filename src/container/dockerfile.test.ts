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
    it('installs the @anthropic-ai/claude-code package', () => {
      expect(hasLine(/npm install.*@anthropic-ai\/claude-code/)).toBe(true);
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
  // ZeroMQ dependency
  // -----------------------------------------------------------------------

  describe('dependencies', () => {
    it('installs libzmq', () => {
      expect(hasLine(/libzmq/)).toBe(true);
    });
  });
});
