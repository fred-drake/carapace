import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkForUpdate,
  runUpdate,
  type UpdateCommandDeps,
  type GithubRelease,
} from './update-command.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CURRENT_VERSION = '0.1.0';

const NEWER_RELEASE: GithubRelease = {
  tag_name: 'v0.2.0',
  name: 'Carapace v0.2.0',
  published_at: '2026-02-15T12:00:00Z',
  assets: [
    {
      name: 'carapace-host-darwin-arm64.tar.gz',
      browser_download_url:
        'https://github.com/fred-drake/carapace/releases/download/v0.2.0/carapace-host-darwin-arm64.tar.gz',
    },
    {
      name: 'carapace-host-darwin-arm64.tar.gz.sha256',
      browser_download_url:
        'https://github.com/fred-drake/carapace/releases/download/v0.2.0/carapace-host-darwin-arm64.tar.gz.sha256',
    },
  ],
  body: 'Release notes for v0.2.0',
};

const CURRENT_RELEASE: GithubRelease = {
  tag_name: 'v0.1.0',
  name: 'Carapace v0.1.0',
  published_at: '2026-01-01T12:00:00Z',
  assets: [],
  body: 'Initial release',
};

const VALID_DIGEST = 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

function createDeps(overrides?: Partial<UpdateCommandDeps>): UpdateCommandDeps {
  return {
    currentVersion: CURRENT_VERSION,
    platform: 'darwin',
    arch: 'arm64',
    home: '/home/user/.carapace',
    stdout: vi.fn(),
    stderr: vi.fn(),
    fetchLatestRelease: vi.fn().mockResolvedValue(NEWER_RELEASE),
    downloadFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockReturnValue(`expectedhash  carapace-host-darwin-arm64.tar.gz\n`),
    writeFile: vi.fn(),
    fileExists: vi.fn().mockReturnValue(true),
    dirExists: vi.fn().mockReturnValue(true),
    mkdirp: vi.fn(),
    removeDir: vi.fn(),
    rename: vi.fn(),
    verifySha256: vi.fn().mockReturnValue({ status: 'pass', detail: 'SHA-256 verified' }),
    pullImage: vi.fn().mockResolvedValue(undefined),
    inspectImageDigest: vi.fn().mockResolvedValue(VALID_DIGEST),
    extractTarball: vi.fn().mockResolvedValue(undefined),
    runDoctor: vi.fn().mockResolvedValue(0),
    confirm: vi.fn().mockResolvedValue(true),
    readConfigFile: vi
      .fn()
      .mockReturnValue(
        '[runtime]\nimage = "ghcr.io/fred-drake/carapace-agent@sha256:olddigest1234567890olddigest1234567890olddigest1234567890old"\n',
      ),
    writeConfigFile: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkForUpdate
// ---------------------------------------------------------------------------

describe('checkForUpdate', () => {
  it('detects a newer version available', async () => {
    const deps = createDeps();

    const result = await checkForUpdate(deps);

    expect(result.updateAvailable).toBe(true);
    expect(result.currentVersion).toBe('0.1.0');
    expect(result.latestVersion).toBe('0.2.0');
    expect(result.release).toBeDefined();
  });

  it('reports no update when already on latest', async () => {
    const deps = createDeps({
      fetchLatestRelease: vi.fn().mockResolvedValue(CURRENT_RELEASE),
    });

    const result = await checkForUpdate(deps);

    expect(result.updateAvailable).toBe(false);
    expect(result.currentVersion).toBe('0.1.0');
    expect(result.latestVersion).toBe('0.1.0');
  });

  it('reports no update when on newer version than release', async () => {
    const deps = createDeps({
      currentVersion: '0.3.0',
      fetchLatestRelease: vi.fn().mockResolvedValue(NEWER_RELEASE),
    });

    const result = await checkForUpdate(deps);

    expect(result.updateAvailable).toBe(false);
  });

  it('returns error when fetch fails', async () => {
    const deps = createDeps({
      fetchLatestRelease: vi.fn().mockRejectedValue(new Error('network error')),
    });

    const result = await checkForUpdate(deps);

    expect(result.updateAvailable).toBe(false);
    expect(result.error).toContain('network error');
  });

  it('strips v prefix from tag_name for version comparison', async () => {
    const deps = createDeps();

    const result = await checkForUpdate(deps);

    expect(result.latestVersion).toBe('0.2.0');
  });
});

// ---------------------------------------------------------------------------
// runUpdate
// ---------------------------------------------------------------------------

describe('runUpdate', () => {
  it('returns 0 when already on latest version', async () => {
    const deps = createDeps({
      fetchLatestRelease: vi.fn().mockResolvedValue(CURRENT_RELEASE),
    });

    const code = await runUpdate(deps);

    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('already'));
  });

  it('returns 0 on successful update', async () => {
    const deps = createDeps();

    const code = await runUpdate(deps);

    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('0.2.0'));
  });

  it('downloads the platform-specific tarball', async () => {
    const deps = createDeps();

    await runUpdate(deps);

    expect(deps.downloadFile).toHaveBeenCalledWith(
      expect.stringContaining('carapace-host-darwin-arm64.tar.gz'),
      expect.any(String),
    );
  });

  it('downloads and verifies checksum file', async () => {
    const deps = createDeps();

    await runUpdate(deps);

    // Downloads checksum file
    expect(deps.downloadFile).toHaveBeenCalledWith(
      expect.stringContaining('.sha256'),
      expect.any(String),
    );
    // Verifies tarball against checksum
    expect(deps.verifySha256).toHaveBeenCalled();
  });

  it('aborts if checksum verification fails', async () => {
    const deps = createDeps({
      verifySha256: vi.fn().mockReturnValue({
        status: 'fail',
        detail: 'Checksum mismatch',
        fix: 'Re-download',
      }),
    });

    const code = await runUpdate(deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('checksum'));
    // Should NOT have extracted or renamed
    expect(deps.extractTarball).not.toHaveBeenCalled();
    expect(deps.rename).not.toHaveBeenCalled();
  });

  it('pulls the matching container image', async () => {
    const deps = createDeps();

    await runUpdate(deps);

    expect(deps.pullImage).toHaveBeenCalled();
  });

  it('updates pinned image digest in config', async () => {
    const deps = createDeps();

    await runUpdate(deps);

    expect(deps.writeConfigFile).toHaveBeenCalledWith(expect.stringContaining(VALID_DIGEST));
  });

  it('extracts tarball to staging directory', async () => {
    const deps = createDeps();

    await runUpdate(deps);

    expect(deps.extractTarball).toHaveBeenCalled();
  });

  it('atomically replaces current install', async () => {
    const deps = createDeps();

    await runUpdate(deps);

    // rename is used for atomic swap
    expect(deps.rename).toHaveBeenCalled();
  });

  it('cleans up staging directory', async () => {
    const deps = createDeps();

    await runUpdate(deps);

    expect(deps.removeDir).toHaveBeenCalled();
  });

  it('runs carapace doctor post-update', async () => {
    const deps = createDeps();

    await runUpdate(deps);

    expect(deps.runDoctor).toHaveBeenCalled();
  });

  it('aborts if user denies confirmation', async () => {
    const deps = createDeps({
      confirm: vi.fn().mockResolvedValue(false),
    });

    const code = await runUpdate(deps);

    expect(code).toBe(0);
    expect(deps.downloadFile).not.toHaveBeenCalled();
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
  });

  it('returns 1 when release fetch fails', async () => {
    const deps = createDeps({
      fetchLatestRelease: vi.fn().mockRejectedValue(new Error('network error')),
    });

    const code = await runUpdate(deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('network error'));
  });

  it('returns 1 when no matching asset for platform', async () => {
    const deps = createDeps({
      platform: 'freebsd',
      arch: 'mips',
    });

    const code = await runUpdate(deps);

    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('No release artifact'));
  });

  it('leaves current install intact on download failure', async () => {
    const deps = createDeps({
      downloadFile: vi.fn().mockRejectedValue(new Error('download failed')),
    });

    const code = await runUpdate(deps);

    expect(code).toBe(1);
    expect(deps.rename).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('download failed'));
  });

  it('leaves current install intact on image pull failure', async () => {
    const deps = createDeps({
      pullImage: vi.fn().mockRejectedValue(new Error('pull failed')),
    });

    const code = await runUpdate(deps);

    expect(code).toBe(1);
    expect(deps.rename).not.toHaveBeenCalled();
  });

  it('leaves current install intact on extract failure', async () => {
    const deps = createDeps({
      extractTarball: vi.fn().mockRejectedValue(new Error('extract failed')),
    });

    const code = await runUpdate(deps);

    expect(code).toBe(1);
    expect(deps.rename).not.toHaveBeenCalled();
  });

  it('writes updated version file', async () => {
    const deps = createDeps();

    await runUpdate(deps);

    expect(deps.writeFile).toHaveBeenCalledWith(expect.stringContaining('version'), '0.2.0\n');
  });

  it('reports doctor status after update', async () => {
    const deps = createDeps({
      runDoctor: vi.fn().mockResolvedValue(1),
    });

    // Update itself succeeds even if doctor finds warnings
    const code = await runUpdate(deps);

    expect(code).toBe(0);
    expect(deps.runDoctor).toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('doctor'));
  });

  it('skips confirmation with --yes flag', async () => {
    const deps = createDeps();

    const code = await runUpdate(deps, { yes: true });

    expect(code).toBe(0);
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it('shows release notes in check mode', async () => {
    const deps = createDeps();

    const code = await runUpdate(deps, { check: true });

    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('0.2.0'));
    // Should NOT download or install
    expect(deps.downloadFile).not.toHaveBeenCalled();
  });

  it('check mode reports no update available', async () => {
    const deps = createDeps({
      fetchLatestRelease: vi.fn().mockResolvedValue(CURRENT_RELEASE),
    });

    const code = await runUpdate(deps, { check: true });

    expect(code).toBe(0);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('already'));
  });

  describe('image build integration', () => {
    it('calls buildImage during update', async () => {
      const buildImage = vi.fn().mockResolvedValue({
        tag: 'carapace:2.1.49-abc1234',
        gitSha: 'abc1234',
        claudeVersion: '2.1.49',
        carapaceVersion: '0.1.0',
        buildDate: '2026-02-20T00:00:00Z',
      });
      const deps = createDeps({
        buildImage,
        projectRoot: '/path/to/project',
      });

      await runUpdate(deps, { yes: true });

      expect(buildImage).toHaveBeenCalledWith('/path/to/project');
      expect(deps.stdout).toHaveBeenCalledWith(
        expect.stringContaining('Image built: carapace:2.1.49-abc1234'),
      );
    });

    it('aborts update when buildImage fails', async () => {
      const buildImage = vi.fn().mockRejectedValue(new Error('build failed'));
      const deps = createDeps({
        buildImage,
        projectRoot: '/path/to/project',
      });

      const code = await runUpdate(deps, { yes: true });

      expect(code).toBe(1);
      expect(deps.stderr).toHaveBeenCalledWith(
        expect.stringContaining('Image build failed: build failed'),
      );
      // Should NOT have extracted or swapped install
      expect(deps.extractTarball).not.toHaveBeenCalled();
      expect(deps.rename).not.toHaveBeenCalled();
    });

    it('skips image build when buildImage is not configured', async () => {
      const deps = createDeps();
      // No buildImage or projectRoot in deps

      const code = await runUpdate(deps, { yes: true });

      // Should succeed without any build step
      expect(code).toBe(0);
      expect(deps.stdout).not.toHaveBeenCalledWith(
        expect.stringContaining('Building container image'),
      );
    });

    it('skips image build when projectRoot is not configured', async () => {
      const buildImage = vi.fn();
      const deps = createDeps({
        buildImage,
        // No projectRoot
      });

      const code = await runUpdate(deps, { yes: true });

      expect(code).toBe(0);
      expect(buildImage).not.toHaveBeenCalled();
    });
  });
});
