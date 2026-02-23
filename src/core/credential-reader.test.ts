/**
 * Tests for the credential reader.
 *
 * Covers:
 * - API key only → returns ANTHROPIC_API_KEY stdin data
 * - Neither present → returns null
 * - Empty files → treated as absent
 * - Whitespace trimming
 * - prepareOAuthCredentials: copy, atomic write, permissions, edge cases
 */

import { describe, it, expect, vi } from 'vitest';
import {
  readCredentialStdin,
  prepareOAuthCredentials,
  API_KEY_FILENAME,
  OAUTH_CREDENTIALS_FILENAME,
  API_KEY_ENV_VAR,
  type CredentialFs,
  type CredentialPrepareFs,
} from './credential-reader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFs(files: Record<string, string>): CredentialFs {
  return {
    existsSync: vi.fn((path: string) => path in files),
    readFileSync: vi.fn((path: string) => {
      if (path in files) return files[path];
      throw new Error(`ENOENT: ${path}`);
    }),
  };
}

function createMockPrepareFs(files: Record<string, string>): CredentialPrepareFs {
  return {
    existsSync: vi.fn((path: string) => path in files),
    readFileSync: vi.fn((path: string) => {
      if (path in files) return files[path];
      throw new Error(`ENOENT: ${path}`);
    }),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
  };
}

const CREDS_DIR = '/home/carapace/credentials';
const CLAUDE_STATE = '/home/carapace/data/claude-state/default';

// ---------------------------------------------------------------------------
// readCredentialStdin tests
// ---------------------------------------------------------------------------

describe('readCredentialStdin', () => {
  it('returns ANTHROPIC_API_KEY when API key file exists', () => {
    const fs = createMockFs({
      [`${CREDS_DIR}/${API_KEY_FILENAME}`]: 'sk-ant-api03-test-key',
    });

    const result = readCredentialStdin(CREDS_DIR, fs);

    expect(result).toBe(`${API_KEY_ENV_VAR}=sk-ant-api03-test-key\n\n`);
  });

  it('returns null when no API key file exists (OAuth not handled here)', () => {
    const fs = createMockFs({});

    const result = readCredentialStdin(CREDS_DIR, fs);

    expect(result).toBeNull();
  });

  it('returns null when only OAuth credentials file exists', () => {
    const fs = createMockFs({
      [`${CREDS_DIR}/${OAUTH_CREDENTIALS_FILENAME}`]: '{"accessToken":"abc"}',
    });

    const result = readCredentialStdin(CREDS_DIR, fs);

    expect(result).toBeNull();
  });

  it('treats empty API key file as absent', () => {
    const fs = createMockFs({
      [`${CREDS_DIR}/${API_KEY_FILENAME}`]: '',
    });

    const result = readCredentialStdin(CREDS_DIR, fs);

    expect(result).toBeNull();
  });

  it('treats whitespace-only API key file as absent', () => {
    const fs = createMockFs({
      [`${CREDS_DIR}/${API_KEY_FILENAME}`]: '  \n  ',
    });

    const result = readCredentialStdin(CREDS_DIR, fs);

    expect(result).toBeNull();
  });

  it('trims whitespace from credential values', () => {
    const fs = createMockFs({
      [`${CREDS_DIR}/${API_KEY_FILENAME}`]: '  sk-ant-api03-key  \n',
    });

    const result = readCredentialStdin(CREDS_DIR, fs);

    expect(result).toBe(`${API_KEY_ENV_VAR}=sk-ant-api03-key\n\n`);
  });

  it('formats stdin data with empty line terminator', () => {
    const fs = createMockFs({
      [`${CREDS_DIR}/${API_KEY_FILENAME}`]: 'sk-ant-api03-key',
    });

    const result = readCredentialStdin(CREDS_DIR, fs);

    // Must end with \n\n (empty line signals end of credentials to entrypoint)
    expect(result).toMatch(/\n\n$/);
  });
});

// ---------------------------------------------------------------------------
// prepareOAuthCredentials tests
// ---------------------------------------------------------------------------

describe('prepareOAuthCredentials', () => {
  it('copies credentials when source exists and returns true', () => {
    const credContent = '{"accessToken":"abc","refreshToken":"xyz","expiresAt":"2026-03-01"}';
    const fs = createMockPrepareFs({
      [`${CREDS_DIR}/${OAUTH_CREDENTIALS_FILENAME}`]: credContent,
    });

    const result = prepareOAuthCredentials(CREDS_DIR, CLAUDE_STATE, fs);

    expect(result).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      `${CLAUDE_STATE}/.credentials.json.tmp`,
      credContent,
      { mode: 0o600 },
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      `${CLAUDE_STATE}/.credentials.json.tmp`,
      `${CLAUDE_STATE}/.credentials.json`,
    );
  });

  it('returns false when source file does not exist', () => {
    const fs = createMockPrepareFs({});

    const result = prepareOAuthCredentials(CREDS_DIR, CLAUDE_STATE, fs);

    expect(result).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it('performs atomic write via temp file + rename', () => {
    const credContent = '{"accessToken":"test"}';
    const fs = createMockPrepareFs({
      [`${CREDS_DIR}/${OAUTH_CREDENTIALS_FILENAME}`]: credContent,
    });

    prepareOAuthCredentials(CREDS_DIR, CLAUDE_STATE, fs);

    // writeFileSync is called first with .tmp suffix
    const writeCall = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(writeCall[0]).toContain('.tmp');

    // Then renamed to final path
    const renameCall = (fs.renameSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(renameCall[0]).toContain('.tmp');
    expect(renameCall[1]).toBe(`${CLAUDE_STATE}/.credentials.json`);
  });

  it('sets 0600 permissions on the written file', () => {
    const fs = createMockPrepareFs({
      [`${CREDS_DIR}/${OAUTH_CREDENTIALS_FILENAME}`]: '{"accessToken":"test"}',
    });

    prepareOAuthCredentials(CREDS_DIR, CLAUDE_STATE, fs);

    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      mode: 0o600,
    });
  });

  it('returns false when source file is empty', () => {
    const fs = createMockPrepareFs({
      [`${CREDS_DIR}/${OAUTH_CREDENTIALS_FILENAME}`]: '',
    });

    const result = prepareOAuthCredentials(CREDS_DIR, CLAUDE_STATE, fs);

    expect(result).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('returns false when source file is whitespace-only', () => {
    const fs = createMockPrepareFs({
      [`${CREDS_DIR}/${OAUTH_CREDENTIALS_FILENAME}`]: '  \n  ',
    });

    const result = prepareOAuthCredentials(CREDS_DIR, CLAUDE_STATE, fs);

    expect(result).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
