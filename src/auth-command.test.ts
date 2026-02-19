import { describe, it, expect, vi } from 'vitest';
import { runAuthApiKey, runAuthLogin, runAuthStatus, type AuthDeps } from './auth-command.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeps(overrides?: Partial<AuthDeps>): AuthDeps {
  return {
    stdout: vi.fn(),
    stderr: vi.fn(),
    home: '/home/user/.carapace',
    promptSecret: vi.fn().mockResolvedValue('sk-ant-api03-validkey1234567890'),
    promptString: vi.fn().mockResolvedValue('oauth-token-value'),
    validateApiKey: vi.fn().mockResolvedValue({ valid: true }),
    fileExists: vi.fn().mockReturnValue(false),
    readFile: vi.fn().mockReturnValue(''),
    writeFileSecure: vi.fn(),
    fileStat: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// auth api-key
// ---------------------------------------------------------------------------

describe('runAuthApiKey', () => {
  it('prompts for API key', async () => {
    const deps = createDeps();
    await runAuthApiKey(deps);
    expect(deps.promptSecret).toHaveBeenCalledWith(expect.stringContaining('API key'));
  });

  it('validates the API key', async () => {
    const deps = createDeps();
    await runAuthApiKey(deps);
    expect(deps.validateApiKey).toHaveBeenCalledWith('sk-ant-api03-validkey1234567890');
  });

  it('stores valid key with 0600 permissions', async () => {
    const deps = createDeps();
    await runAuthApiKey(deps);
    expect(deps.writeFileSecure).toHaveBeenCalledWith(
      '/home/user/.carapace/credentials/anthropic-api-key',
      'sk-ant-api03-validkey1234567890',
      0o600,
    );
  });

  it('reports success after storing', async () => {
    const deps = createDeps();
    const code = await runAuthApiKey(deps);
    expect(code).toBe(0);
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasSuccess = allCalls.some((c: string) => /stored|saved|configured/i.test(c));
    expect(hasSuccess).toBe(true);
  });

  it('rejects invalid API key', async () => {
    const deps = createDeps({
      validateApiKey: vi.fn().mockResolvedValue({ valid: false, error: 'Invalid API key' }),
    });
    const code = await runAuthApiKey(deps);
    expect(code).toBe(1);
    expect(deps.writeFileSecure).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Invalid'));
  });

  it('rejects empty input', async () => {
    const deps = createDeps({
      promptSecret: vi.fn().mockResolvedValue(''),
    });
    const code = await runAuthApiKey(deps);
    expect(code).toBe(1);
    expect(deps.writeFileSecure).not.toHaveBeenCalled();
  });

  it('handles validation network error gracefully', async () => {
    const deps = createDeps({
      validateApiKey: vi.fn().mockResolvedValue({ valid: false, error: 'Network error' }),
    });
    const code = await runAuthApiKey(deps);
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Network error'));
  });

  it('warns when overwriting existing key', async () => {
    const deps = createDeps({
      fileExists: vi.fn().mockReturnValue(true),
    });
    await runAuthApiKey(deps);
    const allCalls = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasWarning = allCalls.some((c: string) => /overwrite|replace|existing/i.test(c));
    expect(hasWarning).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// auth login
// ---------------------------------------------------------------------------

describe('runAuthLogin', () => {
  it('shows OAuth setup instructions', async () => {
    const deps = createDeps();
    await runAuthLogin(deps);
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasInstructions = allCalls.some((c: string) => /claude|oauth|token/i.test(c));
    expect(hasInstructions).toBe(true);
  });

  it('prompts for the token', async () => {
    const deps = createDeps();
    await runAuthLogin(deps);
    expect(deps.promptString).toHaveBeenCalled();
  });

  it('stores token with 0600 permissions', async () => {
    const deps = createDeps();
    const code = await runAuthLogin(deps);
    expect(code).toBe(0);
    expect(deps.writeFileSecure).toHaveBeenCalledWith(
      '/home/user/.carapace/credentials/claude-oauth-token',
      'oauth-token-value',
      0o600,
    );
  });

  it('rejects empty token', async () => {
    const deps = createDeps({
      promptString: vi.fn().mockResolvedValue(''),
    });
    const code = await runAuthLogin(deps);
    expect(code).toBe(1);
    expect(deps.writeFileSecure).not.toHaveBeenCalled();
  });

  it('reports success after storing', async () => {
    const deps = createDeps();
    const code = await runAuthLogin(deps);
    expect(code).toBe(0);
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasSuccess = allCalls.some((c: string) => /stored|saved|configured/i.test(c));
    expect(hasSuccess).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// auth status
// ---------------------------------------------------------------------------

describe('runAuthStatus', () => {
  it('shows no credentials when none exist', async () => {
    const deps = createDeps({
      fileExists: vi.fn().mockReturnValue(false),
    });
    const code = await runAuthStatus(deps);
    expect(code).toBe(0);
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasNone = allCalls.some((c: string) => /no credentials|not configured/i.test(c));
    expect(hasNone).toBe(true);
  });

  it('shows API key status when configured', async () => {
    const deps = createDeps({
      fileExists: vi.fn().mockImplementation((p: string) => p.includes('anthropic-api-key')),
      readFile: vi.fn().mockReturnValue('sk-ant-api03-abc123def456'),
      fileStat: vi.fn().mockReturnValue({ mtime: new Date('2026-02-15T10:00:00Z') }),
    });
    const code = await runAuthStatus(deps);
    expect(code).toBe(0);
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasApiKey = allCalls.some((c: string) => /api.key|anthropic/i.test(c));
    expect(hasApiKey).toBe(true);
  });

  it('shows OAuth token status when configured', async () => {
    const deps = createDeps({
      fileExists: vi.fn().mockImplementation((p: string) => p.includes('claude-oauth-token')),
      fileStat: vi.fn().mockReturnValue({ mtime: new Date('2026-02-15T10:00:00Z') }),
    });
    const code = await runAuthStatus(deps);
    expect(code).toBe(0);
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasOAuth = allCalls.some((c: string) => /oauth|token/i.test(c));
    expect(hasOAuth).toBe(true);
  });

  it('never prints actual credential values', async () => {
    const secret = 'sk-ant-api03-supersecretkey123456789';
    const deps = createDeps({
      fileExists: vi.fn().mockImplementation((p: string) => p.includes('anthropic-api-key')),
      readFile: vi.fn().mockReturnValue(secret),
      fileStat: vi.fn().mockReturnValue({ mtime: new Date('2026-02-15T10:00:00Z') }),
    });
    await runAuthStatus(deps);
    const allStdout = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    const allStderr = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(allStdout).not.toContain(secret);
    expect(allStderr).not.toContain(secret);
  });

  it('shows masked key prefix', async () => {
    const deps = createDeps({
      fileExists: vi.fn().mockImplementation((p: string) => p.includes('anthropic-api-key')),
      readFile: vi.fn().mockReturnValue('sk-ant-api03-abc123def456'),
      fileStat: vi.fn().mockReturnValue({ mtime: new Date('2026-02-15T10:00:00Z') }),
    });
    await runAuthStatus(deps);
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(allCalls).toContain('sk-ant-***');
  });

  it('shows which credential takes precedence when both exist', async () => {
    const deps = createDeps({
      fileExists: vi.fn().mockReturnValue(true),
      readFile: vi.fn().mockReturnValue('some-value'),
      fileStat: vi.fn().mockReturnValue({ mtime: new Date('2026-02-15T10:00:00Z') }),
    });
    const code = await runAuthStatus(deps);
    expect(code).toBe(0);
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const hasPrecedence = allCalls.some((c: string) => /active|precedence|primary/i.test(c));
    expect(hasPrecedence).toBe(true);
  });

  it('shows last updated timestamp', async () => {
    const deps = createDeps({
      fileExists: vi.fn().mockImplementation((p: string) => p.includes('anthropic-api-key')),
      readFile: vi.fn().mockReturnValue('sk-ant-api03-abc123'),
      fileStat: vi.fn().mockReturnValue({ mtime: new Date('2026-02-15T10:00:00Z') }),
    });
    await runAuthStatus(deps);
    const allCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(allCalls).toMatch(/2026-02-15/);
  });
});

// ---------------------------------------------------------------------------
// File permissions
// ---------------------------------------------------------------------------

describe('file permissions', () => {
  it('api-key stored at credentials/anthropic-api-key', async () => {
    const deps = createDeps();
    await runAuthApiKey(deps);
    expect(deps.writeFileSecure).toHaveBeenCalledWith(
      expect.stringContaining('credentials/anthropic-api-key'),
      expect.any(String),
      0o600,
    );
  });

  it('oauth token stored at credentials/claude-oauth-token', async () => {
    const deps = createDeps();
    await runAuthLogin(deps);
    expect(deps.writeFileSecure).toHaveBeenCalledWith(
      expect.stringContaining('credentials/claude-oauth-token'),
      expect.any(String),
      0o600,
    );
  });
});
