import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENTRYPOINT_PATH = path.resolve(__dirname, 'entrypoint.sh');

/**
 * Run the entrypoint script with stdin piped, using a fake `claude` binary
 * that prints env vars so we can verify credential injection.
 */
async function runEntrypointWithStdin(
  stdin: string,
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const testScript = `#!/bin/sh
set -eu

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

cat > "$TMPDIR/claude" << 'FAKECLAUDE'
#!/bin/sh
env | grep -E '^(ANTHROPIC_API_KEY|OTHER_SECRET|TOKEN|API_KEY|MULTI)=' | sort || true
echo "---ARGS---"
echo "$@"
FAKECLAUDE
chmod +x "$TMPDIR/claude"

export PATH="$TMPDIR:$PATH"
exec sh "${ENTRYPOINT_PATH}" ${extraArgs.map((a) => `"${a}"`).join(' ')}
`;

  return new Promise((resolve) => {
    const child = execFile(
      'sh',
      ['-c', testScript],
      {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, ENTRYPOINT_PATH },
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          exitCode: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
        });
      },
    );
    if (child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('entrypoint.sh', () => {
  it('script file exists and is readable', () => {
    expect(fs.existsSync(ENTRYPOINT_PATH)).toBe(true);
  });

  it('injects a single credential as an env var', async () => {
    const result = await runEntrypointWithStdin('ANTHROPIC_API_KEY=sk-ant-test\n\n');
    expect(result.stdout).toContain('ANTHROPIC_API_KEY=sk-ant-test');
  });

  it('injects multiple credentials', async () => {
    const stdin = 'ANTHROPIC_API_KEY=sk-ant-test\nOTHER_SECRET=abc123\n\n';
    const result = await runEntrypointWithStdin(stdin);
    expect(result.stdout).toContain('ANTHROPIC_API_KEY=sk-ant-test');
    expect(result.stdout).toContain('OTHER_SECRET=abc123');
  });

  it('handles values containing equals signs', async () => {
    const stdin = 'TOKEN=base64value==\n\n';
    const result = await runEntrypointWithStdin(stdin);
    expect(result.stdout).toContain('TOKEN=base64value==');
  });

  it('passes --dangerously-skip-permissions to claude', async () => {
    const result = await runEntrypointWithStdin('\n');
    expect(result.stdout).toContain('--dangerously-skip-permissions');
  });

  it('works with no credentials (empty stdin)', async () => {
    const result = await runEntrypointWithStdin('\n');
    expect(result.stdout).toContain('---ARGS---');
    expect(result.stdout).toContain('--dangerously-skip-permissions');
  });

  it('stops reading credentials at empty line', async () => {
    // Credential, then empty line, then something that looks like a credential
    // (but should not be read because it's after the terminator)
    const stdin = 'API_KEY=real\n\nAPI_KEY=should_not_appear\n';
    const result = await runEntrypointWithStdin(stdin);
    expect(result.stdout).toContain('API_KEY=real');
    expect(result.stdout).not.toContain('should_not_appear');
  });
});
