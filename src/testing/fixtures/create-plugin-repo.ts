/**
 * Test fixture helper: programmatically builds local bare git repos
 * for plugin installer integration tests.
 *
 * Creates a bare repo + a work repo, commits files, and pushes so
 * the bare repo can be cloned via file:// URLs.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

export interface CreatePluginRepoOptions {
  manifest: Record<string, unknown>;
  handlerContent?: string;
  skillContent?: string;
}

/**
 * Create a bare git repo containing a plugin with the given manifest
 * and optional handler/skill files. Returns the path to the bare repo.
 *
 * @param tmpDir - Temporary directory to create repos in
 * @param opts - Plugin content options
 * @returns Absolute path to the bare git repo (for use with file:// URLs)
 */
export async function createPluginRepo(
  tmpDir: string,
  opts: CreatePluginRepoOptions,
): Promise<string> {
  const bareDir = join(tmpDir, 'bare.git');
  const workDir = join(tmpDir, 'work');

  // Create bare repo
  mkdirSync(bareDir, { recursive: true });
  await git(['init', '--bare', bareDir]);

  // Create work repo and clone from bare
  mkdirSync(workDir, { recursive: true });
  await git(['clone', bareDir, workDir]);

  // Configure git user for commits
  await git(['config', 'user.email', 'test@example.com'], workDir);
  await git(['config', 'user.name', 'Test'], workDir);

  // Write manifest.json
  writeFileSync(join(workDir, 'manifest.json'), JSON.stringify(opts.manifest, null, 2), 'utf-8');

  // Write optional handler.ts
  if (opts.handlerContent) {
    writeFileSync(join(workDir, 'handler.ts'), opts.handlerContent, 'utf-8');
  }

  // Write optional skills/
  if (opts.skillContent) {
    const skillsDir = join(workDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'skill.md'), opts.skillContent, 'utf-8');
  }

  // Add, commit, push
  await git(['add', '.'], workDir);
  await git(['commit', '-m', 'Initial commit'], workDir);
  await git(['push', 'origin', 'HEAD'], workDir);

  return bareDir;
}

/**
 * Push an updated manifest to an existing fixture repo.
 * Clones the bare repo to a fresh work dir, updates manifest.json,
 * commits, and pushes.
 *
 * @param tmpDir - Parent temp dir (must contain bare.git)
 * @param bareDir - Path to the bare repo
 * @param updatedManifest - New manifest content
 */
export async function updatePluginRepo(
  tmpDir: string,
  bareDir: string,
  updatedManifest: Record<string, unknown>,
): Promise<void> {
  const updateWorkDir = join(tmpDir, 'update-work');

  await git(['clone', bareDir, updateWorkDir]);
  await git(['config', 'user.email', 'test@example.com'], updateWorkDir);
  await git(['config', 'user.name', 'Test'], updateWorkDir);

  writeFileSync(
    join(updateWorkDir, 'manifest.json'),
    JSON.stringify(updatedManifest, null, 2),
    'utf-8',
  );

  await git(['add', '.'], updateWorkDir);
  await git(['commit', '-m', 'Update manifest'], updateWorkDir);
  await git(['push', 'origin', 'HEAD'], updateWorkDir);
}

async function git(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execFile('git', args, { cwd, timeout: 30_000 });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
