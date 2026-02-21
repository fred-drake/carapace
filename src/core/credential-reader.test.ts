/**
 * Tests for the credential reader.
 *
 * Covers:
 * - API key only → returns ANTHROPIC_API_KEY stdin data
 * - OAuth token only → returns CLAUDE_CODE_OAUTH_TOKEN stdin data
 * - Both present → API key takes precedence
 * - Neither present → returns null
 * - Empty files → treated as absent
 * - Whitespace trimming
 */

import { describe, it, expect, vi } from 'vitest';
import {
  readCredentialStdin,
  API_KEY_FILENAME,
  OAUTH_TOKEN_FILENAME,
  API_KEY_ENV_VAR,
  OAUTH_TOKEN_ENV_VAR,
  type CredentialFs,
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

const CREDS_DIR = '/home/carapace/credentials';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('readCredentialStdin', () => {
  it('returns ANTHROPIC_API_KEY when only API key file exists', () => {
    const fs = createMockFs({
      [`${CREDS_DIR}/${API_KEY_FILENAME}`]: 'sk-ant-api03-test-key',
    });

    const result = readCredentialStdin(CREDS_DIR, fs);

    expect(result).toBe(`${API_KEY_ENV_VAR}=sk-ant-api03-test-key\n\n`);
  });

  it('returns CLAUDE_CODE_OAUTH_TOKEN when only OAuth token file exists', () => {
    const fs = createMockFs({
      [`${CREDS_DIR}/${OAUTH_TOKEN_FILENAME}`]: 'oauth-token-value-123',
    });

    const result = readCredentialStdin(CREDS_DIR, fs);

    expect(result).toBe(`${OAUTH_TOKEN_ENV_VAR}=oauth-token-value-123\n\n`);
  });

  it('API key takes precedence when both credentials exist', () => {
    const fs = createMockFs({
      [`${CREDS_DIR}/${API_KEY_FILENAME}`]: 'sk-ant-api03-key',
      [`${CREDS_DIR}/${OAUTH_TOKEN_FILENAME}`]: 'oauth-token',
    });

    const result = readCredentialStdin(CREDS_DIR, fs);

    expect(result).toBe(`${API_KEY_ENV_VAR}=sk-ant-api03-key\n\n`);
    // OAuth file should not even be read
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('returns null when no credential files exist', () => {
    const fs = createMockFs({});

    const result = readCredentialStdin(CREDS_DIR, fs);

    expect(result).toBeNull();
  });

  it('treats empty API key file as absent (falls through to OAuth)', () => {
    const fs = createMockFs({
      [`${CREDS_DIR}/${API_KEY_FILENAME}`]: '',
      [`${CREDS_DIR}/${OAUTH_TOKEN_FILENAME}`]: 'oauth-token',
    });

    const result = readCredentialStdin(CREDS_DIR, fs);

    expect(result).toBe(`${OAUTH_TOKEN_ENV_VAR}=oauth-token\n\n`);
  });

  it('treats whitespace-only API key file as absent', () => {
    const fs = createMockFs({
      [`${CREDS_DIR}/${API_KEY_FILENAME}`]: '  \n  ',
      [`${CREDS_DIR}/${OAUTH_TOKEN_FILENAME}`]: 'oauth-token',
    });

    const result = readCredentialStdin(CREDS_DIR, fs);

    expect(result).toBe(`${OAUTH_TOKEN_ENV_VAR}=oauth-token\n\n`);
  });

  it('returns null when both files are empty', () => {
    const fs = createMockFs({
      [`${CREDS_DIR}/${API_KEY_FILENAME}`]: '',
      [`${CREDS_DIR}/${OAUTH_TOKEN_FILENAME}`]: '',
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
