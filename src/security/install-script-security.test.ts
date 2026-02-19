/**
 * Security-specific tests for the Carapace install script.
 *
 * Static analysis of scripts/install.sh to verify each security vector
 * from SEC-15. Tests read the script content and verify patterns/invariants
 * without executing the script.
 *
 * Vectors tested:
 * 1. No eval or indirect execution of downloaded content
 * 2. HTTPS-only downloads with certificate validation
 * 3. Fail-closed checksum verification
 * 4. Atomic directory operations
 * 5. Trap-based cleanup
 * 6. umask 077 for credential directory
 * 7. Proper shell quoting (no word splitting)
 * 8. Piped execution detection
 * 9. Socket path validation rejects symlinks
 *
 * SEC-15
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeInstallScript, type InstallScriptAnalysis } from './install-script-security.js';

// ---------------------------------------------------------------------------
// Load script once for all tests
// ---------------------------------------------------------------------------

let script: string;
let analysis: InstallScriptAnalysis;

beforeAll(() => {
  const scriptPath = join(__dirname, '../../scripts/install.sh');
  script = readFileSync(scriptPath, 'utf-8');
  analysis = analyzeInstallScript(script);
});

// ---------------------------------------------------------------------------
// Vector 1: No eval or indirect execution of downloaded content
// ---------------------------------------------------------------------------

describe('Vector 1: No eval or indirect execution', () => {
  it('should not contain eval keyword', () => {
    expect(analysis.hasEval).toBe(false);
  });

  it('should not use $() or backticks to execute downloaded file content', () => {
    // The script should never execute content from downloaded files
    // curl output is saved to files then verified — not piped to sh/eval
    expect(analysis.hasIndirectExecution).toBe(false);
  });

  it('should not use source/dot on downloaded content', () => {
    expect(analysis.hasSourceOfDownloaded).toBe(false);
  });

  it('should not pipe curl to sh/bash/eval', () => {
    // The script itself may be piped, but it should not pipe any
    // of its own curl calls into a shell
    expect(analysis.hasCurlPipedToShell).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Vector 2: HTTPS-only downloads with certificate validation
// ---------------------------------------------------------------------------

describe('Vector 2: HTTPS-only downloads', () => {
  it('should only use HTTPS URLs for downloads', () => {
    expect(analysis.allUrlsHttps).toBe(true);
  });

  it('should use --proto =https on curl calls', () => {
    expect(analysis.curlHasProtoHttps).toBe(true);
  });

  it('should not disable certificate validation (--insecure / -k)', () => {
    expect(analysis.curlHasInsecureFlag).toBe(false);
  });

  it('should not contain any http:// URLs', () => {
    expect(analysis.httpUrls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Vector 3: Fail-closed checksum verification
// ---------------------------------------------------------------------------

describe('Vector 3: Fail-closed checksum verification', () => {
  it('should abort on checksum mismatch (exit 1)', () => {
    expect(analysis.checksumFailAborts).toBe(true);
  });

  it('should not have a fallback/skip on checksum failure', () => {
    expect(analysis.checksumHasFallback).toBe(false);
  });

  it('should verify checksum using shasum or sha256sum', () => {
    expect(analysis.usesChecksumTool).toBe(true);
  });

  it('should set -eu for strict error handling', () => {
    expect(analysis.hasSetEU).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Vector 4: Atomic directory operations
// ---------------------------------------------------------------------------

describe('Vector 4: Atomic directory operations', () => {
  it('should use a staging directory for extraction', () => {
    expect(analysis.usesStagingDir).toBe(true);
  });

  it('should use mv for atomic final placement', () => {
    expect(analysis.usesAtomicMove).toBe(true);
  });

  it('should not extract directly to CARAPACE_HOME', () => {
    expect(analysis.extractsDirectlyToHome).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Vector 5: Trap-based cleanup
// ---------------------------------------------------------------------------

describe('Vector 5: Trap-based cleanup', () => {
  it('should have trap for EXIT signal', () => {
    expect(analysis.hasTrapExit).toBe(true);
  });

  it('should have trap for INT signal', () => {
    expect(analysis.hasTrapInt).toBe(true);
  });

  it('should have trap for TERM signal', () => {
    expect(analysis.hasTrapTerm).toBe(true);
  });

  it('should clean up temp directory in trap', () => {
    expect(analysis.trapCleansTempDir).toBe(true);
  });

  it('should clean up staging directory in trap', () => {
    expect(analysis.trapCleansStagingDir).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Vector 6: umask 077 for credential directory
// ---------------------------------------------------------------------------

describe('Vector 6: Credential directory permissions', () => {
  it('should set umask 077 before any file operations', () => {
    expect(analysis.hasUmask077).toBe(true);
  });

  it('should set umask before mktemp and mkdir calls', () => {
    expect(analysis.umaskBeforeFileOps).toBe(true);
  });

  it('should create credentials directory with explicit 0700 mode', () => {
    expect(analysis.credentialDirExplicitMode).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Vector 7: Proper shell quoting
// ---------------------------------------------------------------------------

describe('Vector 7: Shell quoting safety', () => {
  it('should quote all variable expansions in command arguments', () => {
    // Check for unquoted variable patterns that could lead to word splitting
    expect(analysis.unquotedVariables).toHaveLength(0);
  });

  it('should validate argument count before shift 2', () => {
    expect(analysis.safeShiftOperations).toBe(true);
  });

  it('should not have unquoted $CARAPACE_HOME usages', () => {
    expect(analysis.unquotedCarapaceHome).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Vector 8: Piped execution detection
// ---------------------------------------------------------------------------

describe('Vector 8: Piped execution detection', () => {
  it('should detect non-interactive stdin ([ ! -t 0 ])', () => {
    expect(analysis.detectsPipedExecution).toBe(true);
  });

  it('should suppress interactive prompts in piped mode', () => {
    expect(analysis.pipedModeAutoAccepts).toBe(true);
  });

  it('should warn about piped execution', () => {
    expect(analysis.pipedModeWarns).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Vector 9: Socket path validation
// ---------------------------------------------------------------------------

describe('Vector 9: Socket path safety', () => {
  it('should create socket directory with restricted permissions', () => {
    expect(analysis.socketDirCreated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Additional security properties
// ---------------------------------------------------------------------------

describe('General security properties', () => {
  it('should start with #!/bin/sh (POSIX shell)', () => {
    expect(script.startsWith('#!/bin/sh')).toBe(true);
  });

  it('should not contain TODO/FIXME/HACK security comments', () => {
    expect(analysis.hasSecurityTodos).toBe(false);
  });

  it('should not have dead code that could confuse reviewers', () => {
    expect(analysis.hasUnusedVariables).toBe(false);
  });

  it('should print cosign success only when verification actually succeeds', () => {
    expect(analysis.cosignSuccessOnlyOnPass).toBe(true);
  });
});
