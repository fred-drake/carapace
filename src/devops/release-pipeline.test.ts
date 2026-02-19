/**
 * Tests for the release pipeline workflow (DEVOPS-15).
 *
 * Validates that:
 *   1. The release workflow file exists and is valid YAML
 *   2. Triggers on tag push (v*)
 *   3. Build matrix covers required platforms (macOS arm64/x86_64, Linux x86_64/arm64)
 *   4. Produces SHA-256 checksums
 *   5. Multi-arch container image pushed to GHCR
 *   6. Cosign keyless signing configured
 *   7. SBOM generation configured
 *   8. All actions pinned to commit SHA (not tag)
 *   9. Release notes include image digest
 *  10. Artifacts uploaded to GitHub Releases
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/release.yml');

function loadWorkflow(): Record<string, unknown> {
  const content = readFileSync(WORKFLOW_PATH, 'utf-8');
  return parseYaml(content) as Record<string, unknown>;
}

function getJobs(workflow: Record<string, unknown>): Record<string, unknown> {
  return workflow.jobs as Record<string, unknown>;
}

function getWorkflowContent(): string {
  return readFileSync(WORKFLOW_PATH, 'utf-8');
}

// ---------------------------------------------------------------------------
// Workflow file structure
// ---------------------------------------------------------------------------

describe('release workflow file', () => {
  it('exists at .github/workflows/release.yml', () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
  });

  it('is valid YAML', () => {
    const content = readFileSync(WORKFLOW_PATH, 'utf-8');
    expect(() => parseYaml(content)).not.toThrow();
  });

  it('has a descriptive name', () => {
    const workflow = loadWorkflow();
    expect(workflow.name).toBeDefined();
    expect(String(workflow.name).toLowerCase()).toContain('release');
  });
});

// ---------------------------------------------------------------------------
// Trigger configuration
// ---------------------------------------------------------------------------

describe('release trigger', () => {
  it('triggers on tag push matching v*', () => {
    const workflow = loadWorkflow();
    const on = workflow.on as Record<string, unknown>;
    expect(on.push).toBeDefined();
    const push = on.push as Record<string, unknown>;
    const tags = push.tags as string[];
    expect(tags).toBeDefined();
    expect(tags.some((t) => t.includes('v'))).toBe(true);
  });

  it('does not trigger on branch push', () => {
    const workflow = loadWorkflow();
    const on = workflow.on as Record<string, unknown>;
    const push = on.push as Record<string, unknown>;
    expect(push.branches).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Build matrix
// ---------------------------------------------------------------------------

describe('build matrix', () => {
  it('has a build job', () => {
    const jobs = getJobs(loadWorkflow());
    expect(jobs.build).toBeDefined();
  });

  it('covers macOS arm64', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/macos.*arm64|arm64.*macos/i);
  });

  it('covers macOS x86_64', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/macos.*x86_64|x64.*macos|macos-13/i);
  });

  it('covers Linux x86_64', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/linux.*x86_64|ubuntu.*x64|linux.*amd64/i);
  });

  it('covers Linux arm64', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/linux.*arm64/i);
  });
});

// ---------------------------------------------------------------------------
// SHA-256 checksums
// ---------------------------------------------------------------------------

describe('checksums', () => {
  it('generates SHA-256 checksums', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/sha256|shasum|SHA256SUMS/i);
  });
});

// ---------------------------------------------------------------------------
// Container image
// ---------------------------------------------------------------------------

describe('container image', () => {
  it('pushes to GHCR', () => {
    const content = getWorkflowContent();
    expect(content).toContain('ghcr.io');
  });

  it('builds multi-arch image (linux/amd64, linux/arm64)', () => {
    const content = getWorkflowContent();
    expect(content).toContain('linux/amd64');
    expect(content).toContain('linux/arm64');
  });

  it('tags image with version', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/carapace-agent/);
  });
});

// ---------------------------------------------------------------------------
// Cosign signing
// ---------------------------------------------------------------------------

describe('cosign signing', () => {
  it('uses cosign for image signing', () => {
    const content = getWorkflowContent();
    expect(content).toContain('cosign');
  });

  it('uses keyless signing (Sigstore OIDC)', () => {
    const content = getWorkflowContent();
    // Keyless cosign uses OIDC identity, not a key file
    expect(content).toMatch(/cosign sign|COSIGN_EXPERIMENTAL|id-token/i);
  });
});

// ---------------------------------------------------------------------------
// SBOM generation
// ---------------------------------------------------------------------------

describe('SBOM', () => {
  it('generates SBOM', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/sbom|cyclonedx|syft/i);
  });
});

// ---------------------------------------------------------------------------
// Action SHA pinning
// ---------------------------------------------------------------------------

describe('action SHA pinning', () => {
  it('all uses: directives reference a commit SHA', () => {
    const content = getWorkflowContent();
    // Find all `uses:` lines and check they use SHA pinning
    const usesLines = content
      .split('\n')
      .filter((line) => line.trim().startsWith('- uses:') || line.trim().startsWith('uses:'))
      .map((line) => line.trim());

    expect(usesLines.length).toBeGreaterThan(0);

    for (const line of usesLines) {
      // Extract the action reference after 'uses:'
      const match = line.match(/uses:\s*(.+)/);
      if (!match) continue;
      const ref = match[1].trim();

      // Should contain @ followed by a 40-char hex SHA
      expect(ref).toMatch(/@[0-9a-f]{40}/);
    }
  });
});

// ---------------------------------------------------------------------------
// Release artifacts
// ---------------------------------------------------------------------------

describe('release artifacts', () => {
  it('uploads artifacts to GitHub Releases', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/gh release|softprops\/action-gh-release|upload-artifact/i);
  });

  it('includes image digest in release notes', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/digest|IMAGE_DIGEST/i);
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('workflow permissions', () => {
  it('declares permissions block', () => {
    const content = getWorkflowContent();
    expect(content).toContain('permissions:');
  });

  it('requests id-token write for OIDC signing', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/id-token:\s*write/);
  });

  it('requests packages write for GHCR push', () => {
    const content = getWorkflowContent();
    expect(content).toMatch(/packages:\s*write/);
  });
});
