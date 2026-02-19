import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Read flake.nix
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '../../');
const FLAKE_PATH = path.join(PROJECT_ROOT, 'flake.nix');
const flake = fs.readFileSync(FLAKE_PATH, 'utf-8');
const lines = flake.split('\n');

/** Check if any line matches the given pattern. */
function hasLine(pattern: RegExp): boolean {
  return lines.some((line) => pattern.test(line));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('flake.nix — Nix build output', () => {
  it('flake.nix exists', () => {
    expect(fs.existsSync(FLAKE_PATH)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // packages.default output
  // -------------------------------------------------------------------------

  describe('packages.default', () => {
    it('defines a packages.default output', () => {
      expect(hasLine(/packages\.default/)).toBe(true);
    });

    it('sets pname to carapace', () => {
      expect(hasLine(/pname\s*=\s*"carapace"/)).toBe(true);
    });

    it('uses stdenv.mkDerivation', () => {
      expect(hasLine(/mkDerivation/)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Dependencies
  // -------------------------------------------------------------------------

  describe('build dependencies', () => {
    it('includes nodejs_22', () => {
      expect(hasLine(/nodejs_22/)).toBe(true);
    });

    it('includes pnpm_10', () => {
      expect(hasLine(/pnpm_10/)).toBe(true);
    });

    it('includes pnpmConfigHook', () => {
      expect(hasLine(/pnpmConfigHook/)).toBe(true);
    });

    it('includes makeWrapper for binary wrapper', () => {
      expect(hasLine(/makeWrapper/)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // pnpm dependency fetching
  // -------------------------------------------------------------------------

  describe('pnpm dependency fetching', () => {
    it('uses fetchPnpmDeps for reproducible deps', () => {
      expect(hasLine(/fetchPnpmDeps/)).toBe(true);
    });

    it('specifies a dependency hash', () => {
      expect(hasLine(/hash\s*=/)).toBe(true);
    });

    it('sets fetcherVersion for reproducibility', () => {
      expect(hasLine(/fetcherVersion\s*=\s*\d/)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Build phase
  // -------------------------------------------------------------------------

  describe('build phase', () => {
    it('runs pnpm build', () => {
      expect(hasLine(/pnpm\s+(run\s+)?build/)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Install phase
  // -------------------------------------------------------------------------

  describe('install phase', () => {
    it('copies dist directory to output', () => {
      expect(hasLine(/dist/)).toBe(true);
    });

    it('copies package.json to output', () => {
      expect(hasLine(/package\.json/)).toBe(true);
    });

    it('copies node_modules to output', () => {
      expect(hasLine(/node_modules/)).toBe(true);
    });

    it('creates a binary wrapper', () => {
      expect(hasLine(/makeWrapper.*node.*carapace/)).toBe(true);
    });

    it('wrapper points to dist/index.js', () => {
      expect(hasLine(/dist\/index\.js/)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // devShells.default still exists
  // -------------------------------------------------------------------------

  describe('devShells.default', () => {
    it('still defines the dev shell', () => {
      expect(hasLine(/devShells\.default/)).toBe(true);
    });
  });
});
