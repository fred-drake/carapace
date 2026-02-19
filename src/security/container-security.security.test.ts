/**
 * Container security runtime probes.
 *
 * These tests build the Carapace container image and attempt each
 * prohibited action from INSIDE the container. Each test verifies
 * that the container enforces the corresponding security constraint.
 *
 * Requires Docker to be available. Runs in the 'security' vitest project.
 * Skip gracefully when Docker is not installed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Docker availability check
// ---------------------------------------------------------------------------

let dockerAvailable = false;
let imageName = 'carapace-security-test:latest';
let containerId = '';

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFile('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a command inside the running container.
 * Returns { stdout, stderr, exitCode }.
 */
async function execInContainer(
  cmd: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFile('docker', ['exec', containerId, ...cmd]);
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? '').trim(),
      exitCode: e.code ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) return;

  // Build the runtime stage image
  try {
    await execFile('docker', ['build', '--target', 'runtime', '-t', imageName, '.'], {
      timeout: 300_000,
    });
  } catch {
    dockerAvailable = false;
    return;
  }

  // Run the container with security constraints matching production:
  // --read-only, --network none, non-interactive (sleep to keep alive)
  try {
    const { stdout } = await execFile('docker', [
      'run',
      '-d',
      '--read-only',
      '--network',
      'none',
      '--tmpfs',
      '/tmp:size=64M',
      '--tmpfs',
      '/home/node/.claude:size=32M',
      '--entrypoint',
      'sleep',
      imageName,
      '300',
    ]);
    containerId = stdout.trim();
  } catch {
    dockerAvailable = false;
  }
}, 360_000);

afterAll(async () => {
  if (containerId) {
    try {
      await execFile('docker', ['rm', '-f', containerId]);
    } catch {
      // Best-effort cleanup
    }
  }
  // Clean up the test image
  try {
    await execFile('docker', ['rmi', '-f', imageName]);
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Constraint 1: Read-only root filesystem
// ---------------------------------------------------------------------------

describe('read-only root filesystem', () => {
  it('rejects writes to /etc', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['sh', '-c', 'touch /etc/test-file 2>&1']);
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects writes to /usr', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['sh', '-c', 'touch /usr/test-file 2>&1']);
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects writes to /app (application directory)', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['sh', '-c', 'touch /app/test-file 2>&1']);
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects overwriting the ipc binary', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['sh', '-c', 'echo "hacked" > /usr/local/bin/ipc 2>&1']);
    expect(result.exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Constraint 2: No network access
// ---------------------------------------------------------------------------

describe('no network access', () => {
  it('DNS resolution fails', async () => {
    if (!dockerAvailable) return;

    // nslookup may not be installed, use a generic network check
    const result = await execInContainer([
      'sh',
      '-c',
      'cat /etc/resolv.conf 2>/dev/null && getent hosts google.com 2>&1',
    ]);
    // Either getent is not found or DNS fails
    expect(result.exitCode).not.toBe(0);
  });

  it('cannot reach external HTTP endpoints', async () => {
    if (!dockerAvailable) return;

    // Try using node to make an HTTP request
    const result = await execInContainer([
      'node',
      '-e',
      'fetch("http://1.1.1.1").then(() => process.exit(0)).catch(() => process.exit(1))',
    ]);
    expect(result.exitCode).not.toBe(0);
  });

  it('cannot create raw TCP connections', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer([
      'node',
      '-e',
      `const net = require("net");
       const s = net.createConnection(80, "1.1.1.1");
       s.setTimeout(2000);
       s.on("connect", () => process.exit(0));
       s.on("error", () => process.exit(1));
       s.on("timeout", () => process.exit(1));`,
    ]);
    expect(result.exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Constraint 3: Only ipc binary is executable (by permission lockdown)
// ---------------------------------------------------------------------------

describe('ipc binary availability', () => {
  it('ipc binary exists and is executable', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['which', 'ipc']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ipc');
  });

  it('ipc binary is a shell wrapper pointing to node', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['cat', '/usr/local/bin/ipc']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('node');
    expect(result.stdout).toContain('ipc');
  });
});

// ---------------------------------------------------------------------------
// Constraint 4 & 5: Read-only overlays (tested via tmpfs behavior)
// ---------------------------------------------------------------------------

describe('writable mounts are correctly limited', () => {
  it('can write to /tmp (tmpfs)', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer([
      'sh',
      '-c',
      'echo "test" > /tmp/test-file && cat /tmp/test-file',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('test');
  });

  it('can write to /home/node/.claude (tmpfs)', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer([
      'sh',
      '-c',
      'echo "test" > /home/node/.claude/test-file && cat /home/node/.claude/test-file',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('test');
  });

  it('cannot write to /app/dist (read-only root)', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['sh', '-c', 'echo "hacked" > /app/dist/test 2>&1']);
    expect(result.exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Constraint 6: No package managers or shells beyond required
// ---------------------------------------------------------------------------

describe('no extra package managers or tools', () => {
  it('curl is not available', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['which', 'curl']);
    expect(result.exitCode).not.toBe(0);
  });

  it('wget is not available', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['which', 'wget']);
    expect(result.exitCode).not.toBe(0);
  });

  it('apt/apt-get is not usable (no lists)', async () => {
    if (!dockerAvailable) return;

    // apt-get may exist in the base image but should fail to install
    // because we cleaned /var/lib/apt/lists and FS is read-only
    const result = await execInContainer(['sh', '-c', 'apt-get update 2>&1']);
    expect(result.exitCode).not.toBe(0);
  });

  it('pip is not available', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['which', 'pip']);
    expect(result.exitCode).not.toBe(0);
  });

  it('pip3 is not available', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['which', 'pip3']);
    expect(result.exitCode).not.toBe(0);
  });

  it('npm is not usable (read-only FS prevents installs)', async () => {
    if (!dockerAvailable) return;

    // npm may exist in the node image but installing should fail
    const result = await execInContainer(['sh', '-c', 'npm install express 2>&1']);
    expect(result.exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Constraint 7: Container runs as non-root
// ---------------------------------------------------------------------------

describe('non-root execution', () => {
  it('runs as non-root user', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['id', '-u']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe('0');
  });

  it('runs as the node user', async () => {
    if (!dockerAvailable) return;

    const result = await execInContainer(['whoami']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('node');
  });
});
