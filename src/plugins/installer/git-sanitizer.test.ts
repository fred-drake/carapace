import { describe, it, expect, vi } from 'vitest';
import { sanitizeClonedRepo, RealSanitizerFs } from './git-sanitizer.js';
import type { SanitizerFs, SanitizerGit } from './git-sanitizer.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * A mock filesystem where the caller defines exactly which paths exist
 * and what they contain. Paths are normalized for consistent lookup.
 */
function createMockFs(opts: {
  /** Map of directory path → entries returned by readdir */
  directories?: Map<string, string[]>;
  /** Set of paths that exist (for access checks) */
  existingPaths?: Set<string>;
  /** Set of paths that are symlinks */
  symlinks?: Set<string>;
  /** Set of paths that are directories (for recursive walk) */
  directoryPaths?: Set<string>;
}): SanitizerFs {
  const directories = opts.directories ?? new Map<string, string[]>();
  const existingPaths = opts.existingPaths ?? new Set<string>();
  const symlinks = opts.symlinks ?? new Set<string>();
  const directoryPaths = opts.directoryPaths ?? new Set<string>();

  return {
    readdir: vi.fn(async (dir: string): Promise<string[]> => {
      const entries = directories.get(dir);
      if (entries === undefined) {
        throw new Error(`ENOENT: no such directory: ${dir}`);
      }
      return entries;
    }),

    unlink: vi.fn(async (_path: string): Promise<void> => {
      // no-op in mock
    }),

    access: vi.fn(async (filePath: string): Promise<boolean> => {
      return existingPaths.has(filePath);
    }),

    lstat: vi.fn(async (filePath: string): Promise<{ isSymbolicLink(): boolean }> => {
      const isSymlink = symlinks.has(filePath);
      // If not a symlink and is a directory path, readdir will succeed
      // If not a symlink and not a directory, readdir will throw (file)
      if (!isSymlink && directoryPaths.has(filePath)) {
        return { isSymbolicLink: () => false };
      }
      return { isSymbolicLink: () => isSymlink };
    }),
  };
}

/**
 * Create a mock git implementation with a given config map.
 */
function createMockGit(configEntries?: Map<string, string>): SanitizerGit {
  const config = configEntries ?? new Map<string, string>();

  return {
    configList: vi.fn(async (_repoDir: string): Promise<Map<string, string>> => {
      return new Map(config);
    }),
    configUnset: vi.fn(async (_repoDir: string, _key: string): Promise<void> => {
      // no-op in mock
    }),
  };
}

const REPO_DIR = '/tmp/test-repo';

// ---------------------------------------------------------------------------
// sanitizeClonedRepo
// ---------------------------------------------------------------------------

describe('sanitizeClonedRepo', () => {
  // -------------------------------------------------------------------------
  // Phase 1: Remove hooks
  // -------------------------------------------------------------------------

  describe('Phase 1: Remove hooks', () => {
    it('removes all files from .git/hooks/', async () => {
      const mockFs = createMockFs({
        directories: new Map([
          ['/tmp/test-repo/.git/hooks', ['pre-commit', 'post-merge', 'pre-push']],
          ['/tmp/test-repo', ['.git', 'src']],
          ['/tmp/test-repo/src', []],
        ]),
        directoryPaths: new Set(['/tmp/test-repo/src']),
      });
      const mockGit = createMockGit();

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.hooksRemoved).toBe(3);
      expect(mockFs.unlink).toHaveBeenCalledTimes(3);
      expect(mockFs.unlink).toHaveBeenCalledWith('/tmp/test-repo/.git/hooks/pre-commit');
      expect(mockFs.unlink).toHaveBeenCalledWith('/tmp/test-repo/.git/hooks/post-merge');
      expect(mockFs.unlink).toHaveBeenCalledWith('/tmp/test-repo/.git/hooks/pre-push');
    });

    it('handles missing hooks directory without error', async () => {
      // No .git/hooks entry in directories → readdir will throw ENOENT
      const mockFs = createMockFs({
        directories: new Map([
          ['/tmp/test-repo', ['.git', 'src']],
          ['/tmp/test-repo/src', []],
        ]),
        directoryPaths: new Set(['/tmp/test-repo/src']),
      });
      const mockGit = createMockGit();

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.hooksRemoved).toBe(0);
      expect(mockFs.unlink).not.toHaveBeenCalled();
    });

    it('handles empty hooks directory', async () => {
      const mockFs = createMockFs({
        directories: new Map([
          ['/tmp/test-repo/.git/hooks', []],
          ['/tmp/test-repo', ['.git', 'src']],
          ['/tmp/test-repo/src', []],
        ]),
        directoryPaths: new Set(['/tmp/test-repo/src']),
      });
      const mockGit = createMockGit();

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.hooksRemoved).toBe(0);
      expect(mockFs.unlink).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2: Scan git config
  // -------------------------------------------------------------------------

  describe('Phase 2: Strip dangerous config', () => {
    it('removes core.fsmonitor', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(
        new Map([
          ['core.fsmonitor', 'true'],
          ['user.name', 'Test User'],
        ]),
      );

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toContain('core.fsmonitor');
      expect(result.configKeysStripped).not.toContain('user.name');
      expect(mockGit.configUnset).toHaveBeenCalledWith(REPO_DIR, 'core.fsmonitor');
      expect(mockGit.configUnset).toHaveBeenCalledTimes(1);
    });

    it('removes core.hooksPath', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(new Map([['core.hooksPath', '/evil/hooks']]));

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toContain('core.hooksPath');
    });

    it('removes core.sshCommand', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(new Map([['core.sshCommand', 'evil-ssh']]));

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toContain('core.sshCommand');
    });

    it('removes core.pager', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(new Map([['core.pager', 'evil-pager']]));

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toContain('core.pager');
    });

    it('removes core.editor', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(new Map([['core.editor', 'evil-editor']]));

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toContain('core.editor');
    });

    it('removes diff.external', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(new Map([['diff.external', '/usr/bin/evil-diff']]));

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toContain('diff.external');
    });

    it('removes credential.helper', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(new Map([['credential.helper', 'store']]));

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toContain('credential.helper');
    });

    it('removes filter.lfs.clean (wildcard subsection match)', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(new Map([['filter.lfs.clean', 'git-lfs clean -- %f']]));

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toContain('filter.lfs.clean');
    });

    it('removes filter.lfs.smudge (wildcard subsection match)', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(new Map([['filter.lfs.smudge', 'git-lfs smudge -- %f']]));

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toContain('filter.lfs.smudge');
    });

    it('removes filter.lfs.process (wildcard subsection match)', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(new Map([['filter.lfs.process', 'git-lfs filter-process']]));

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toContain('filter.lfs.process');
    });

    it('removes filter with arbitrary subsection names', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(
        new Map([
          ['filter.custom-filter.clean', 'my-clean'],
          ['filter.another.smudge', 'my-smudge'],
        ]),
      );

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toContain('filter.custom-filter.clean');
      expect(result.configKeysStripped).toContain('filter.another.smudge');
    });

    it('does NOT remove filter.lfs.required (non-dangerous leaf key)', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(new Map([['filter.lfs.required', 'true']]));

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).not.toContain('filter.lfs.required');
      expect(mockGit.configUnset).not.toHaveBeenCalled();
    });

    it('preserves safe config keys', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const safeKeys = new Map([
        ['user.name', 'Test User'],
        ['user.email', 'test@example.com'],
        ['remote.origin.url', 'https://github.com/user/repo.git'],
        ['core.bare', 'false'],
        ['core.logallrefupdates', 'true'],
        ['branch.main.remote', 'origin'],
      ]);
      const mockGit = createMockGit(safeKeys);

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toHaveLength(0);
      expect(mockGit.configUnset).not.toHaveBeenCalled();
    });

    it('strips multiple dangerous keys in one pass', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(
        new Map([
          ['core.fsmonitor', 'true'],
          ['core.hooksPath', '/evil'],
          ['diff.external', 'evil-diff'],
          ['filter.lfs.clean', 'git-lfs clean'],
          ['user.name', 'Safe User'],
        ]),
      );

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toHaveLength(4);
      expect(result.configKeysStripped).toContain('core.fsmonitor');
      expect(result.configKeysStripped).toContain('core.hooksPath');
      expect(result.configKeysStripped).toContain('diff.external');
      expect(result.configKeysStripped).toContain('filter.lfs.clean');
    });

    it('handles config key matching case-insensitively', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit(new Map([['Core.FsMonitor', 'true']]));

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.configKeysStripped).toContain('Core.FsMonitor');
    });
  });

  // -------------------------------------------------------------------------
  // Phase 3: Reject .gitmodules
  // -------------------------------------------------------------------------

  describe('Phase 3: Reject .gitmodules', () => {
    it('rejects repo when .gitmodules exists', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
        existingPaths: new Set(['/tmp/test-repo/.gitmodules']),
      });
      const mockGit = createMockGit();

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.rejected).toBe(true);
      expect(result.rejectionReasons).toContain(
        'Repository contains .gitmodules (submodules not allowed)',
      );
    });

    it('does not reject when .gitmodules is absent', async () => {
      const mockFs = createMockFs({
        directories: new Map([['/tmp/test-repo', ['.git']]]),
      });
      const mockGit = createMockGit();

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.rejected).toBe(false);
      expect(result.rejectionReasons).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 4: Scan for symlinks
  // -------------------------------------------------------------------------

  describe('Phase 4: Scan for symlinks', () => {
    it('rejects repo when symlinks are found in working tree', async () => {
      const mockFs = createMockFs({
        directories: new Map([
          ['/tmp/test-repo', ['.git', 'src', 'link.txt']],
          ['/tmp/test-repo/src', []],
        ]),
        directoryPaths: new Set(['/tmp/test-repo/src']),
        symlinks: new Set(['/tmp/test-repo/link.txt']),
      });
      const mockGit = createMockGit();

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.rejected).toBe(true);
      expect(result.rejectionReasons).toEqual(
        expect.arrayContaining([expect.stringContaining('symlinks')]),
      );
      expect(result.rejectionReasons[0]).toContain('link.txt');
    });

    it('detects symlinks in nested directories', async () => {
      const mockFs = createMockFs({
        directories: new Map([
          ['/tmp/test-repo', ['.git', 'src']],
          ['/tmp/test-repo/src', ['nested']],
          ['/tmp/test-repo/src/nested', ['evil-link']],
        ]),
        directoryPaths: new Set(['/tmp/test-repo/src', '/tmp/test-repo/src/nested']),
        symlinks: new Set(['/tmp/test-repo/src/nested/evil-link']),
      });
      const mockGit = createMockGit();

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.rejected).toBe(true);
      expect(result.rejectionReasons[0]).toContain('src/nested/evil-link');
    });

    it('excludes .git directory from symlink scan', async () => {
      // .git is listed in the root directory but should be skipped
      const mockFs = createMockFs({
        directories: new Map([
          ['/tmp/test-repo', ['.git', 'README.md']],
          // .git directory itself is NOT in the directories map — if it
          // were scanned, readdir would throw, but it shouldn't be scanned
        ]),
      });
      const mockGit = createMockGit();

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      // .git should not be traversed, and README.md is not a symlink
      expect(result.rejected).toBe(false);
    });

    it('passes clean repo with no symlinks', async () => {
      const mockFs = createMockFs({
        directories: new Map([
          ['/tmp/test-repo', ['.git', 'src', 'package.json']],
          ['/tmp/test-repo/src', ['index.ts']],
        ]),
        directoryPaths: new Set(['/tmp/test-repo/src']),
      });
      const mockGit = createMockGit();

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.rejected).toBe(false);
      expect(result.rejectionReasons).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple rejection reasons
  // -------------------------------------------------------------------------

  describe('multiple rejection reasons', () => {
    it('accumulates both .gitmodules and symlink rejections', async () => {
      const mockFs = createMockFs({
        directories: new Map([
          ['/tmp/test-repo', ['.git', 'src', 'evil-link']],
          ['/tmp/test-repo/src', []],
        ]),
        existingPaths: new Set(['/tmp/test-repo/.gitmodules']),
        directoryPaths: new Set(['/tmp/test-repo/src']),
        symlinks: new Set(['/tmp/test-repo/evil-link']),
      });
      const mockGit = createMockGit();

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.rejected).toBe(true);
      expect(result.rejectionReasons).toHaveLength(2);
      expect(result.rejectionReasons[0]).toContain('.gitmodules');
      expect(result.rejectionReasons[1]).toContain('symlinks');
    });
  });

  // -------------------------------------------------------------------------
  // Clean repo (all phases pass)
  // -------------------------------------------------------------------------

  describe('clean repo passes all phases', () => {
    it('returns clean result for a well-behaved repo', async () => {
      const mockFs = createMockFs({
        directories: new Map([
          ['/tmp/test-repo/.git/hooks', []],
          ['/tmp/test-repo', ['.git', 'src', 'package.json']],
          ['/tmp/test-repo/src', ['index.ts', 'lib']],
          ['/tmp/test-repo/src/lib', ['utils.ts']],
        ]),
        directoryPaths: new Set(['/tmp/test-repo/src', '/tmp/test-repo/src/lib']),
      });
      const mockGit = createMockGit(
        new Map([
          ['user.name', 'Test User'],
          ['user.email', 'test@example.com'],
          ['remote.origin.url', 'https://github.com/user/repo.git'],
        ]),
      );

      const result = await sanitizeClonedRepo(REPO_DIR, mockFs, mockGit);

      expect(result.hooksRemoved).toBe(0);
      expect(result.configKeysStripped).toHaveLength(0);
      expect(result.rejected).toBe(false);
      expect(result.rejectionReasons).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // RealSanitizerFs interface conformance
  // -------------------------------------------------------------------------

  describe('RealSanitizerFs', () => {
    it('satisfies the SanitizerFs interface', () => {
      const real: SanitizerFs = new RealSanitizerFs();

      expect(real.readdir).toBeTypeOf('function');
      expect(real.unlink).toBeTypeOf('function');
      expect(real.access).toBeTypeOf('function');
      expect(real.lstat).toBeTypeOf('function');
    });
  });
});
