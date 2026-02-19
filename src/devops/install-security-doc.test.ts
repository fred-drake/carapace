/**
 * Tests for the install-path threat model document (SEC-21).
 *
 * Validates that docs/INSTALL_SECURITY.md exists and covers all required
 * threat model sections with appropriate depth.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '../..');
const DOC_PATH = resolve(ROOT, 'docs/INSTALL_SECURITY.md');

function getDoc(): string {
  return readFileSync(DOC_PATH, 'utf-8');
}

// ---------------------------------------------------------------------------
// Document structure
// ---------------------------------------------------------------------------

describe('install security document', () => {
  it('exists at docs/INSTALL_SECURITY.md', () => {
    expect(existsSync(DOC_PATH)).toBe(true);
  });

  it('has a title and version metadata', () => {
    const content = getDoc();
    expect(content).toMatch(/# Install-Path Threat Model/i);
    expect(content).toMatch(/Last Updated|Version/i);
  });
});

// ---------------------------------------------------------------------------
// Section 1: Attack surface analysis
// ---------------------------------------------------------------------------

describe('attack surface analysis', () => {
  it('covers both Nix and script install paths', () => {
    const content = getDoc();
    expect(content).toMatch(/Nix.*Flake|Path A.*Nix/i);
    expect(content).toMatch(/Install Script|Path B.*Script/i);
  });

  it('identifies attack surfaces for Nix path', () => {
    const content = getDoc();
    expect(content).toMatch(/flake.*input|flake\.lock/i);
    expect(content).toContain('buildNpmPackage');
  });

  it('identifies attack surfaces for script path', () => {
    const content = getDoc();
    expect(content).toMatch(/tarball.*download|script.*download/i);
    expect(content).toMatch(/SHA-256|checksum/i);
  });

  it('discusses residual risks', () => {
    const content = getDoc();
    expect(content).toMatch(/[Rr]esidual.*risk/);
  });
});

// ---------------------------------------------------------------------------
// Section 2: Supply chain trust assumptions
// ---------------------------------------------------------------------------

describe('supply chain trust assumptions', () => {
  it('covers npm registry', () => {
    const content = getDoc();
    expect(content).toMatch(/npm.*[Rr]egistry|npmjs/);
  });

  it('covers GitHub Releases', () => {
    const content = getDoc();
    expect(content).toMatch(/GitHub.*[Rr]elease/);
  });

  it('covers GHCR', () => {
    const content = getDoc();
    expect(content).toMatch(/GHCR|GitHub Container Registry/);
  });

  it('covers Sigstore/cosign', () => {
    const content = getDoc();
    expect(content).toMatch(/Sigstore|[Cc]osign/);
  });

  it('discusses accepted trade-offs', () => {
    const content = getDoc();
    expect(content).toMatch(/[Aa]ccepted.*trade-off/);
  });
});

// ---------------------------------------------------------------------------
// Section 3: MITM scenarios
// ---------------------------------------------------------------------------

describe('MITM scenarios', () => {
  it('covers network-level MITM', () => {
    const content = getDoc();
    expect(content).toMatch(/DNS.*poison|MITM|BGP|ARP/i);
  });

  it('covers TLS as mitigation', () => {
    const content = getDoc();
    expect(content).toMatch(/TLS|HTTPS|certificate/i);
  });

  it('covers application-level MITM', () => {
    const content = getDoc();
    expect(content).toMatch(/CDN|runner.*compromise|Actions.*runner/i);
  });
});

// ---------------------------------------------------------------------------
// Section 4: Credential storage threat model
// ---------------------------------------------------------------------------

describe('credential storage threat model', () => {
  it('documents directory permissions', () => {
    const content = getDoc();
    expect(content).toMatch(/0700/);
    expect(content).toMatch(/0600/);
  });

  it('covers credential isolation from container', () => {
    const content = getDoc();
    expect(content).toMatch(/never.*enter.*container|not.*mounted/i);
  });

  it('covers stdin credential injection', () => {
    const content = getDoc();
    expect(content).toMatch(/stdin|credential.*inject/i);
  });

  it('covers symlink attack prevention', () => {
    const content = getDoc();
    expect(content).toMatch(/symlink/i);
  });

  it('covers docker inspect credential leakage', () => {
    const content = getDoc();
    expect(content).toMatch(/docker inspect/i);
  });
});

// ---------------------------------------------------------------------------
// Section 5: Container runtime security comparison
// ---------------------------------------------------------------------------

describe('container runtime security comparison', () => {
  it('covers Docker on macOS', () => {
    const content = getDoc();
    expect(content).toMatch(/Docker.*macOS|macOS.*Docker/i);
  });

  it('covers Docker on Linux', () => {
    const content = getDoc();
    expect(content).toMatch(/Docker.*Linux|Linux.*Docker/i);
  });

  it('covers Podman', () => {
    const content = getDoc();
    expect(content).toMatch(/Podman.*Linux|rootless/i);
  });

  it('covers Apple Containers', () => {
    const content = getDoc();
    expect(content).toMatch(/Apple.*Container/i);
  });

  it('includes isolation level comparison', () => {
    const content = getDoc();
    expect(content).toMatch(/[Ii]solation.*level|[Ii]solation.*rank/i);
  });

  it('compares VM vs namespace isolation', () => {
    const content = getDoc();
    expect(content).toMatch(/VM.*namespace|namespace.*VM/i);
  });

  it('covers vsock for Apple Containers', () => {
    const content = getDoc();
    expect(content).toMatch(/vsock/i);
  });

  it('covers SELinux for Podman', () => {
    const content = getDoc();
    expect(content).toMatch(/SELinux/i);
  });
});

// ---------------------------------------------------------------------------
// Security invariants
// ---------------------------------------------------------------------------

describe('security invariants', () => {
  it('documents fail-closed checksum behavior', () => {
    const content = getDoc();
    expect(content).toMatch(/fail-closed|mismatch.*abort/i);
  });

  it('documents no --skip-verify', () => {
    const content = getDoc();
    expect(content).toMatch(/no.*skip-verify|skip-verify.*never/i);
  });

  it('documents credential isolation invariant', () => {
    const content = getDoc();
    expect(content).toMatch(/[Cc]redentials.*never.*enter.*container|never.*enter.*container/i);
  });

  it('documents read-only filesystem invariant', () => {
    const content = getDoc();
    expect(content).toMatch(/read-only.*filesystem|filesystem.*read-only/i);
  });

  it('documents no sudo invariant', () => {
    const content = getDoc();
    expect(content).toMatch(/[Nn]o.*sudo|never.*sudo/i);
  });
});
