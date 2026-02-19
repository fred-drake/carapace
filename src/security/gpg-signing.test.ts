import { describe, it, expect, vi } from 'vitest';
import {
  signFileGpg,
  verifyGpgSignature,
  exportPublicKey,
  isGpgAvailable,
  type GpgDeps,
  type GpgSignResult,
  type GpgVerifyResult,
} from './gpg-signing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeps(overrides?: Partial<GpgDeps>): GpgDeps {
  return {
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    fileExists: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// signFileGpg
// ---------------------------------------------------------------------------

describe('signFileGpg', () => {
  it('calls gpg with --detach-sign and --armor flags', async () => {
    const deps = createDeps();
    await signFileGpg('/path/to/release.tar.gz', 'release-key@carapace.dev', deps);

    expect(deps.exec).toHaveBeenCalledWith(
      'gpg',
      expect.arrayContaining([
        '--detach-sign',
        '--armor',
        '--local-user',
        'release-key@carapace.dev',
        '/path/to/release.tar.gz',
      ]),
    );
  });

  it('returns success with signature path on exit 0', async () => {
    const deps = createDeps();
    const result = await signFileGpg('/path/to/release.tar.gz', 'key@test', deps);

    expect(result.status).toBe('pass');
    expect(result.signaturePath).toBe('/path/to/release.tar.gz.asc');
  });

  it('returns failure when gpg returns non-zero', async () => {
    const deps = createDeps({
      exec: vi.fn().mockResolvedValue({
        exitCode: 2,
        stdout: '',
        stderr: 'gpg: signing failed: No secret key',
      }),
    });
    const result = await signFileGpg('/path/to/release.tar.gz', 'key@test', deps);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/signing failed|secret key/i);
  });

  it('returns failure when gpg binary not found', async () => {
    const err = new Error('spawn gpg ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const deps = createDeps({
      exec: vi.fn().mockRejectedValue(err),
    });
    const result = await signFileGpg('/path/to/release.tar.gz', 'key@test', deps);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/gpg.*not found/i);
    expect(result.fix).toBeDefined();
  });

  it('returns failure when source file does not exist', async () => {
    const deps = createDeps({
      fileExists: vi.fn().mockReturnValue(false),
    });
    const result = await signFileGpg('/missing/file.tar.gz', 'key@test', deps);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/not found|missing/i);
  });

  it('uses --batch flag for non-interactive signing', async () => {
    const deps = createDeps();
    await signFileGpg('/path/to/file.tar.gz', 'key@test', deps);

    expect(deps.exec).toHaveBeenCalledWith('gpg', expect.arrayContaining(['--batch']));
  });
});

// ---------------------------------------------------------------------------
// verifyGpgSignature
// ---------------------------------------------------------------------------

describe('verifyGpgSignature', () => {
  it('calls gpg --verify with signature and file paths', async () => {
    const deps = createDeps();
    await verifyGpgSignature('/path/to/file.tar.gz', '/path/to/file.tar.gz.asc', deps);

    expect(deps.exec).toHaveBeenCalledWith(
      'gpg',
      expect.arrayContaining(['--verify', '/path/to/file.tar.gz.asc', '/path/to/file.tar.gz']),
    );
  });

  it('returns pass when gpg exits 0', async () => {
    const deps = createDeps({
      exec: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: 'gpg: Good signature from "Carapace Release <release@carapace.dev>"',
      }),
    });
    const result = await verifyGpgSignature('/path/file.tar.gz', '/path/file.tar.gz.asc', deps);

    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/verified|good signature/i);
  });

  it('returns fail when signature is bad', async () => {
    const deps = createDeps({
      exec: vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'gpg: BAD signature from "unknown"',
      }),
    });
    const result = await verifyGpgSignature('/path/file.tar.gz', '/path/file.tar.gz.asc', deps);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/bad signature|verification failed/i);
  });

  it('returns warn when gpg is not installed', async () => {
    const err = new Error('spawn gpg ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const deps = createDeps({
      exec: vi.fn().mockRejectedValue(err),
    });
    const result = await verifyGpgSignature('/path/file.tar.gz', '/path/file.tar.gz.asc', deps);

    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/gpg.*not found/i);
    expect(result.fix).toMatch(/install gpg/i);
  });

  it('returns fail when signature file does not exist', async () => {
    const deps = createDeps({
      fileExists: vi.fn().mockImplementation((p: string) => !p.endsWith('.asc')),
    });
    const result = await verifyGpgSignature('/path/file.tar.gz', '/path/file.tar.gz.asc', deps);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/signature.*not found/i);
  });

  it('returns fail when file to verify does not exist', async () => {
    const deps = createDeps({
      fileExists: vi.fn().mockImplementation((p: string) => p.endsWith('.asc')),
    });
    const result = await verifyGpgSignature('/missing/file.tar.gz', '/path/file.tar.gz.asc', deps);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/file.*not found/i);
  });

  it('uses --batch flag for non-interactive verification', async () => {
    const deps = createDeps();
    await verifyGpgSignature('/path/file.tar.gz', '/path/file.tar.gz.asc', deps);

    expect(deps.exec).toHaveBeenCalledWith('gpg', expect.arrayContaining(['--batch']));
  });
});

// ---------------------------------------------------------------------------
// exportPublicKey
// ---------------------------------------------------------------------------

describe('exportPublicKey', () => {
  it('calls gpg --export --armor with key ID', async () => {
    const deps = createDeps({
      exec: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout:
          '-----BEGIN PGP PUBLIC KEY BLOCK-----\nkey-data\n-----END PGP PUBLIC KEY BLOCK-----',
        stderr: '',
      }),
    });
    await exportPublicKey('release-key@carapace.dev', deps);

    expect(deps.exec).toHaveBeenCalledWith(
      'gpg',
      expect.arrayContaining(['--export', '--armor', 'release-key@carapace.dev']),
    );
  });

  it('returns the public key on success', async () => {
    const keyBlock =
      '-----BEGIN PGP PUBLIC KEY BLOCK-----\ndata\n-----END PGP PUBLIC KEY BLOCK-----';
    const deps = createDeps({
      exec: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: keyBlock,
        stderr: '',
      }),
    });
    const result = await exportPublicKey('key@test', deps);

    expect(result.status).toBe('pass');
    expect(result.publicKey).toBe(keyBlock);
  });

  it('returns failure when key not found', async () => {
    const deps = createDeps({
      exec: vi.fn().mockResolvedValue({
        exitCode: 2,
        stdout: '',
        stderr: 'gpg: WARNING: nothing exported',
      }),
    });
    const result = await exportPublicKey('unknown@test', deps);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/not found|nothing exported/i);
  });

  it('returns failure when gpg binary not found', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const deps = createDeps({
      exec: vi.fn().mockRejectedValue(err),
    });
    const result = await exportPublicKey('key@test', deps);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/gpg.*not found/i);
  });

  it('returns failure when exported key is empty', async () => {
    const deps = createDeps({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    });
    const result = await exportPublicKey('key@test', deps);

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/empty|no key/i);
  });
});

// ---------------------------------------------------------------------------
// isGpgAvailable
// ---------------------------------------------------------------------------

describe('isGpgAvailable', () => {
  it('returns true when gpg --version succeeds', async () => {
    const deps = createDeps({
      exec: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'gpg (GnuPG) 2.4.3',
        stderr: '',
      }),
    });
    const result = await isGpgAvailable(deps);

    expect(result).toBe(true);
  });

  it('returns false when gpg binary not found', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const deps = createDeps({
      exec: vi.fn().mockRejectedValue(err),
    });
    const result = await isGpgAvailable(deps);

    expect(result).toBe(false);
  });

  it('returns false when gpg returns non-zero', async () => {
    const deps = createDeps({
      exec: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'error' }),
    });
    const result = await isGpgAvailable(deps);

    expect(result).toBe(false);
  });
});
