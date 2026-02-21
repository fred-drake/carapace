import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventDispatcher } from './event-dispatcher.js';
import type { EventDispatcherDeps, DispatchResult } from './event-dispatcher.js';
import { createEventEnvelope } from '../testing/factories.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeps(overrides?: Partial<EventDispatcherDeps>): EventDispatcherDeps {
  return {
    getActiveSessionCount: vi.fn(() => 0),
    spawnAgent: vi.fn(async () => 'session-123'),
    maxSessionsPerGroup: 3,
    configuredGroups: new Set(['email', 'slack']),
    ...overrides,
  };
}

/** A valid message.inbound payload that passes schema validation. */
const VALID_INBOUND_PAYLOAD = {
  channel: 'email',
  sender: 'user@example.com',
  content_type: 'text',
  body: 'Hello',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventDispatcher', () => {
  let deps: EventDispatcherDeps;
  let dispatcher: EventDispatcher;

  beforeEach(() => {
    deps = createDeps();
    dispatcher = new EventDispatcher(deps);
  });

  // -----------------------------------------------------------------------
  // message.inbound
  // -----------------------------------------------------------------------

  describe('message.inbound events', () => {
    it('spawns an agent for a configured group', async () => {
      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('spawned');
      if (result.action === 'spawned') {
        expect(result.group).toBe('email');
        expect(result.sessionId).toBe('session-123');
      }
      expect(deps.spawnAgent).toHaveBeenCalledWith('email', undefined);
    });

    it('drops events for unconfigured groups', async () => {
      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'unknown-group',
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('dropped');
      if (result.action === 'dropped') {
        expect(result.reason).toMatch(/unconfigured|not configured/i);
      }
      expect(deps.spawnAgent).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // task.triggered
  // -----------------------------------------------------------------------

  describe('task.triggered events', () => {
    it('always spawns regardless of configured groups', async () => {
      const envelope = createEventEnvelope({
        topic: 'task.triggered',
        group: 'unconfigured-group',
        payload: { prompt: 'Process the report' },
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('spawned');
      if (result.action === 'spawned') {
        expect(result.group).toBe('unconfigured-group');
      }
    });

    it('passes task prompt as environment variable', async () => {
      const envelope = createEventEnvelope({
        topic: 'task.triggered',
        group: 'email',
        payload: { prompt: 'Summarize the inbox' },
      });

      await dispatcher.dispatch(envelope);

      expect(deps.spawnAgent).toHaveBeenCalledWith('email', {
        CARAPACE_TASK_PROMPT: 'Summarize the inbox',
      });
    });

    it('spawns without prompt env when no prompt in payload', async () => {
      const envelope = createEventEnvelope({
        topic: 'task.triggered',
        group: 'email',
        payload: {},
      });

      await dispatcher.dispatch(envelope);

      expect(deps.spawnAgent).toHaveBeenCalledWith('email', undefined);
    });
  });

  // -----------------------------------------------------------------------
  // Other event types
  // -----------------------------------------------------------------------

  describe('other event types', () => {
    it.each(['agent.started', 'agent.completed', 'agent.error', 'plugin.ready', 'plugin.stopping'])(
      'drops %s events',
      async (topic) => {
        const envelope = createEventEnvelope({
          topic: topic as 'agent.started',
          group: 'email',
        });

        const result = await dispatcher.dispatch(envelope);

        expect(result.action).toBe('dropped');
        if (result.action === 'dropped') {
          expect(result.reason).toMatch(/no spawn/i);
        }
        expect(deps.spawnAgent).not.toHaveBeenCalled();
      },
    );
  });

  // -----------------------------------------------------------------------
  // Concurrent session policy
  // -----------------------------------------------------------------------

  describe('concurrent session policy', () => {
    it('rejects when max sessions per group is reached', async () => {
      deps = createDeps({
        getActiveSessionCount: vi.fn(() => 3),
        maxSessionsPerGroup: 3,
      });
      dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('rejected');
      if (result.action === 'rejected') {
        expect(result.group).toBe('email');
        expect(result.reason).toMatch(/concurrent.*limit|max.*session/i);
      }
      expect(deps.spawnAgent).not.toHaveBeenCalled();
    });

    it('spawns when under the session limit', async () => {
      deps = createDeps({
        getActiveSessionCount: vi.fn(() => 2),
        maxSessionsPerGroup: 3,
      });
      dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('spawned');
    });

    it('enforces session limit for task.triggered events too', async () => {
      deps = createDeps({
        getActiveSessionCount: vi.fn(() => 3),
        maxSessionsPerGroup: 3,
      });
      dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'task.triggered',
        group: 'email',
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('rejected');
      if (result.action === 'rejected') {
        expect(result.group).toBe('email');
      }
    });

    it('works with max_sessions_per_group of 1 (exclusive sessions)', async () => {
      deps = createDeps({
        getActiveSessionCount: vi.fn(() => 1),
        maxSessionsPerGroup: 1,
      });
      dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('rejected');
    });
  });

  // -----------------------------------------------------------------------
  // message.inbound payload validation
  // -----------------------------------------------------------------------

  describe('message.inbound payload validation', () => {
    it('spawns when payload passes schema validation', async () => {
      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: {
          channel: 'email',
          sender: 'user@example.com',
          content_type: 'text',
          body: 'Hello',
        },
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('spawned');
    });

    it('rejects message.inbound with missing required fields', async () => {
      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: { channel: 'email' }, // missing sender, content_type, body
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('rejected');
      if (result.action === 'rejected') {
        expect(result.reason).toMatch(/payload.*validation|validation.*failed/i);
      }
      expect(deps.spawnAgent).not.toHaveBeenCalled();
    });

    it('rejects message.inbound with extra fields', async () => {
      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: {
          channel: 'email',
          sender: 'user@example.com',
          content_type: 'text',
          body: 'Hello',
          evil: 'injected',
        },
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('rejected');
      if (result.action === 'rejected') {
        expect(result.reason).toContain('evil');
      }
      expect(deps.spawnAgent).not.toHaveBeenCalled();
    });

    it('rejects message.inbound with oversized body', async () => {
      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: {
          channel: 'email',
          sender: 'user@example.com',
          content_type: 'text',
          body: 'x'.repeat(8193),
        },
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('rejected');
      expect(deps.spawnAgent).not.toHaveBeenCalled();
    });

    it('rejects message.inbound with invalid content_type', async () => {
      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: {
          channel: 'email',
          sender: 'user@example.com',
          content_type: 'video',
          body: 'Hello',
        },
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('rejected');
      expect(deps.spawnAgent).not.toHaveBeenCalled();
    });

    it('does not validate payload for task.triggered events', async () => {
      const envelope = createEventEnvelope({
        topic: 'task.triggered',
        group: 'email',
        payload: { prompt: 'anything goes' }, // no schema validation
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('spawned');
    });

    it('calls auditLog.append when rejecting invalid payload', async () => {
      const auditAppend = vi.fn();
      deps = createDeps({ auditLog: { append: auditAppend } });
      dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: { channel: 'email' }, // missing required fields
      });

      await dispatcher.dispatch(envelope);

      expect(auditAppend).toHaveBeenCalledTimes(1);
      expect(auditAppend).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'email',
          topic: 'message.inbound',
          stage: 'payload_validation',
          outcome: 'rejected',
        }),
      );
    });

    it('does not call auditLog when payload is valid', async () => {
      const auditAppend = vi.fn();
      deps = createDeps({ auditLog: { append: auditAppend } });
      dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: {
          channel: 'email',
          sender: 'user@example.com',
          content_type: 'text',
          body: 'Hello',
        },
      });

      await dispatcher.dispatch(envelope);

      expect(auditAppend).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('drops events with empty group', async () => {
      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: '',
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('dropped');
      if (result.action === 'dropped') {
        expect(result.reason).toMatch(/empty.*group/i);
      }
    });

    it('returns error result when spawn fails', async () => {
      deps = createDeps({
        spawnAgent: vi.fn(async () => {
          throw new Error('Container runtime unavailable');
        }),
      });
      dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('error');
      if (result.action === 'error') {
        expect(result.reason).toContain('Container runtime unavailable');
      }
    });
  });
});
