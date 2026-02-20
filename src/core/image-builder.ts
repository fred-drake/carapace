/**
 * Image builder for Carapace container images.
 *
 * Orchestrates the full image build: resolves versions, calls
 * runtime.build() with proper build args and OCI labels, and
 * verifies the result.
 */

import type { ContainerRuntime, ImageBuildOptions } from './container/runtime.js';
import {
  resolveGitSha,
  compositeTag,
  parseLabels,
  LABEL_REVISION,
  LABEL_VERSION,
  LABEL_CLAUDE_VERSION,
  LABEL_CREATED,
  type ExecFn,
  type ImageIdentity,
} from './image-identity.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injectable dependencies for the image builder. */
export interface ImageBuilderDeps {
  /** Container runtime to build with. */
  runtime: ContainerRuntime;
  /** Exec function for git operations. */
  exec: ExecFn;
  /** Read the Carapace version from package.json. */
  readPackageVersion: () => string;
  /** Optionally resolve the Claude Code version. Defaults to 'latest'. */
  resolveClaudeVersion?: () => Promise<string>;
}

// ---------------------------------------------------------------------------
// buildImage
// ---------------------------------------------------------------------------

/**
 * Build a Carapace container image with proper OCI labels.
 *
 * Steps:
 *   1. Resolve current git SHA
 *   2. Read Carapace version from package.json
 *   3. Resolve Claude Code version (or default to 'latest')
 *   4. Build image with runtime.build()
 *   5. Verify labels post-build
 *   6. Return ImageIdentity
 *
 * @param deps - Injectable dependencies.
 * @param contextDir - Path to the build context (directory containing Dockerfile).
 * @returns The identity of the built image.
 */
export async function buildImage(
  deps: ImageBuilderDeps,
  contextDir: string,
): Promise<ImageIdentity> {
  // 1. Resolve git SHA
  const gitSha = await resolveGitSha(deps.exec);

  // 2. Read Carapace version
  const carapaceVersion = deps.readPackageVersion();

  // 3. Resolve Claude Code version
  let claudeVersion = 'latest';
  if (deps.resolveClaudeVersion) {
    claudeVersion = await deps.resolveClaudeVersion();
  }

  // 4. Build the image
  const tag = compositeTag(claudeVersion, gitSha);
  const buildDate = new Date().toISOString();

  const buildOptions: ImageBuildOptions = {
    contextDir,
    tag,
    buildArgs: {
      CLAUDE_CODE_VERSION: claudeVersion,
      CARAPACE_VERSION: carapaceVersion,
      GIT_SHA: gitSha,
      BUILD_DATE: buildDate,
    },
    labels: {
      [LABEL_REVISION]: gitSha,
      [LABEL_VERSION]: carapaceVersion,
      [LABEL_CLAUDE_VERSION]: claudeVersion,
      [LABEL_CREATED]: buildDate,
    },
  };

  await deps.runtime.build(buildOptions);

  // 5. Verify labels post-build
  const labels = await deps.runtime.inspectLabels(tag);
  const identity = parseLabels(labels);

  if (!identity) {
    throw new Error('Image built but labels could not be verified');
  }

  return identity;
}
