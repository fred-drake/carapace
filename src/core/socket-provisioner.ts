/**
 * ZeroMQ socket provisioner for Carapace.
 *
 * Manages the lifecycle of Unix domain socket paths used by the
 * ZeroMQ messaging channels (Request Channel and Event Bus). Each
 * session gets a unique pair of socket files under the configured
 * socket directory.
 *
 * Responsibilities:
 *   - Generate unique per-session socket paths
 *   - Ensure the socket directory exists with restricted permissions
 *   - Detect path collisions (existing files from crashed sessions)
 *   - Produce {@link SocketMount} objects for container startup
 *   - Clean up socket files on session release and stale detection
 *
 * ZeroMQ creates the actual socket files when binding. This module
 * manages path allocation, tracking, and cleanup — not binding.
 *
 * @see docs/ARCHITECTURE.md § "ZeroMQ Messaging Architecture"
 */

import { existsSync, unlinkSync, readdirSync, mkdirSync, chmodSync } from 'node:fs';
import type { SocketMount } from './container/runtime.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default container path for the request channel socket. */
export const DEFAULT_CONTAINER_REQUEST_PATH = '/run/zmq/request.sock';

/** Default container path for the event bus socket. */
export const DEFAULT_CONTAINER_EVENT_PATH = '/run/zmq/events.sock';

/** Permission mode for the socket directory (owner-only). */
export const SOCKET_DIR_MODE = 0o700;

/** Suffix appended to session ID for request channel socket files. */
export const SOCKET_FILE_SUFFIX_REQUEST = '-request.sock';

/** Suffix appended to session ID for event bus socket files. */
export const SOCKET_FILE_SUFFIX_EVENT = '-events.sock';

/**
 * Pattern for valid session IDs.
 * Alphanumeric, hyphens, underscores, and dots. No path separators.
 */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Filesystem abstraction (injectable for testing)
// ---------------------------------------------------------------------------

/** Minimal filesystem interface for socket provisioning. */
export interface SocketFs {
  existsSync(path: string): boolean;
  unlinkSync(path: string): void;
  readdirSync(dir: string): string[];
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void;
  chmodSync(path: string, mode: number): void;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration options for the socket provisioner. */
export interface SocketProvisionerOptions {
  /** Base directory for socket files. */
  socketDir: string;
  /** Container path for the request socket. Defaults to /run/zmq/request.sock. */
  containerRequestPath?: string;
  /** Container path for the event socket. Defaults to /run/zmq/events.sock. */
  containerEventPath?: string;
  /** Filesystem implementation. Defaults to Node.js fs. */
  fs?: SocketFs;
}

// ---------------------------------------------------------------------------
// Provision result
// ---------------------------------------------------------------------------

/** Result of provisioning sockets for a session. */
export interface SocketProvisionResult {
  /** The session ID these sockets belong to. */
  sessionId: string;
  /** Host-side path to the request channel socket file. */
  requestSocketPath: string;
  /** Host-side path to the event bus socket file. */
  eventSocketPath: string;
  /** ZeroMQ IPC address for the request channel (ipc:// prefix). */
  requestAddress: string;
  /** ZeroMQ IPC address for the event bus (ipc:// prefix). */
  eventAddress: string;
  /** Socket mounts to pass to ContainerRunOptions. */
  socketMounts: SocketMount[];
}

// ---------------------------------------------------------------------------
// Default filesystem using Node.js fs
// ---------------------------------------------------------------------------

function createDefaultFs(): SocketFs {
  return {
    existsSync: (path: string) => existsSync(path),
    unlinkSync: (path: string) => unlinkSync(path),
    readdirSync: (dir: string) => readdirSync(dir) as string[],
    mkdirSync: (path: string, options?: { recursive?: boolean; mode?: number }) =>
      mkdirSync(path, options),
    chmodSync: (path: string, mode: number) => chmodSync(path, mode),
  };
}

// ---------------------------------------------------------------------------
// SocketProvisioner
// ---------------------------------------------------------------------------

/**
 * Manages ZeroMQ Unix domain socket paths for Carapace sessions.
 *
 * Each session gets two socket files:
 *   - `{socketDir}/{sessionId}-request.sock` — Request channel (ROUTER/DEALER)
 *   - `{socketDir}/{sessionId}-events.sock`  — Event bus (PUB/SUB)
 *
 * The provisioner tracks active sessions in memory and can clean up
 * stale socket files left by crashed processes.
 */
export class SocketProvisioner {
  private readonly socketDir: string;
  private readonly containerRequestPath: string;
  private readonly containerEventPath: string;
  private readonly fs: SocketFs;
  private readonly sessions: Map<string, SocketProvisionResult> = new Map();

  constructor(options: SocketProvisionerOptions) {
    this.socketDir = options.socketDir;
    this.containerRequestPath = options.containerRequestPath ?? DEFAULT_CONTAINER_REQUEST_PATH;
    this.containerEventPath = options.containerEventPath ?? DEFAULT_CONTAINER_EVENT_PATH;
    this.fs = options.fs ?? createDefaultFs();
  }

  /**
   * Ensure the socket directory exists with restricted permissions (0700).
   *
   * Idempotent — safe to call on every startup.
   */
  ensureDirectory(): void {
    this.fs.mkdirSync(this.socketDir, { recursive: true });
    this.fs.chmodSync(this.socketDir, SOCKET_DIR_MODE);
  }

  /**
   * Provision socket paths for a new session.
   *
   * Validates the session ID, checks for collisions (both in-memory
   * and on disk), registers the session, and returns paths + mounts.
   *
   * @param sessionId - Unique session identifier.
   * @returns The provisioned socket paths and container mounts.
   * @throws If the session ID is invalid, already provisioned, or
   *   socket files already exist on disk.
   */
  provision(sessionId: string): SocketProvisionResult {
    this.validateSessionId(sessionId);

    if (this.sessions.has(sessionId)) {
      throw new Error(`Socket already provisioned for session: ${sessionId}`);
    }

    const requestSocketPath = `${this.socketDir}/${sessionId}${SOCKET_FILE_SUFFIX_REQUEST}`;
    const eventSocketPath = `${this.socketDir}/${sessionId}${SOCKET_FILE_SUFFIX_EVENT}`;

    // Check for on-disk collisions (stale files from crashed processes).
    if (this.fs.existsSync(requestSocketPath)) {
      throw new Error(`Socket file already exists: ${sessionId}${SOCKET_FILE_SUFFIX_REQUEST}`);
    }
    if (this.fs.existsSync(eventSocketPath)) {
      throw new Error(`Socket file already exists: ${sessionId}${SOCKET_FILE_SUFFIX_EVENT}`);
    }

    const result: SocketProvisionResult = {
      sessionId,
      requestSocketPath,
      eventSocketPath,
      requestAddress: `ipc://${requestSocketPath}`,
      eventAddress: `ipc://${eventSocketPath}`,
      socketMounts: [
        {
          hostPath: requestSocketPath,
          containerPath: this.containerRequestPath,
        },
        {
          hostPath: eventSocketPath,
          containerPath: this.containerEventPath,
        },
      ],
    };

    this.sessions.set(sessionId, result);
    return result;
  }

  /**
   * Release sockets for a session, removing tracked state and cleaning
   * up socket files from disk if they exist.
   *
   * @param sessionId - The session to release.
   * @throws If the session ID is not tracked.
   */
  release(sessionId: string): void {
    const result = this.sessions.get(sessionId);
    if (!result) {
      throw new Error(`No sockets provisioned for session: ${sessionId}`);
    }

    this.sessions.delete(sessionId);
    this.removeFileIfExists(result.requestSocketPath);
    this.removeFileIfExists(result.eventSocketPath);
  }

  /**
   * Release all provisioned sessions, cleaning up socket files.
   */
  releaseAll(): void {
    const sessionIds = [...this.sessions.keys()];
    for (const sessionId of sessionIds) {
      this.release(sessionId);
    }
  }

  /**
   * Clean up stale socket files that don't belong to any active session.
   *
   * Scans the socket directory for `.sock` files and removes any whose
   * session ID is not in the provided active set or internally tracked.
   *
   * @param activeSessions - Set of session IDs considered active.
   * @returns List of removed file paths.
   */
  cleanupStale(activeSessions: ReadonlySet<string>): string[] {
    let entries: string[];
    try {
      entries = this.fs.readdirSync(this.socketDir);
    } catch {
      // Directory doesn't exist yet — nothing to clean.
      return [];
    }

    const removed: string[] = [];

    for (const entry of entries) {
      const sessionId = this.extractSessionId(entry);
      if (sessionId === null) {
        // Not a Carapace socket file — skip.
        continue;
      }

      if (activeSessions.has(sessionId) || this.sessions.has(sessionId)) {
        continue;
      }

      const fullPath = `${this.socketDir}/${entry}`;
      this.fs.unlinkSync(fullPath);
      removed.push(fullPath);
    }

    return removed;
  }

  /** Check if a session has provisioned sockets. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Get the provision result for a session. */
  get(sessionId: string): SocketProvisionResult | undefined {
    return this.sessions.get(sessionId);
  }

  /** Number of currently provisioned sessions. */
  get activeCount(): number {
    return this.sessions.size;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Validate a session ID. Must be non-empty, alphanumeric with
   * hyphens/underscores/dots, and must not contain path separators.
   */
  private validateSessionId(sessionId: string): void {
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(
        `Invalid session ID: "${sessionId}". ` +
          'Must be non-empty, start with alphanumeric, and contain only ' +
          'alphanumeric characters, hyphens, underscores, and dots.',
      );
    }
  }

  /** Extract a session ID from a socket filename, or null if not a socket file. */
  private extractSessionId(filename: string): string | null {
    if (filename.endsWith(SOCKET_FILE_SUFFIX_REQUEST)) {
      return filename.slice(0, -SOCKET_FILE_SUFFIX_REQUEST.length);
    }
    if (filename.endsWith(SOCKET_FILE_SUFFIX_EVENT)) {
      return filename.slice(0, -SOCKET_FILE_SUFFIX_EVENT.length);
    }
    return null;
  }

  /** Remove a file if it exists, swallowing ENOENT errors. */
  private removeFileIfExists(path: string): void {
    if (this.fs.existsSync(path)) {
      this.fs.unlinkSync(path);
    }
  }
}
