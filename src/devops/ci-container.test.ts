import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '../../');
const CI_PATH = path.join(PROJECT_ROOT, '.github/workflows/ci.yml');
const SMOKE_SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts/container-smoke-test.sh');

const ci = fs.readFileSync(CI_PATH, 'utf-8');
const ciLines = ci.split('\n');

/** Check if any line matches the given pattern. */
function hasLine(lines: string[], pattern: RegExp): boolean {
  return lines.some((line) => pattern.test(line));
}

// ---------------------------------------------------------------------------
// CI workflow tests
// ---------------------------------------------------------------------------

describe('CI workflow — container build and scan', () => {
  it('CI workflow file exists', () => {
    expect(fs.existsSync(CI_PATH)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Container job definition
  // -------------------------------------------------------------------------

  describe('container job', () => {
    it('defines a container job', () => {
      expect(hasLine(ciLines, /^\s+container:/)).toBe(true);
    });

    it('container job depends on test job', () => {
      // Find the "container:" job block and look for needs: [test]
      const containerIdx = ciLines.findIndex((l) => /^\s{2}container:/.test(l));
      expect(containerIdx).toBeGreaterThan(-1);

      // Search within the container job block for needs
      const blockLines = ciLines.slice(containerIdx, containerIdx + 20);
      const needsLine = blockLines.find((l) => /needs:/.test(l));
      expect(needsLine).toBeDefined();
      expect(needsLine).toMatch(/test/);
    });

    it('runs on ubuntu-latest', () => {
      const containerIdx = ciLines.findIndex((l) => /^\s{2}container:/.test(l));
      const blockLines = ciLines.slice(containerIdx, containerIdx + 15);
      const runsOn = blockLines.find((l) => /runs-on:/.test(l));
      expect(runsOn).toBeDefined();
      expect(runsOn).toMatch(/ubuntu-latest/);
    });
  });

  // -------------------------------------------------------------------------
  // Docker image build
  // -------------------------------------------------------------------------

  describe('image build', () => {
    it('builds the Docker image', () => {
      expect(hasLine(ciLines, /docker\s+build/)).toBe(true);
    });

    it('tags the image for subsequent steps', () => {
      expect(hasLine(ciLines, /-t\s+\S*carapace/)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Trivy vulnerability scan
  // -------------------------------------------------------------------------

  describe('Trivy scan', () => {
    it('runs Trivy scanner', () => {
      expect(hasLine(ciLines, /trivy/i)).toBe(true);
    });

    it('uses the aquasecurity/trivy-action', () => {
      expect(hasLine(ciLines, /aquasecurity\/trivy-action/)).toBe(true);
    });

    it('scans the built image', () => {
      expect(hasLine(ciLines, /scan-type.*image|image-ref/i)).toBe(true);
    });

    it('blocks on high and critical severities', () => {
      expect(hasLine(ciLines, /severity.*HIGH.*CRITICAL|CRITICAL.*HIGH/i)).toBe(true);
    });

    it('has exit-code set to fail on findings', () => {
      expect(hasLine(ciLines, /exit-code.*1/)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Container smoke test
  // -------------------------------------------------------------------------

  describe('smoke test', () => {
    it('runs the smoke test script', () => {
      expect(hasLine(ciLines, /container-smoke-test/)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Smoke test script tests
// ---------------------------------------------------------------------------

describe('container-smoke-test.sh', () => {
  let script: string;
  let scriptLines: string[];

  it('exists', () => {
    expect(fs.existsSync(SMOKE_SCRIPT_PATH)).toBe(true);
  });

  it('is executable', () => {
    const stats = fs.statSync(SMOKE_SCRIPT_PATH);
    // Check owner execute bit (0o100)
    expect(stats.mode & 0o111).toBeGreaterThan(0);
  });

  describe('content', () => {
    beforeAll(() => {
      script = fs.readFileSync(SMOKE_SCRIPT_PATH, 'utf-8');
      scriptLines = script.split('\n');
    });

    it('has a shebang', () => {
      expect(scriptLines[0]).toMatch(/^#!\/bin\/(ba)?sh/);
    });

    it('uses set -e for fail-fast', () => {
      expect(hasLine(scriptLines, /set\s+-e/)).toBe(true);
    });

    it('starts a container with --read-only flag', () => {
      expect(hasLine(scriptLines, /--read-only/)).toBe(true);
    });

    it('starts a container with --network none', () => {
      expect(hasLine(scriptLines, /--network\s+none/)).toBe(true);
    });

    it('verifies filesystem is read-only', () => {
      expect(hasLine(scriptLines, /touch|mkdir|write/i)).toBe(true);
    });

    it('verifies network is unreachable', () => {
      expect(hasLine(scriptLines, /ping|wget|curl|nc\b/)).toBe(true);
    });

    it('verifies ipc binary is available', () => {
      expect(hasLine(scriptLines, /ipc/)).toBe(true);
    });

    it('cleans up the container', () => {
      expect(hasLine(scriptLines, /docker\s+rm/)).toBe(true);
    });
  });
});
