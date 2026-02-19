import { describe, it, expect, beforeEach } from 'vitest';
import type { SocketMount } from './container/runtime.js';
import {
  SocketProvisioner,
  DEFAULT_CONTAINER_REQUEST_PATH,
  DEFAULT_CONTAINER_EVENT_PATH,
  SOCKET_DIR_MODE,
  SOCKET_FILE_SUFFIX_REQUEST,
  SOCKET_FILE_SUFFIX_EVENT,
} from './socket-provisioner.js';
import type { SocketFs } from './socket-provisioner.js';

// ---------------------------------------------------------------------------
// Fake filesystem
// ---------------------------------------------------------------------------

class FakeFs implements SocketFs {
  readonly files: Set<string> = new Set();
  readonly dirs: Map<string, { mode?: number }> = new Map();
  readonly unlinkCalls: string[] = [];
  readonly mkdirCalls: Array<{ path: string; recursive?: boolean; mode?: number }> = [];
  readonly chmodCalls: Array<{ path: string; mode: number }> = [];

  existsSync(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path);
  }

  unlinkSync(path: string): void {
    this.unlinkCalls.push(path);
    this.files.delete(path);
  }

  readdirSync(dir: string): string[] {
    const entries: string[] = [];
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    for (const file of this.files) {
      if (file.startsWith(prefix)) {
        const relative = file.slice(prefix.length);
        // Only direct children (no nested paths).
        if (!relative.includes('/')) {
          entries.push(relative);
        }
      }
    }
    return entries;
  }

  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void {
    this.mkdirCalls.push({ path, recursive: options?.recursive, mode: options?.mode });
    this.dirs.set(path, { mode: options?.mode });
  }

  chmodSync(path: string, mode: number): void {
    this.chmodCalls.push({ path, mode });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SocketProvisioner', () => {
  let fakeFs: FakeFs;
  let provisioner: SocketProvisioner;
  const socketDir = '/home/user/.carapace/run/sockets';

  beforeEach(() => {
    fakeFs = new FakeFs();
    provisioner = new SocketProvisioner({
      socketDir,
      fs: fakeFs,
    });
  });

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  describe('constants', () => {
    it('exports default container paths', () => {
      expect(DEFAULT_CONTAINER_REQUEST_PATH).toBe('/run/zmq/request.sock');
      expect(DEFAULT_CONTAINER_EVENT_PATH).toBe('/run/zmq/events.sock');
    });

    it('exports socket directory permission mode', () => {
      expect(SOCKET_DIR_MODE).toBe(0o700);
    });

    it('exports socket file suffixes', () => {
      expect(SOCKET_FILE_SUFFIX_REQUEST).toBe('-request.sock');
      expect(SOCKET_FILE_SUFFIX_EVENT).toBe('-events.sock');
    });
  });

  // -------------------------------------------------------------------------
  // ensureDirectory()
  // -------------------------------------------------------------------------

  describe('ensureDirectory()', () => {
    it('creates the socket directory with restricted permissions', () => {
      provisioner.ensureDirectory();

      expect(fakeFs.mkdirCalls).toHaveLength(1);
      expect(fakeFs.mkdirCalls[0]).toEqual({
        path: socketDir,
        recursive: true,
        mode: undefined,
      });
      expect(fakeFs.chmodCalls).toHaveLength(1);
      expect(fakeFs.chmodCalls[0]).toEqual({
        path: socketDir,
        mode: SOCKET_DIR_MODE,
      });
    });
  });

  // -------------------------------------------------------------------------
  // provision()
  // -------------------------------------------------------------------------

  describe('provision()', () => {
    it('generates socket paths with session ID', () => {
      const result = provisioner.provision('session-abc');

      expect(result.requestSocketPath).toBe(
        `${socketDir}/session-abc${SOCKET_FILE_SUFFIX_REQUEST}`,
      );
      expect(result.eventSocketPath).toBe(`${socketDir}/session-abc${SOCKET_FILE_SUFFIX_EVENT}`);
    });

    it('returns IPC transport addresses', () => {
      const result = provisioner.provision('session-abc');

      expect(result.requestAddress).toBe(
        `ipc://${socketDir}/session-abc${SOCKET_FILE_SUFFIX_REQUEST}`,
      );
      expect(result.eventAddress).toBe(`ipc://${socketDir}/session-abc${SOCKET_FILE_SUFFIX_EVENT}`);
    });

    it('returns session ID in result', () => {
      const result = provisioner.provision('session-xyz');
      expect(result.sessionId).toBe('session-xyz');
    });

    it('returns SocketMount array with correct host and container paths', () => {
      const result = provisioner.provision('session-abc');

      expect(result.socketMounts).toHaveLength(2);

      const requestMount = result.socketMounts[0] as SocketMount;
      expect(requestMount.hostPath).toBe(`${socketDir}/session-abc${SOCKET_FILE_SUFFIX_REQUEST}`);
      expect(requestMount.containerPath).toBe(DEFAULT_CONTAINER_REQUEST_PATH);

      const eventMount = result.socketMounts[1] as SocketMount;
      expect(eventMount.hostPath).toBe(`${socketDir}/session-abc${SOCKET_FILE_SUFFIX_EVENT}`);
      expect(eventMount.containerPath).toBe(DEFAULT_CONTAINER_EVENT_PATH);
    });

    it('uses custom container paths when configured', () => {
      const custom = new SocketProvisioner({
        socketDir,
        containerRequestPath: '/custom/req.sock',
        containerEventPath: '/custom/evt.sock',
        fs: fakeFs,
      });

      const result = custom.provision('session-1');

      expect(result.socketMounts[0]!.containerPath).toBe('/custom/req.sock');
      expect(result.socketMounts[1]!.containerPath).toBe('/custom/evt.sock');
    });

    it('throws on duplicate session ID', () => {
      provisioner.provision('dup-session');

      expect(() => provisioner.provision('dup-session')).toThrow(
        'Socket already provisioned for session: dup-session',
      );
    });

    it('throws when socket file already exists on disk (collision)', () => {
      fakeFs.files.add(`${socketDir}/existing${SOCKET_FILE_SUFFIX_REQUEST}`);

      expect(() => provisioner.provision('existing')).toThrow(
        /socket file already exists.*existing-request\.sock/i,
      );
    });

    it('throws when event socket file already exists on disk', () => {
      fakeFs.files.add(`${socketDir}/existing${SOCKET_FILE_SUFFIX_EVENT}`);

      expect(() => provisioner.provision('existing')).toThrow(
        /socket file already exists.*existing-events\.sock/i,
      );
    });

    it('rejects session IDs with path traversal characters', () => {
      expect(() => provisioner.provision('../escape')).toThrow(/invalid session id/i);
      expect(() => provisioner.provision('foo/bar')).toThrow(/invalid session id/i);
      expect(() => provisioner.provision('foo\\bar')).toThrow(/invalid session id/i);
    });

    it('rejects empty session ID', () => {
      expect(() => provisioner.provision('')).toThrow(/invalid session id/i);
    });

    it('accepts UUID-style session IDs', () => {
      const result = provisioner.provision('550e8400-e29b-41d4-a716-446655440000');
      expect(result.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('accepts alphanumeric session IDs with hyphens and underscores', () => {
      const result = provisioner.provision('my_session-01');
      expect(result.sessionId).toBe('my_session-01');
    });
  });

  // -------------------------------------------------------------------------
  // release()
  // -------------------------------------------------------------------------

  describe('release()', () => {
    it('removes session from tracking', () => {
      provisioner.provision('session-1');
      expect(provisioner.has('session-1')).toBe(true);

      provisioner.release('session-1');
      expect(provisioner.has('session-1')).toBe(false);
    });

    it('removes socket files from disk', () => {
      provisioner.provision('session-1');

      // Simulate that ZeroMQ created the socket files.
      fakeFs.files.add(`${socketDir}/session-1${SOCKET_FILE_SUFFIX_REQUEST}`);
      fakeFs.files.add(`${socketDir}/session-1${SOCKET_FILE_SUFFIX_EVENT}`);

      provisioner.release('session-1');

      expect(fakeFs.unlinkCalls).toContain(`${socketDir}/session-1${SOCKET_FILE_SUFFIX_REQUEST}`);
      expect(fakeFs.unlinkCalls).toContain(`${socketDir}/session-1${SOCKET_FILE_SUFFIX_EVENT}`);
    });

    it('skips file removal when socket files do not exist', () => {
      provisioner.provision('session-1');
      provisioner.release('session-1');

      // No unlink calls because the files don't exist.
      expect(fakeFs.unlinkCalls).toHaveLength(0);
    });

    it('throws for unknown session ID', () => {
      expect(() => provisioner.release('nonexistent')).toThrow(
        'No sockets provisioned for session: nonexistent',
      );
    });

    it('allows re-provisioning after release', () => {
      provisioner.provision('session-1');
      provisioner.release('session-1');

      // Should not throw.
      const result = provisioner.provision('session-1');
      expect(result.sessionId).toBe('session-1');
    });
  });

  // -------------------------------------------------------------------------
  // cleanupStale()
  // -------------------------------------------------------------------------

  describe('cleanupStale()', () => {
    it('removes socket files not belonging to active sessions', () => {
      fakeFs.files.add(`${socketDir}/old-session${SOCKET_FILE_SUFFIX_REQUEST}`);
      fakeFs.files.add(`${socketDir}/old-session${SOCKET_FILE_SUFFIX_EVENT}`);

      const removed = provisioner.cleanupStale(new Set());

      expect(removed).toContain(`${socketDir}/old-session${SOCKET_FILE_SUFFIX_REQUEST}`);
      expect(removed).toContain(`${socketDir}/old-session${SOCKET_FILE_SUFFIX_EVENT}`);
      expect(fakeFs.unlinkCalls).toHaveLength(2);
    });

    it('preserves socket files for active sessions', () => {
      fakeFs.files.add(`${socketDir}/active${SOCKET_FILE_SUFFIX_REQUEST}`);
      fakeFs.files.add(`${socketDir}/active${SOCKET_FILE_SUFFIX_EVENT}`);

      const removed = provisioner.cleanupStale(new Set(['active']));

      expect(removed).toHaveLength(0);
      expect(fakeFs.unlinkCalls).toHaveLength(0);
    });

    it('preserves files for internally tracked sessions', () => {
      provisioner.provision('tracked');
      fakeFs.files.add(`${socketDir}/tracked${SOCKET_FILE_SUFFIX_REQUEST}`);
      fakeFs.files.add(`${socketDir}/tracked${SOCKET_FILE_SUFFIX_EVENT}`);

      const removed = provisioner.cleanupStale(new Set());

      expect(removed).toHaveLength(0);
    });

    it('ignores non-socket files in directory', () => {
      fakeFs.files.add(`${socketDir}/README.md`);
      fakeFs.files.add(`${socketDir}/.gitkeep`);

      const removed = provisioner.cleanupStale(new Set());

      expect(removed).toHaveLength(0);
      expect(fakeFs.unlinkCalls).toHaveLength(0);
    });

    it('returns empty array when no stale files exist', () => {
      const removed = provisioner.cleanupStale(new Set());
      expect(removed).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // has() / get() / activeCount
  // -------------------------------------------------------------------------

  describe('state tracking', () => {
    it('has() returns true for provisioned sessions', () => {
      provisioner.provision('s1');
      expect(provisioner.has('s1')).toBe(true);
    });

    it('has() returns false for unknown sessions', () => {
      expect(provisioner.has('unknown')).toBe(false);
    });

    it('get() returns provision result for known sessions', () => {
      const result = provisioner.provision('s1');
      expect(provisioner.get('s1')).toEqual(result);
    });

    it('get() returns undefined for unknown sessions', () => {
      expect(provisioner.get('unknown')).toBeUndefined();
    });

    it('activeCount returns number of provisioned sessions', () => {
      expect(provisioner.activeCount).toBe(0);

      provisioner.provision('s1');
      expect(provisioner.activeCount).toBe(1);

      provisioner.provision('s2');
      expect(provisioner.activeCount).toBe(2);

      provisioner.release('s1');
      expect(provisioner.activeCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // releaseAll()
  // -------------------------------------------------------------------------

  describe('releaseAll()', () => {
    it('releases all provisioned sessions', () => {
      provisioner.provision('s1');
      provisioner.provision('s2');
      provisioner.provision('s3');

      // Simulate socket files on disk.
      for (const sid of ['s1', 's2', 's3']) {
        fakeFs.files.add(`${socketDir}/${sid}${SOCKET_FILE_SUFFIX_REQUEST}`);
        fakeFs.files.add(`${socketDir}/${sid}${SOCKET_FILE_SUFFIX_EVENT}`);
      }

      provisioner.releaseAll();

      expect(provisioner.activeCount).toBe(0);
      expect(fakeFs.unlinkCalls).toHaveLength(6);
    });

    it('is a no-op when no sessions are provisioned', () => {
      provisioner.releaseAll();
      expect(provisioner.activeCount).toBe(0);
      expect(fakeFs.unlinkCalls).toHaveLength(0);
    });
  });
});
