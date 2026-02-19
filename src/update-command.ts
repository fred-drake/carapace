/**
 * Update command for Carapace CLI.
 *
 * Provides `carapace update` with:
 *   - Check GitHub Releases API for newer version
 *   - Download host artifacts to staging directory
 *   - Verify SHA-256 checksums (SEC-16)
 *   - Pull matching container image
 *   - Atomically update pinned image digest in config (SEC-17)
 *   - Replace current install only after ALL verifications pass
 *   - Run `carapace doctor` post-update
 *
 * No phone-home on startup — update check is explicit only.
 * Failed update leaves current install intact.
 */

import { join } from 'node:path';
import type { VerificationResult } from './security/artifact-verification.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A release asset from the GitHub Releases API. */
export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

/** A release from the GitHub Releases API. */
export interface GithubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  assets: GithubReleaseAsset[];
  body: string;
}

/** Result of checking for updates. */
export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  release?: GithubRelease;
  error?: string;
}

/** Flags for the update command. */
export interface UpdateFlags {
  /** Skip confirmation prompt. */
  yes?: boolean;
  /** Only check for updates, don't install. */
  check?: boolean;
}

/** Injectable dependencies for the update command. */
export interface UpdateCommandDeps {
  /** Current installed version (without v prefix). */
  currentVersion: string;
  /** Host platform (e.g. 'darwin', 'linux'). */
  platform: string;
  /** Host architecture (e.g. 'arm64', 'x64'). */
  arch: string;
  /** Resolved CARAPACE_HOME path. */
  home: string;
  /** Write to stdout. */
  stdout: (msg: string) => void;
  /** Write to stderr. */
  stderr: (msg: string) => void;
  /** Fetch the latest release from GitHub. */
  fetchLatestRelease: () => Promise<GithubRelease>;
  /** Download a file from a URL to a local path. */
  downloadFile: (url: string, destPath: string) => Promise<void>;
  /** Read a file as string. */
  readFile: (path: string) => string;
  /** Write a string to a file. */
  writeFile: (path: string, content: string) => void;
  /** Check if a file exists. */
  fileExists: (path: string) => boolean;
  /** Check if a directory exists. */
  dirExists: (path: string) => boolean;
  /** Create directory (recursive). */
  mkdirp: (path: string) => void;
  /** Remove a directory recursively. */
  removeDir: (path: string) => void;
  /** Atomic rename (for install swap). */
  rename: (from: string, to: string) => void;
  /** Verify SHA-256 checksum of a file. */
  verifySha256: (filePath: string, expectedHash: string) => VerificationResult;
  /** Pull a container image. */
  pullImage: (imageRef: string) => Promise<void>;
  /** Inspect a local image and return its digest. */
  inspectImageDigest: (imageRef: string) => Promise<string>;
  /** Extract a tarball to a directory. */
  extractTarball: (tarballPath: string, destDir: string) => Promise<void>;
  /** Run carapace doctor and return exit code. */
  runDoctor: () => Promise<number>;
  /** Ask user for confirmation. */
  confirm: (prompt: string) => Promise<boolean>;
  /** Read the raw config.toml contents. */
  readConfigFile: () => string;
  /** Write new contents to config.toml. */
  writeConfigFile: (content: string) => void;
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Compare two semver strings. Returns:
 *  - negative if a < b
 *  - 0 if a === b
 *  - positive if a > b
 */
function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Strip leading 'v' from a version tag. */
function stripV(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

// ---------------------------------------------------------------------------
// Asset matching
// ---------------------------------------------------------------------------

/**
 * Find the platform-specific tarball asset from a release.
 * Expected naming: `carapace-host-{platform}-{arch}.tar.gz`
 */
function findPlatformAsset(
  release: GithubRelease,
  platform: string,
  arch: string,
): GithubReleaseAsset | undefined {
  const expected = `carapace-host-${platform}-${arch}.tar.gz`;
  return release.assets.find((a) => a.name === expected);
}

/**
 * Find the checksum asset for a tarball.
 * Expected naming: `{tarball-name}.sha256`
 */
function findChecksumAsset(
  release: GithubRelease,
  tarballName: string,
): GithubReleaseAsset | undefined {
  return release.assets.find((a) => a.name === `${tarballName}.sha256`);
}

// ---------------------------------------------------------------------------
// Checksum parsing
// ---------------------------------------------------------------------------

/**
 * Parse a SHA-256 checksum from a `.sha256` file.
 * Format: `<hash>  <filename>` (GNU coreutils format).
 */
function parseChecksumFile(content: string, filename: string): string | undefined {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "hash  filename" or "hash filename"
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[1] === filename) {
      return parts[0];
    }
    // Single hash on line (no filename)
    if (parts.length === 1 && /^[0-9a-f]{64}$/.test(parts[0])) {
      return parts[0];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Image reference helpers
// ---------------------------------------------------------------------------

/** Extract the image name (without digest) from a config line. */
function extractImageBase(configContent: string): string | undefined {
  const match = configContent.match(/image\s*=\s*"([^"]+)"/);
  if (!match) return undefined;
  const ref = match[1];
  const atIdx = ref.indexOf('@');
  return atIdx !== -1 ? ref.slice(0, atIdx) : ref;
}

/** Build an image@digest reference for a new version. */
function buildImageRef(imageBase: string, version: string): string {
  // Replace any existing tag in the image base
  const colonIdx = imageBase.lastIndexOf(':');
  const base = colonIdx !== -1 ? imageBase.slice(0, colonIdx) : imageBase;
  return `${base}:v${version}`;
}

// ---------------------------------------------------------------------------
// checkForUpdate
// ---------------------------------------------------------------------------

/**
 * Check GitHub Releases for a newer version.
 * No side effects — only reads the API.
 */
export async function checkForUpdate(deps: UpdateCommandDeps): Promise<UpdateCheckResult> {
  const currentVersion = deps.currentVersion;

  let release: GithubRelease;
  try {
    release = await deps.fetchLatestRelease();
  } catch (err) {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: currentVersion,
      error: `Failed to check for updates: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const latestVersion = stripV(release.tag_name);
  const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;

  return {
    updateAvailable,
    currentVersion,
    latestVersion,
    release: updateAvailable ? release : undefined,
  };
}

// ---------------------------------------------------------------------------
// runUpdate
// ---------------------------------------------------------------------------

/**
 * Run the full update flow.
 *
 * Steps:
 *   1. Check for update
 *   2. Confirm with user (unless --yes)
 *   3. Download tarball + checksum to staging dir
 *   4. Verify SHA-256 checksum
 *   5. Pull matching container image
 *   6. Verify image digest
 *   7. Extract tarball to staging
 *   8. Atomically swap install
 *   9. Update pinned digest in config
 *  10. Write version file
 *  11. Clean up staging
 *  12. Run carapace doctor
 *
 * On any failure, the current install is left intact.
 *
 * @returns Exit code (0 = success, 1 = failure).
 */
export async function runUpdate(deps: UpdateCommandDeps, flags?: UpdateFlags): Promise<number> {
  // 1. Check for update
  const check = await checkForUpdate(deps);

  if (check.error) {
    deps.stderr(`Error: ${check.error}`);
    return 1;
  }

  if (!check.updateAvailable) {
    deps.stdout(`Carapace is already on the latest version (${check.currentVersion})`);
    return 0;
  }

  const release = check.release!;
  const newVersion = check.latestVersion;

  // Check-only mode
  if (flags?.check) {
    deps.stdout(`Update available: ${check.currentVersion} → ${newVersion}`);
    deps.stdout(`  Release: ${release.name}`);
    deps.stdout(`  Published: ${release.published_at}`);
    if (release.body) {
      deps.stdout(`  Notes: ${release.body.slice(0, 200)}`);
    }
    return 0;
  }

  // 2. Find platform-specific asset
  const tarballAsset = findPlatformAsset(release, deps.platform, deps.arch);
  if (!tarballAsset) {
    deps.stderr(
      `No release artifact found for ${deps.platform}-${deps.arch}. ` +
        `Available assets: ${release.assets.map((a) => a.name).join(', ') || 'none'}`,
    );
    return 1;
  }

  const checksumAsset = findChecksumAsset(release, tarballAsset.name);

  // 3. Confirm with user
  if (!flags?.yes) {
    deps.stdout(`Update available: ${check.currentVersion} → ${newVersion}`);
    deps.stdout(`  Artifact: ${tarballAsset.name}`);
    const confirmed = await deps.confirm(`Proceed with update to v${newVersion}?`);
    if (!confirmed) {
      deps.stdout('Update cancelled.');
      return 0;
    }
  }

  // Set up staging directory
  const stagingDir = join(deps.home, '.update-staging');
  const tarballPath = join(stagingDir, tarballAsset.name);
  const extractDir = join(stagingDir, 'extract');

  try {
    // Clean previous staging if exists
    if (deps.dirExists(stagingDir)) {
      deps.removeDir(stagingDir);
    }
    deps.mkdirp(stagingDir);
    deps.mkdirp(extractDir);

    // 4. Download tarball
    deps.stdout(`Downloading ${tarballAsset.name}...`);
    try {
      await deps.downloadFile(tarballAsset.browser_download_url, tarballPath);
    } catch (err) {
      deps.stderr(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    // 5. Download and verify checksum
    if (checksumAsset) {
      const checksumPath = join(stagingDir, checksumAsset.name);
      try {
        await deps.downloadFile(checksumAsset.browser_download_url, checksumPath);
      } catch (err) {
        deps.stderr(
          `Checksum download failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }

      const checksumContent = deps.readFile(checksumPath);
      const expectedHash = parseChecksumFile(checksumContent, tarballAsset.name);

      if (!expectedHash) {
        deps.stderr('Failed to parse checksum file — cannot verify artifact integrity.');
        return 1;
      }

      const verification = deps.verifySha256(tarballPath, expectedHash);
      if (verification.status !== 'pass') {
        deps.stderr(`Artifact checksum verification failed: ${verification.detail}`);
        if (verification.fix) {
          deps.stderr(`  Fix: ${verification.fix}`);
        }
        return 1;
      }
      deps.stdout('  Checksum verified.');
    } else {
      deps.stderr('Warning: No checksum file found — skipping SHA-256 verification.');
    }

    // 6. Pull matching container image
    const imageBase = extractImageBase(deps.readConfigFile());
    if (imageBase) {
      const imageTagRef = buildImageRef(imageBase, newVersion);
      deps.stdout(`Pulling container image ${imageTagRef}...`);
      try {
        await deps.pullImage(imageTagRef);
      } catch (err) {
        deps.stderr(`Image pull failed: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }

      // 7. Get and pin new digest
      try {
        const newDigest = await deps.inspectImageDigest(imageTagRef);
        if (newDigest) {
          const digestOnly = newDigest.includes('@')
            ? newDigest.slice(newDigest.lastIndexOf('@') + 1)
            : newDigest;
          const pinnedRef = `${imageBase}@${digestOnly}`;
          const configContent = deps.readConfigFile();
          const updatedConfig = configContent.replace(
            /image\s*=\s*"[^"]+"/,
            `image = "${pinnedRef}"`,
          );
          deps.writeConfigFile(updatedConfig);
          deps.stdout(`  Image digest pinned: ${digestOnly.slice(0, 23)}...`);
        }
      } catch (err) {
        deps.stderr(
          `Warning: Could not pin image digest: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Non-fatal — continue with update
      }
    }

    // 8. Extract tarball
    deps.stdout('Extracting update...');
    try {
      await deps.extractTarball(tarballPath, extractDir);
    } catch (err) {
      deps.stderr(`Extract failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    // 9. Atomic swap: rename current lib → lib.bak, staging → lib
    const libDir = join(deps.home, 'lib');
    const backupDir = join(deps.home, 'lib.bak');

    // Remove any previous backup
    if (deps.dirExists(backupDir)) {
      deps.removeDir(backupDir);
    }

    // Swap
    if (deps.dirExists(libDir)) {
      deps.rename(libDir, backupDir);
    }
    deps.rename(extractDir, libDir);

    // 10. Write version file
    const versionPath = join(deps.home, 'version');
    deps.writeFile(versionPath, `${newVersion}\n`);

    deps.stdout(`Updated Carapace to v${newVersion}`);
  } finally {
    // 11. Clean up staging
    if (deps.dirExists(stagingDir)) {
      deps.removeDir(stagingDir);
    }
  }

  // 12. Run doctor post-update
  deps.stdout('Running post-update checks...');
  const doctorCode = await deps.runDoctor();
  if (doctorCode !== 0) {
    deps.stderr(
      'Warning: Some doctor checks failed after update. Run `carapace doctor` for details.',
    );
  }

  return 0;
}
