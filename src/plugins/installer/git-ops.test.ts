import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateGitUrl, RealGitOps } from './git-ops.js';
import type { GitOps } from './git-ops.js';

// ---------------------------------------------------------------------------
// Mock child_process.execFile
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Import the mocked module to control its behavior
import { execFile as execFileCbMock } from 'node:child_process';

// Cast to access mock methods. execFile is used via promisify, so the
// callback-style mock must call the callback argument to resolve.
const mockExecFile = execFileCbMock as unknown as ReturnType<typeof vi.fn>;

/**
 * Helper: configure the mock to simulate a successful git command.
 */
function mockSuccess(stdout = '', stderr = ''): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout, stderr });
    },
  );
}

/**
 * Helper: configure the mock to simulate a failed git command.
 */
function mockFailure(stderr = 'fatal: error', killed = false): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error & { stderr?: string; killed?: boolean }) => void,
    ) => {
      const err = new Error('git failed') as Error & {
        stderr?: string;
        killed?: boolean;
      };
      err.stderr = stderr;
      err.killed = killed;
      cb(err);
    },
  );
}

// ---------------------------------------------------------------------------
// URL Validation
// ---------------------------------------------------------------------------

describe('validateGitUrl', () => {
  describe('accepted protocols', () => {
    it('accepts https:// URLs', () => {
      expect(() => validateGitUrl('https://github.com/user/repo.git')).not.toThrow();
    });

    it('accepts git@ URLs', () => {
      expect(() => validateGitUrl('git@github.com:user/repo.git')).not.toThrow();
    });
  });

  describe('rejected protocols', () => {
    it('rejects file:// URLs', () => {
      expect(() => validateGitUrl('file:///tmp/repo')).toThrow(
        /must use https:\/\/ or git@ protocol/,
      );
    });

    it('rejects http:// URLs', () => {
      expect(() => validateGitUrl('http://github.com/user/repo.git')).toThrow(
        /must use https:\/\/ or git@ protocol/,
      );
    });

    it('rejects ftp:// URLs', () => {
      expect(() => validateGitUrl('ftp://example.com/repo.git')).toThrow(
        /must use https:\/\/ or git@ protocol/,
      );
    });

    it('rejects empty string', () => {
      expect(() => validateGitUrl('')).toThrow(/non-empty string/);
    });

    it('rejects bare paths', () => {
      expect(() => validateGitUrl('/tmp/repo')).toThrow(/must use https:\/\/ or git@ protocol/);
    });
  });

  describe('shell metacharacter rejection', () => {
    it('rejects URLs with semicolons', () => {
      expect(() => validateGitUrl('https://example.com/repo;rm -rf /')).toThrow(
        /disallowed characters/,
      );
    });

    it('rejects URLs with pipe', () => {
      expect(() => validateGitUrl('https://example.com/repo|cat /etc/passwd')).toThrow(
        /disallowed characters/,
      );
    });

    it('rejects URLs with ampersand', () => {
      expect(() => validateGitUrl('https://example.com/repo&echo hi')).toThrow(
        /disallowed characters/,
      );
    });

    it('rejects URLs with dollar sign', () => {
      expect(() => validateGitUrl('https://example.com/$HOME')).toThrow(/disallowed characters/);
    });

    it('rejects URLs with backtick', () => {
      expect(() => validateGitUrl('https://example.com/`whoami`')).toThrow(/disallowed characters/);
    });

    it('rejects URLs with parentheses', () => {
      expect(() => validateGitUrl('https://example.com/repo()')).toThrow(/disallowed characters/);
    });

    it('rejects URLs with curly braces', () => {
      expect(() => validateGitUrl('https://example.com/repo{}')).toThrow(/disallowed characters/);
    });

    it('rejects URLs with newlines', () => {
      expect(() => validateGitUrl('https://example.com/repo\n--upload-pack=evil')).toThrow(
        /disallowed characters/,
      );
    });

    it('rejects URLs with carriage returns', () => {
      expect(() => validateGitUrl('https://example.com/repo\r--upload-pack=evil')).toThrow(
        /disallowed characters/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// RealGitOps
// ---------------------------------------------------------------------------

describe('RealGitOps', () => {
  let gitOps: RealGitOps;

  beforeEach(() => {
    vi.clearAllMocks();
    gitOps = new RealGitOps();
  });

  // -------------------------------------------------------------------------
  // clone
  // -------------------------------------------------------------------------

  describe('clone', () => {
    it('builds correct default arguments', async () => {
      mockSuccess();

      await gitOps.clone('https://github.com/user/repo.git', '/tmp/dest');

      expect(mockExecFile).toHaveBeenCalledOnce();
      const [cmd, args, opts] = mockExecFile.mock.calls[0] as [
        string,
        string[],
        Record<string, unknown>,
        unknown,
      ];

      expect(cmd).toBe('git');
      expect(args).toEqual([
        'clone',
        '--depth=1',
        '--config',
        'core.hooksPath=/dev/null',
        '--config',
        'core.symlinks=false',
        '--single-branch',
        'https://github.com/user/repo.git',
        '/tmp/dest',
      ]);
      // Clone runs without cwd (not a repo-scoped operation)
      expect(opts.cwd).toBeUndefined();
      expect(opts.timeout).toBe(60_000);
      expect(opts.maxBuffer).toBe(1024 * 1024);
    });

    it('includes --branch when specified', async () => {
      mockSuccess();

      await gitOps.clone('https://github.com/user/repo.git', '/tmp/dest', {
        branch: 'v1.0.0',
      });

      const [, args] = mockExecFile.mock.calls[0] as [string, string[]];
      expect(args).toContain('--branch');
      expect(args).toContain('v1.0.0');
    });

    it('respects custom depth', async () => {
      mockSuccess();

      await gitOps.clone('https://github.com/user/repo.git', '/tmp/dest', {
        depth: 5,
      });

      const [, args] = mockExecFile.mock.calls[0] as [string, string[]];
      expect(args).toContain('--depth=5');
      expect(args).not.toContain('--depth=1');
    });

    it('omits --single-branch when singleBranch is false', async () => {
      mockSuccess();

      await gitOps.clone('https://github.com/user/repo.git', '/tmp/dest', {
        singleBranch: false,
      });

      const [, args] = mockExecFile.mock.calls[0] as [string, string[]];
      expect(args).not.toContain('--single-branch');
    });

    it('validates the URL before cloning', async () => {
      mockSuccess();

      await expect(gitOps.clone('file:///tmp/evil', '/tmp/dest')).rejects.toThrow(
        /must use https:\/\/ or git@ protocol/,
      );

      // execFile should not have been called
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('rejects URLs with shell metacharacters', async () => {
      mockSuccess();

      await expect(gitOps.clone('https://example.com/repo;evil', '/tmp/dest')).rejects.toThrow(
        /disallowed characters/,
      );

      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // fetch
  // -------------------------------------------------------------------------

  describe('fetch', () => {
    it('calls git fetch in the repo directory', async () => {
      mockSuccess();

      await gitOps.fetch('/tmp/repo');

      const [cmd, args, opts] = mockExecFile.mock.calls[0] as [
        string,
        string[],
        Record<string, unknown>,
        unknown,
      ];

      expect(cmd).toBe('git');
      expect(args).toEqual(['fetch']);
      expect(opts.cwd).toBe('/tmp/repo');
    });
  });

  // -------------------------------------------------------------------------
  // checkout
  // -------------------------------------------------------------------------

  describe('checkout', () => {
    it('calls git checkout with the given ref', async () => {
      mockSuccess();

      await gitOps.checkout('/tmp/repo', 'abc1234');

      const [cmd, args, opts] = mockExecFile.mock.calls[0] as [
        string,
        string[],
        Record<string, unknown>,
        unknown,
      ];

      expect(cmd).toBe('git');
      expect(args).toEqual(['checkout', 'abc1234']);
      expect(opts.cwd).toBe('/tmp/repo');
    });
  });

  // -------------------------------------------------------------------------
  // getRemoteUrl
  // -------------------------------------------------------------------------

  describe('getRemoteUrl', () => {
    it('returns trimmed remote URL', async () => {
      mockSuccess('https://github.com/user/repo.git\n');

      const url = await gitOps.getRemoteUrl('/tmp/repo');

      expect(url).toBe('https://github.com/user/repo.git');

      const [, args] = mockExecFile.mock.calls[0] as [string, string[]];
      expect(args).toEqual(['remote', 'get-url', 'origin']);
    });
  });

  // -------------------------------------------------------------------------
  // getCurrentRef
  // -------------------------------------------------------------------------

  describe('getCurrentRef', () => {
    it('returns trimmed commit hash', async () => {
      mockSuccess('abc123def456\n');

      const ref = await gitOps.getCurrentRef('/tmp/repo');

      expect(ref).toBe('abc123def456');

      const [, args] = mockExecFile.mock.calls[0] as [string, string[]];
      expect(args).toEqual(['rev-parse', 'HEAD']);
    });
  });

  // -------------------------------------------------------------------------
  // getDefaultBranch
  // -------------------------------------------------------------------------

  describe('getDefaultBranch', () => {
    it('extracts branch name from symbolic ref output', async () => {
      mockSuccess('refs/remotes/origin/main\n');

      const branch = await gitOps.getDefaultBranch('/tmp/repo');

      expect(branch).toBe('main');

      const [, args] = mockExecFile.mock.calls[0] as [string, string[]];
      expect(args).toEqual(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    });

    it('handles master as default branch', async () => {
      mockSuccess('refs/remotes/origin/master\n');

      const branch = await gitOps.getDefaultBranch('/tmp/repo');

      expect(branch).toBe('master');
    });
  });

  // -------------------------------------------------------------------------
  // configUnset
  // -------------------------------------------------------------------------

  describe('configUnset', () => {
    it('calls git config --unset with the key', async () => {
      mockSuccess();

      await gitOps.configUnset('/tmp/repo', 'core.hooksPath');

      const [, args, opts] = mockExecFile.mock.calls[0] as [
        string,
        string[],
        Record<string, unknown>,
      ];

      expect(args).toEqual(['config', '--unset', 'core.hooksPath']);
      expect(opts.cwd).toBe('/tmp/repo');
    });
  });

  // -------------------------------------------------------------------------
  // configList
  // -------------------------------------------------------------------------

  describe('configList', () => {
    it('parses key=value lines into a Map', async () => {
      mockSuccess(
        [
          'core.bare=false',
          'core.logallrefupdates=true',
          'remote.origin.url=https://github.com/user/repo.git',
          '',
        ].join('\n'),
      );

      const config = await gitOps.configList('/tmp/repo');

      expect(config).toBeInstanceOf(Map);
      expect(config.size).toBe(3);
      expect(config.get('core.bare')).toBe('false');
      expect(config.get('core.logallrefupdates')).toBe('true');
      expect(config.get('remote.origin.url')).toBe('https://github.com/user/repo.git');
    });

    it('handles values containing equals signs', async () => {
      mockSuccess('section.key=value=with=equals\n');

      const config = await gitOps.configList('/tmp/repo');

      expect(config.get('section.key')).toBe('value=with=equals');
    });

    it('skips lines without equals signs', async () => {
      mockSuccess('valid.key=value\ninvalid-line\n');

      const config = await gitOps.configList('/tmp/repo');

      expect(config.size).toBe(1);
      expect(config.get('valid.key')).toBe('value');
    });

    it('returns empty Map for empty output', async () => {
      mockSuccess('');

      const config = await gitOps.configList('/tmp/repo');

      expect(config.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('throws descriptive error on non-zero exit code', async () => {
      mockFailure('fatal: repository not found');

      await expect(gitOps.fetch('/tmp/repo')).rejects.toThrow(/Git command failed: git fetch/);
      await expect(gitOps.fetch('/tmp/repo')).rejects.toThrow(/repository not found/);
    });

    it('throws timeout error when process is killed', async () => {
      mockFailure('', true);

      await expect(gitOps.fetch('/tmp/repo')).rejects.toThrow(/timed out after 60000ms/);
    });
  });

  // -------------------------------------------------------------------------
  // Interface conformance
  // -------------------------------------------------------------------------

  describe('interface conformance', () => {
    it('RealGitOps satisfies the GitOps interface', () => {
      const ops: GitOps = new RealGitOps();

      expect(ops.clone).toBeTypeOf('function');
      expect(ops.fetch).toBeTypeOf('function');
      expect(ops.checkout).toBeTypeOf('function');
      expect(ops.getRemoteUrl).toBeTypeOf('function');
      expect(ops.getCurrentRef).toBeTypeOf('function');
      expect(ops.getDefaultBranch).toBeTypeOf('function');
      expect(ops.configUnset).toBeTypeOf('function');
      expect(ops.configList).toBeTypeOf('function');
    });

    it('GitOps interface is mockable', () => {
      const mock: GitOps = {
        clone: vi.fn(async () => {}),
        fetch: vi.fn(async () => {}),
        checkout: vi.fn(async () => {}),
        getRemoteUrl: vi.fn(async (): Promise<string> => 'https://example.com/repo.git'),
        getCurrentRef: vi.fn(async (): Promise<string> => 'abc123'),
        getDefaultBranch: vi.fn(async (): Promise<string> => 'main'),
        configUnset: vi.fn(async () => {}),
        configList: vi.fn(async (): Promise<Map<string, string>> => new Map()),
      };

      expect(mock.clone).toBeDefined();
      expect(mock.fetch).toBeDefined();
    });
  });
});
