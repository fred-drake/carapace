/**
 * Tests for main() entry point.
 *
 * main() is a thin wiring layer that parses args, creates real CliDeps,
 * calls runCommand, and returns the exit code. Tests verify the wiring
 * works without real process.exit().
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { main } from './main.js';

// Mock cli.ts to intercept runCommand calls
vi.mock('./cli.js', async () => {
  const actual = await vi.importActual<typeof import('./cli.js')>('./cli.js');
  return {
    ...actual,
    runCommand: vi.fn().mockResolvedValue(0),
  };
});

import { runCommand } from './cli.js';

describe('main', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls runCommand with parsed command and returns exit code', async () => {
    const code = await main(['node', 'carapace', 'doctor']);
    expect(runCommand).toHaveBeenCalledWith('doctor', expect.any(Object), expect.any(Object), '');
    expect(code).toBe(0);
  });

  it('passes --version through as command', async () => {
    const code = await main(['node', 'carapace', '--version']);
    expect(runCommand).toHaveBeenCalledWith(
      '--version',
      expect.any(Object),
      expect.objectContaining({ version: true }),
      '',
    );
    expect(code).toBe(0);
  });

  it('returns non-zero exit code on failure', async () => {
    vi.mocked(runCommand).mockResolvedValueOnce(1);
    const code = await main(['node', 'carapace', 'bogus']);
    expect(code).toBe(1);
  });

  it('passes subcommands through (e.g. auth api-key)', async () => {
    const code = await main(['node', 'carapace', 'auth', 'api-key']);
    expect(runCommand).toHaveBeenCalledWith(
      'auth',
      expect.any(Object),
      expect.any(Object),
      'api-key',
    );
    expect(code).toBe(0);
  });
});
