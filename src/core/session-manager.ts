/**
 * Session manager for Carapace.
 *
 * Tracks active agent sessions: which container is running, which group it
 * belongs to, session start time, and the ZeroMQ connection identity. The
 * router uses this to construct envelope identity fields from trusted state.
 */

import type { SessionContext } from './pipeline/types.js';
import { createLogger, type Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Session record
// ---------------------------------------------------------------------------

/** A tracked agent session. */
export interface Session {
  /** Unique session identifier. */
  sessionId: string;
  /** Container ID from the container runtime. */
  containerId: string;
  /** Group this session belongs to (e.g. "email", "slack"). */
  group: string;
  /** ZeroMQ connection identity for routing messages. */
  connectionIdentity: string;
  /** ISO 8601 timestamp when the session was created. */
  startedAt: string;
}

/** Options for creating a new session. */
export interface CreateSessionOptions {
  containerId: string;
  group: string;
  connectionIdentity: string;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private readonly logger: Logger;

  /** Sessions indexed by session ID. */
  private readonly sessions = new Map<string, Session>();

  /** Reverse index: connection identity → session ID. */
  private readonly connectionIndex = new Map<string, string>();

  /** Reverse index: container ID → session ID. */
  private readonly containerIndex = new Map<string, string>();

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger('session');
  }

  /**
   * Create a new session.
   *
   * @throws If the connection identity or container ID is already in use.
   */
  create(options: CreateSessionOptions): Session {
    // Guard against duplicate connection identity.
    if (this.connectionIndex.has(options.connectionIdentity)) {
      throw new Error(`Connection identity "${options.connectionIdentity}" is already in use`);
    }

    // Guard against duplicate container ID.
    if (this.containerIndex.has(options.containerId)) {
      throw new Error(`Container "${options.containerId}" already has a session`);
    }

    const session: Session = {
      sessionId: crypto.randomUUID(),
      containerId: options.containerId,
      group: options.group,
      connectionIdentity: options.connectionIdentity,
      startedAt: new Date().toISOString(),
    };

    this.sessions.set(session.sessionId, session);
    this.connectionIndex.set(options.connectionIdentity, session.sessionId);
    this.containerIndex.set(options.containerId, session.sessionId);

    this.logger.info('session created', {
      session: session.sessionId,
      group: session.group,
      containerId: session.containerId,
    });

    return session;
  }

  /** Get a session by its session ID, or null if not found. */
  get(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Delete a session by its session ID.
   * @returns true if the session was found and removed, false otherwise.
   */
  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    this.sessions.delete(sessionId);
    this.connectionIndex.delete(session.connectionIdentity);
    this.containerIndex.delete(session.containerId);

    this.logger.info('session deleted', {
      session: sessionId,
      group: session.group,
    });

    return true;
  }

  /** Look up a session by ZeroMQ connection identity. */
  getByConnectionIdentity(connectionIdentity: string): Session | null {
    const sessionId = this.connectionIndex.get(connectionIdentity);
    if (!sessionId) {
      return null;
    }
    return this.sessions.get(sessionId) ?? null;
  }

  /** Look up a session by container ID. */
  getByContainerId(containerId: string): Session | null {
    const sessionId = this.containerIndex.get(containerId);
    if (!sessionId) {
      return null;
    }
    return this.sessions.get(sessionId) ?? null;
  }

  /** Return all active sessions. */
  getAll(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * Convert a session to a pipeline SessionContext.
   *
   * The router pipeline needs a SessionContext with `source` set to the
   * container ID (the trusted identity of the sender).
   */
  toSessionContext(sessionId: string): SessionContext | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    return {
      sessionId: session.sessionId,
      group: session.group,
      source: session.containerId,
      startedAt: session.startedAt,
    };
  }

  /** Remove all sessions and clear all indexes. */
  cleanup(): void {
    const count = this.sessions.size;
    this.sessions.clear();
    this.connectionIndex.clear();
    this.containerIndex.clear();
    this.logger.info('all sessions cleared', { count });
  }
}
