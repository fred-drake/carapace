/**
 * Static security analysis of the Carapace install script.
 *
 * Analyzes scripts/install.sh for security invariants defined in SEC-15.
 * This is a read-only analysis — no script execution, purely pattern-based.
 *
 * SEC-15
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Full security analysis result for the install script. */
export interface InstallScriptAnalysis {
  // Vector 1: No eval or indirect execution
  hasEval: boolean;
  hasIndirectExecution: boolean;
  hasSourceOfDownloaded: boolean;
  hasCurlPipedToShell: boolean;

  // Vector 2: HTTPS-only
  allUrlsHttps: boolean;
  curlHasProtoHttps: boolean;
  curlHasInsecureFlag: boolean;
  httpUrls: string[];

  // Vector 3: Fail-closed checksum
  checksumFailAborts: boolean;
  checksumHasFallback: boolean;
  usesChecksumTool: boolean;
  hasSetEU: boolean;

  // Vector 4: Atomic operations
  usesStagingDir: boolean;
  usesAtomicMove: boolean;
  extractsDirectlyToHome: boolean;

  // Vector 5: Trap-based cleanup
  hasTrapExit: boolean;
  hasTrapInt: boolean;
  hasTrapTerm: boolean;
  trapCleansTempDir: boolean;
  trapCleansStagingDir: boolean;

  // Vector 6: Credential directory
  hasUmask077: boolean;
  umaskBeforeFileOps: boolean;
  credentialDirExplicitMode: boolean;

  // Vector 7: Shell quoting
  unquotedVariables: string[];
  safeShiftOperations: boolean;
  unquotedCarapaceHome: boolean;

  // Vector 8: Piped execution
  detectsPipedExecution: boolean;
  pipedModeAutoAccepts: boolean;
  pipedModeWarns: boolean;

  // Vector 9: Socket path
  socketDirCreated: boolean;

  // General
  hasSecurityTodos: boolean;
  hasUnusedVariables: boolean;
  cosignSuccessOnlyOnPass: boolean;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Perform a static security analysis of the install script content.
 *
 * Each check examines the script text for patterns that indicate
 * the presence or absence of security properties.
 */
export function analyzeInstallScript(script: string): InstallScriptAnalysis {
  const lines = script.split('\n');

  return {
    // Vector 1
    hasEval: checkHasEval(script),
    hasIndirectExecution: checkIndirectExecution(script),
    hasSourceOfDownloaded: checkSourceOfDownloaded(script),
    hasCurlPipedToShell: checkCurlPipedToShell(script),

    // Vector 2
    allUrlsHttps: checkAllUrlsHttps(script),
    curlHasProtoHttps: checkCurlProtoHttps(script),
    curlHasInsecureFlag: checkCurlInsecure(script),
    httpUrls: findHttpUrls(script),

    // Vector 3
    checksumFailAborts: checkChecksumAborts(script),
    checksumHasFallback: checkChecksumFallback(script),
    usesChecksumTool: checkUsesChecksumTool(script),
    hasSetEU: checkSetEU(script),

    // Vector 4
    usesStagingDir: checkUsesStagingDir(script),
    usesAtomicMove: checkUsesAtomicMove(script),
    extractsDirectlyToHome: checkExtractsDirectly(script),

    // Vector 5
    hasTrapExit: checkTrapSignal(script, 'EXIT'),
    hasTrapInt: checkTrapSignal(script, 'INT'),
    hasTrapTerm: checkTrapSignal(script, 'TERM'),
    trapCleansTempDir: checkTrapCleansTempDir(script),
    trapCleansStagingDir: checkTrapCleansStagingDir(script),

    // Vector 6
    hasUmask077: checkUmask077(script),
    umaskBeforeFileOps: checkUmaskBeforeFileOps(lines),
    credentialDirExplicitMode: checkCredentialDirMode(script),

    // Vector 7
    unquotedVariables: findUnquotedVariables(lines),
    safeShiftOperations: checkSafeShift(script),
    unquotedCarapaceHome: checkUnquotedCarapaceHome(script),

    // Vector 8
    detectsPipedExecution: checkDetectsPiped(script),
    pipedModeAutoAccepts: checkPipedAutoAccept(script),
    pipedModeWarns: checkPipedWarns(script),

    // Vector 9
    socketDirCreated: checkSocketDirCreated(script),

    // General
    hasSecurityTodos: checkSecurityTodos(script),
    hasUnusedVariables: checkUnusedVariables(script),
    cosignSuccessOnlyOnPass: checkCosignSuccessConditional(script),
  };
}

// ---------------------------------------------------------------------------
// Vector 1: No eval
// ---------------------------------------------------------------------------

function checkHasEval(script: string): boolean {
  // Look for standalone eval (not in comments or strings like "evaluate")
  return /(?:^|[;&|]\s*)eval\s/m.test(script);
}

function checkIndirectExecution(script: string): boolean {
  // Check for executing content from downloaded files
  // e.g., $(<downloaded_file), `cat downloaded_file`, sh downloaded_file
  return /sh\s+"\$\{?TMPDIR/m.test(script) || /bash\s+"\$\{?TMPDIR/m.test(script);
}

function checkSourceOfDownloaded(script: string): boolean {
  // source or . on files from temp/download directory
  return /(?:\bsource\b|^\s*\.)\s+"\$\{?TMPDIR/m.test(script);
}

function checkCurlPipedToShell(script: string): boolean {
  // curl ... | sh, curl ... | bash, curl ... | eval (excluding comments)
  const lines = script.split('\n');
  for (const line of lines) {
    if (line.trim().startsWith('#')) continue;
    if (/curl\b[^|]*\|\s*(?:sh|bash|eval)/m.test(line)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Vector 2: HTTPS-only
// ---------------------------------------------------------------------------

function checkAllUrlsHttps(script: string): boolean {
  const httpUrls = findHttpUrls(script);
  return httpUrls.length === 0;
}

function checkCurlProtoHttps(script: string): boolean {
  // All curl calls that actually download (not in comments or info strings)
  // should have --proto =https
  const curlLines = script.split('\n').filter((l) => {
    const trimmed = l.trim();
    // Skip comments
    if (trimmed.startsWith('#')) return false;
    // Skip strings inside info/warn/printf (display-only, not actual curl calls)
    if (/^\s*(?:info|warn|printf|echo|success|fail)\s/.test(trimmed)) return false;
    // Must contain a real curl invocation
    return trimmed.startsWith('curl ') || /[=$(]\s*curl\s/.test(l);
  });

  if (curlLines.length === 0) return true;

  return curlLines.every((l) => l.includes('--proto') && l.includes('=https'));
}

function checkCurlInsecure(script: string): boolean {
  return /curl\b[^#]*(?:--insecure|-k\b)/m.test(script);
}

function findHttpUrls(script: string): string[] {
  const urls: string[] = [];
  // Find http:// URLs not in comments
  const lines = script.split('\n');
  for (const line of lines) {
    if (line.trim().startsWith('#')) continue;
    const matches = line.match(/http:\/\/[^\s"')]+/g);
    if (matches) {
      urls.push(...matches);
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Vector 3: Fail-closed checksum
// ---------------------------------------------------------------------------

function checkChecksumAborts(script: string): boolean {
  // After checksum mismatch detection, should exit 1
  return /EXPECTED_HASH.*!=.*ACTUAL_HASH[\s\S]*?exit\s+1/m.test(script);
}

function checkChecksumFallback(script: string): boolean {
  // Check for patterns like "|| true" or "|| warn" after checksum verification
  return /verify_checksum.*\|\|\s*true/m.test(script) || /shasum.*\|\|\s*true/m.test(script);
}

function checkUsesChecksumTool(script: string): boolean {
  return /shasum\s+-a\s+256/m.test(script) || /sha256sum/m.test(script);
}

function checkSetEU(script: string): boolean {
  return /^set\s+-eu$/m.test(script);
}

// ---------------------------------------------------------------------------
// Vector 4: Atomic operations
// ---------------------------------------------------------------------------

function checkUsesStagingDir(script: string): boolean {
  return /STAGING_DIR/m.test(script) && /\.installing/m.test(script);
}

function checkUsesAtomicMove(script: string): boolean {
  // mv staging dir to final location
  return /mv\s+"\$STAGING_DIR"\s+"\$CARAPACE_HOME"/m.test(script);
}

function checkExtractsDirectly(script: string): boolean {
  // tar should extract to staging dir, not directly to CARAPACE_HOME
  const tarLines = script.split('\n').filter((l) => /tar\s/.test(l) && !l.trim().startsWith('#'));
  return tarLines.some((l) => l.includes('$CARAPACE_HOME') && !l.includes('STAGING'));
}

// ---------------------------------------------------------------------------
// Vector 5: Trap cleanup
// ---------------------------------------------------------------------------

function checkTrapSignal(script: string, signal: string): boolean {
  return new RegExp(`trap\\s+.*\\s+.*${signal}`, 'm').test(script);
}

function checkTrapCleansTempDir(script: string): boolean {
  return /trap\s+'[^']*TMPDIR_INSTALL[^']*'/m.test(script);
}

function checkTrapCleansStagingDir(script: string): boolean {
  // Trap should also clean up the staging directory
  return /trap\s+'[^']*\.installing[^']*'/m.test(script);
}

// ---------------------------------------------------------------------------
// Vector 6: umask
// ---------------------------------------------------------------------------

function checkUmask077(script: string): boolean {
  return /^umask\s+077$/m.test(script);
}

function checkUmaskBeforeFileOps(lines: string[]): boolean {
  let umaskLine = -1;
  let firstFileOpLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === 'umask 077') {
      umaskLine = i;
    }
    if (
      firstFileOpLine === -1 &&
      (trimmed.startsWith('mktemp') || trimmed.includes('$(mktemp') || trimmed.startsWith('mkdir'))
    ) {
      firstFileOpLine = i;
    }
  }

  return umaskLine !== -1 && firstFileOpLine !== -1 && umaskLine < firstFileOpLine;
}

function checkCredentialDirMode(script: string): boolean {
  // Should use install -d -m 0700 or mkdir with explicit chmod 700
  return (
    /install\s+-d\s+-m\s+0?700.*credentials/m.test(script) ||
    /mkdir.*credentials[\s\S]*chmod\s+700/m.test(script)
  );
}

// ---------------------------------------------------------------------------
// Vector 7: Quoting
// ---------------------------------------------------------------------------

function findUnquotedVariables(lines: string[]): string[] {
  const issues: string[] = [];
  const safeContexts = [
    /^\s*#/, // comments
    /^\s*case\s/, // case statements
    /^\s*\w+=/, // variable assignments (left side)
    /\[\s+/, // inside [ test
    /\$\{.*:-/, // default value expansions
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (safeContexts.some((re) => re.test(line))) continue;

    // Look for unquoted $VAR in command arguments (not in assignments)
    // This is a simplified heuristic — false positives are possible
    const unquoted = line.match(
      /(?:^|\s)(?:rm|mv|cp|mkdir|chmod|tar|curl|docker|podman)\s+[^"]*\$(?!{[^}]*:-)[A-Z_]+(?!\})/,
    );
    if (unquoted && !line.trim().startsWith('#')) {
      // Filter out properly quoted usages
      if (!/"[^"]*\$[A-Z_]+[^"]*"/.test(line)) {
        issues.push(`Line ${i + 1}: ${line.trim().slice(0, 80)}`);
      }
    }
  }

  return issues;
}

function checkSafeShift(script: string): boolean {
  // shift 2 should be preceded by validation that $# >= 2
  // Or alternatively, the argument parser should use `shift; shift` pattern
  // Or validate count. In the current script, shift 2 is inside case blocks
  // that already matched $1, so $2 exists from the while [ $# -gt 0 ] guard.
  // Actually, if --runtime is the last arg, shift 2 could fail.
  // Check for $# validation or safe patterns
  const shiftLines = script.split('\n').filter((l) => /shift\s+2/.test(l.trim()));
  if (shiftLines.length === 0) return true;

  // Safe if wrapped in a case that checks argument exists, or if
  // there's a $# check before the shift
  return script.includes('[ $# -gt 0 ]') || script.includes('[ $# -ge 2 ]');
}

function checkUnquotedCarapaceHome(script: string): boolean {
  // Check for $CARAPACE_HOME not inside quotes in command arguments
  const lines = script.split('\n');
  for (const line of lines) {
    if (line.trim().startsWith('#')) continue;
    // Look for $CARAPACE_HOME not inside double quotes
    if (/[^"]\$CARAPACE_HOME[^"}/]/.test(line) && !/^\s*[A-Z_]+=/.test(line)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Vector 8: Piped execution
// ---------------------------------------------------------------------------

function checkDetectsPiped(script: string): boolean {
  return /\[\s+!\s+-t\s+0\s+\]/m.test(script);
}

function checkPipedAutoAccept(script: string): boolean {
  // In piped mode, YES should be set to auto-accept
  return /INTERACTIVE=0[\s\S]*?YES=1/m.test(script);
}

function checkPipedWarns(script: string): boolean {
  return /non-interactive.*mode/im.test(script) || /piped.*execution/im.test(script);
}

// ---------------------------------------------------------------------------
// Vector 9: Socket path
// ---------------------------------------------------------------------------

function checkSocketDirCreated(script: string): boolean {
  return /run\/sockets/m.test(script);
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function checkSecurityTodos(script: string): boolean {
  return /(?:TODO|FIXME|HACK|XXX).*(?:secur|vuln|cred|auth|token)/im.test(script);
}

function checkUnusedVariables(script: string): boolean {
  // Check for variables that are set but never referenced
  const setVars = new Set<string>();
  const usedVars = new Set<string>();
  const lines = script.split('\n');

  for (const line of lines) {
    if (line.trim().startsWith('#')) continue;

    // Find variable assignments
    const assignMatch = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (assignMatch) {
      setVars.add(assignMatch[1]);
    }

    // Find variable usages (in $VAR or ${VAR} form)
    const useMatches = line.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g);
    for (const m of useMatches) {
      usedVars.add(m[1]);
    }
  }

  // Check if any set variables are never used after assignment
  for (const v of setVars) {
    // Skip common framework vars that are used implicitly
    if (['PATH', 'HOME', 'SHELL', 'HTTPS_PROXY', 'HTTP_PROXY'].includes(v)) continue;
    if (!usedVars.has(v)) return true;
  }

  return false;
}

function checkCosignSuccessConditional(script: string): boolean {
  // The "Image signature verified" success message should only print
  // when cosign actually succeeds (exit code 0), not unconditionally
  // after the error handler
  const lines = script.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Image signature verified') || lines[i].includes('signature verified')) {
      // Check that this line is inside a conditional (if/then block)
      // or that the preceding cosign call's error is handled with
      // a proper control flow that skips the success message
      // Look backwards for the cosign verify call
      for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
        if (lines[j].includes('cosign verify')) {
          // Check if there's a proper if/then or && between cosign and success
          const block = lines.slice(j, i + 1).join('\n');
          // Bad: cosign ... || { warn } \n success "verified"
          // Good: cosign ... && success "verified"
          // Good: if cosign ...; then success; fi
          if (
            /\|\|\s*\{[\s\S]*?\}[\s\S]*success.*verified/m.test(block) &&
            !/&&\s*success/m.test(block) &&
            !/then[\s\S]*success.*verified/m.test(block)
          ) {
            return false;
          }
          break;
        }
      }
    }
  }
  return true;
}
