/**
 * Supply chain security verification for Carapace.
 *
 * Provides utilities for CI and local verification of:
 * - Lockfile integrity (pnpm-lock.yaml matches package.json)
 * - Secret pattern detection in source files
 * - Audit severity parsing and merge-blocking logic
 *
 * Used by the CI pipeline (`.github/workflows/ci.yml`) and can be
 * run locally via the health check system.
 *
 * SEC-09
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single finding from `pnpm audit`. */
export interface AuditFinding {
  severity: string;
  package: string;
  title: string;
  url: string;
}

/** A detected secret pattern in source code. */
export interface SecretDetection {
  file: string;
  line: number;
  pattern: string;
  match: string;
}

/** Result of lockfile integrity verification. */
export interface LockfileIntegrityResult {
  valid: boolean;
  issues: string[];
}

// ---------------------------------------------------------------------------
// Secret patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate potential credential leakage in source code.
 *
 * Each entry has a human-readable label and a RegExp. The regex is
 * tested against each line of source files. Matches indicate a
 * potential secret that should not be committed.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: 'Bearer token', regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i },
  { label: 'AWS access key', regex: /AKIA[0-9A-Z]{16}/ },
  { label: 'GitHub token (ghp_)', regex: /ghp_[A-Za-z0-9]{36}/ },
  { label: 'GitHub token (gho_)', regex: /gho_[A-Za-z0-9]{36}/ },
  { label: 'GitHub token (ghs_)', regex: /ghs_[A-Za-z0-9]{36}/ },
  { label: 'sk- API key', regex: /sk-[A-Za-z0-9\-_]{20,}/ },
  { label: 'PEM private key', regex: /-----BEGIN\s+(RSA\s+|EC\s+|DSA\s+)?PRIVATE KEY-----/ },
  {
    label: 'Connection string with password',
    regex: /(?:postgresql|mysql|mongodb|redis):\/\/[^:]+:[^@]+@/,
  },
  {
    label: 'Slack webhook',
    regex: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/,
  },
  { label: 'npm token', regex: /npm_[A-Za-z0-9]{36}/ },
];

// ---------------------------------------------------------------------------
// verifyLockfileIntegrity
// ---------------------------------------------------------------------------

/**
 * Verify that a pnpm lockfile is consistent with package.json.
 *
 * Checks:
 * 1. Lockfile is non-empty
 * 2. Every dependency in package.json appears in the lockfile
 * 3. Specifiers in lockfile match package.json version ranges
 *
 * This is a lightweight check. For full integrity verification,
 * `pnpm install --frozen-lockfile` is the authoritative tool.
 */
export function verifyLockfileIntegrity(
  packageJsonContent: string,
  lockfileContent: string,
): LockfileIntegrityResult {
  const issues: string[] = [];

  // Parse package.json
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(packageJsonContent) as Record<string, unknown>;
  } catch {
    return { valid: false, issues: ['Failed to parse package.json — invalid JSON'] };
  }

  // Check lockfile exists
  if (!lockfileContent || lockfileContent.trim().length === 0) {
    return { valid: false, issues: ['Lockfile is missing or empty'] };
  }

  // Extract specifiers from lockfile (simple YAML-like parsing)
  const lockSpecifiers = parseLockfileSpecifiers(lockfileContent);

  // Check dependencies
  const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
  for (const [name, specifier] of Object.entries(deps)) {
    const lockSpec = lockSpecifiers.get(name);
    if (lockSpec === undefined) {
      issues.push(`Dependency "${name}" in package.json not found in lockfile`);
    } else if (lockSpec !== specifier) {
      issues.push(
        `Dependency "${name}" specifier mismatch: package.json="${specifier}", lockfile="${lockSpec}"`,
      );
    }
  }

  // Check devDependencies
  const devDeps = (pkg['devDependencies'] ?? {}) as Record<string, string>;
  for (const [name, specifier] of Object.entries(devDeps)) {
    const lockSpec = lockSpecifiers.get(name);
    if (lockSpec === undefined) {
      issues.push(`DevDependency "${name}" in package.json not found in lockfile`);
    } else if (lockSpec !== specifier) {
      issues.push(
        `DevDependency "${name}" specifier mismatch: package.json="${specifier}", lockfile="${lockSpec}"`,
      );
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Extract package specifiers from a pnpm lockfile.
 *
 * Simple line-based parser that finds `specifier:` entries under
 * the `importers` section. Not a full YAML parser — just enough
 * to extract specifier strings for integrity checking.
 */
function parseLockfileSpecifiers(lockfile: string): Map<string, string> {
  const specifiers = new Map<string, string>();
  const lines = lockfile.split('\n');

  let inImporters = false;
  let currentPackage: string | null = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Detect importers section
    if (trimmed === 'importers:') {
      inImporters = true;
      continue;
    }

    if (!inImporters) continue;

    // Exit importers on next top-level key
    if (trimmed.length > 0 && !trimmed.startsWith(' ') && trimmed !== 'importers:') {
      break;
    }

    // Detect package name (indented, ends with colon, not 'specifier:')
    const pkgMatch = trimmed.match(/^\s{6}([a-z@][a-z0-9@/._ -]*):$/);
    if (pkgMatch) {
      currentPackage = pkgMatch[1];
      continue;
    }

    // Detect specifier line
    if (currentPackage) {
      const specMatch = trimmed.match(/^\s+specifier:\s*"?([^"]+)"?$/);
      if (specMatch) {
        specifiers.set(currentPackage, specMatch[1]);
        currentPackage = null;
      }
    }
  }

  return specifiers;
}

// ---------------------------------------------------------------------------
// detectSecretPatterns
// ---------------------------------------------------------------------------

/**
 * Scan content for potential secret patterns.
 *
 * Returns an array of detections with file, line number, pattern label,
 * and a truncated match string. Used for pre-commit and CI secret scanning.
 */
export function detectSecretPatterns(content: string, file: string): SecretDetection[] {
  const detections: SecretDetection[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { label, regex } of SECRET_PATTERNS) {
      const match = line.match(regex);
      if (match) {
        detections.push({
          file,
          line: i + 1,
          pattern: label,
          match: match[0].length > 40 ? match[0].slice(0, 40) + '...' : match[0],
        });
      }
    }
  }

  return detections;
}

// ---------------------------------------------------------------------------
// parseAuditSeverity
// ---------------------------------------------------------------------------

/** Severity levels in order from most to least severe. */
const SEVERITY_ORDER: ReadonlyArray<string> = ['critical', 'high', 'moderate', 'low', 'info'];

/**
 * Filter audit findings to those at or above a minimum severity level.
 *
 * @param findings - Raw audit findings.
 * @param minSeverity - Minimum severity to include (default: 'high').
 * @returns Filtered findings at or above the minimum severity.
 */
export function parseAuditSeverity(
  findings: AuditFinding[],
  minSeverity: string = 'high',
): AuditFinding[] {
  const minIndex = SEVERITY_ORDER.indexOf(minSeverity);
  if (minIndex === -1) return findings;

  return findings.filter((f) => {
    const idx = SEVERITY_ORDER.indexOf(f.severity);
    return idx !== -1 && idx <= minIndex;
  });
}

// ---------------------------------------------------------------------------
// shouldBlockMerge
// ---------------------------------------------------------------------------

/**
 * Determine whether audit findings should block a merge.
 *
 * Returns true if any finding is critical or high severity.
 */
export function shouldBlockMerge(findings: AuditFinding[]): boolean {
  return findings.some((f) => f.severity === 'critical' || f.severity === 'high');
}
