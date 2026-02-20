/**
 * Image identity utilities for Carapace.
 *
 * Resolves git SHAs, compares OCI labels embedded in container images,
 * and determines whether an image is current or stale relative to the
 * working tree.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injectable exec function (same shape as runtime ExecFn). */
export type ExecFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Parsed identity from OCI labels embedded in a container image. */
export interface ImageIdentity {
  /** Composite image tag (e.g. "carapace:2.1.49-abc1234"). */
  tag: string;
  /** Short git SHA the image was built from. */
  gitSha: string;
  /** Claude Code version baked into the image. */
  claudeVersion: string;
  /** Carapace version baked into the image. */
  carapaceVersion: string;
  /** ISO 8601 build timestamp. */
  buildDate: string;
}

// ---------------------------------------------------------------------------
// OCI label keys (constants)
// ---------------------------------------------------------------------------

export const LABEL_REVISION = 'org.opencontainers.image.revision';
export const LABEL_VERSION = 'org.opencontainers.image.version';
export const LABEL_CLAUDE_VERSION = 'ai.carapace.claude-code-version';
export const LABEL_CREATED = 'org.opencontainers.image.created';

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Resolve the current short git SHA from the working tree.
 * @param exec - Injectable exec function.
 * @returns 7-character short SHA string.
 */
export async function resolveGitSha(exec: ExecFn): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', '--short', 'HEAD']);
  return stdout.trim();
}

/**
 * Check whether an image's embedded git SHA matches the current HEAD.
 * @param labels - OCI labels read from the image via inspectLabels().
 * @param currentSha - Current git SHA from resolveGitSha().
 * @returns true if the image was built from the current HEAD.
 */
export function isImageCurrent(labels: Record<string, string>, currentSha: string): boolean {
  const imageSha = labels[LABEL_REVISION];
  if (!imageSha) return false;
  return imageSha === currentSha;
}

/**
 * Generate a composite image tag from Claude Code version and git SHA.
 * @returns Tag string like "carapace:2.1.49-abc1234".
 */
export function compositeTag(claudeVersion: string, gitSha: string): string {
  return `carapace:${claudeVersion}-${gitSha}`;
}

/**
 * Parse an ImageIdentity from OCI labels.
 * @returns Parsed identity, or null if required labels are missing.
 */
export function parseLabels(labels: Record<string, string>): ImageIdentity | null {
  const gitSha = labels[LABEL_REVISION];
  const carapaceVersion = labels[LABEL_VERSION];
  const claudeVersion = labels[LABEL_CLAUDE_VERSION];
  const buildDate = labels[LABEL_CREATED];

  if (!gitSha || !claudeVersion) return null;

  return {
    tag: compositeTag(claudeVersion, gitSha),
    gitSha,
    claudeVersion,
    carapaceVersion: carapaceVersion ?? 'unknown',
    buildDate: buildDate ?? 'unknown',
  };
}
