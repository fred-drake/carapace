/**
 * Event-to-agent decision logic for Carapace.
 *
 * Evaluates incoming PUB/SUB events and decides whether to spawn a new
 * agent container. Implements the routing rules from ARCHITECTURE.md:
 *
 * - `message.inbound` → spawn if group is configured
 * - `task.triggered`  → always spawn (bypasses group check)
 * - Other topics       → drop (logged, no spawn)
 *
 * Concurrent session limits are enforced for all spawn decisions.
 */

import type { EventEnvelope } from '../types/protocol.js';
import { validateMessageInbound } from './event-schemas.js';
import type { AuditEntry } from './audit-log.js';
import { createLogger, type Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal audit log interface for dependency injection. */
export interface AuditLogSink {
  append: (entry: AuditEntry) => void;
}

/** Dependencies injected into EventDispatcher for testability. */
export interface EventDispatcherDeps {
  /** Count active sessions for a given group. */
  getActiveSessionCount: (group: string) => number;
  /** Spawn a new agent container. Returns the new session ID. */
  spawnAgent: (group: string, env?: Record<string, string>) => Promise<string>;
  /** Maximum concurrent sessions allowed per group. */
  maxSessionsPerGroup: number;
  /** Groups that have plugin subscriptions configured. */
  configuredGroups: ReadonlySet<string>;
  /** Optional audit log for recording rejected events. */
  auditLog?: AuditLogSink;
  /** Optional logger for structured logging. */
  logger?: Logger;
}

/** Discriminated union of dispatch outcomes. */
export type DispatchResult =
  | { action: 'spawned'; sessionId: string; group: string }
  | { action: 'dropped'; reason: string; topic: string }
  | { action: 'rejected'; reason: string; group: string }
  | { action: 'error'; reason: string; group: string };

// ---------------------------------------------------------------------------
// Topics that trigger spawns
// ---------------------------------------------------------------------------

const SPAWN_TOPICS = new Set(['message.inbound', 'task.triggered']);

// ---------------------------------------------------------------------------
// EventDispatcher
// ---------------------------------------------------------------------------

export class EventDispatcher {
  private readonly deps: EventDispatcherDeps;
  private readonly logger: Logger;

  constructor(deps: EventDispatcherDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createLogger('event-dispatcher');
  }

  /**
   * Evaluate an event envelope and decide whether to spawn an agent.
   *
   * Never throws — all outcomes are returned as a `DispatchResult`.
   */
  async dispatch(envelope: EventEnvelope): Promise<DispatchResult> {
    const { topic, group } = envelope;

    this.logger.debug('dispatch received', { topic, group });

    // Empty group — cannot route
    if (!group || group.length === 0) {
      this.logger.debug('event dropped', { topic, reason: 'empty group' });
      return { action: 'dropped', reason: 'Empty group field', topic };
    }

    // Non-spawn topics are logged and dropped
    if (!SPAWN_TOPICS.has(topic)) {
      this.logger.debug('event dropped', { topic, reason: 'non-spawn topic' });
      return { action: 'dropped', reason: `No spawn action for topic "${topic}"`, topic };
    }

    // message.inbound requires a configured group
    if (topic === 'message.inbound' && !this.deps.configuredGroups.has(group)) {
      this.logger.debug('event dropped', { topic, group, reason: 'unconfigured group' });
      return {
        action: 'dropped',
        reason: `Group "${group}" is not configured for message.inbound events`,
        topic,
      };
    }

    // message.inbound payload schema validation
    if (topic === 'message.inbound') {
      const validation = validateMessageInbound(envelope.payload as Record<string, unknown>);
      if (!validation.valid) {
        const reason = `Payload validation failed: ${validation.errors.join('; ')}`;
        this.logger.info('event rejected', { topic, group, reason: 'payload validation' });
        this.auditReject(envelope, reason);
        return { action: 'rejected', reason, group };
      }
    }

    // Concurrent session limit check
    const activeCount = this.deps.getActiveSessionCount(group);
    if (activeCount >= this.deps.maxSessionsPerGroup) {
      this.logger.info('event rejected', {
        topic,
        group,
        reason: 'session limit',
        active: activeCount,
        max: this.deps.maxSessionsPerGroup,
      });
      return {
        action: 'rejected',
        reason:
          `Concurrent session limit reached for group "${group}" ` +
          `(${activeCount}/${this.deps.maxSessionsPerGroup})`,
        group,
      };
    }

    // Build optional environment from task prompt
    const env = this.extractSpawnEnv(envelope);

    // Spawn the agent
    try {
      const sessionId = await this.deps.spawnAgent(group, env);
      this.logger.info('agent spawned', { topic, group, session: sessionId });
      return { action: 'spawned', sessionId, group };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('spawn failed', {
        topic,
        group,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return { action: 'error', reason: message, group };
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Log a rejected event to the audit log (if configured). */
  private auditReject(envelope: EventEnvelope, reason: string): void {
    if (!this.deps.auditLog) return;
    this.deps.auditLog.append({
      timestamp: new Date().toISOString(),
      group: envelope.group,
      source: envelope.source,
      topic: envelope.topic,
      correlation: envelope.correlation,
      stage: 'payload_validation',
      outcome: 'rejected',
      reason,
    });
  }

  /** Extract environment variables from the event payload for the spawn. */
  private extractSpawnEnv(envelope: EventEnvelope): Record<string, string> | undefined {
    if (envelope.topic === 'task.triggered') {
      const prompt = (envelope.payload as Record<string, unknown>)['prompt'];
      if (typeof prompt === 'string' && prompt.length > 0) {
        return { CARAPACE_TASK_PROMPT: prompt };
      }
    }
    return undefined;
  }
}
