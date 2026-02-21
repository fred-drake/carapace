import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventDispatcher } from './event-dispatcher.js';
import type { EventDispatcherDeps, DispatchResult } from './event-dispatcher.js';
import type { PluginHandler, SessionLookup } from './plugin-handler.js';
import { createEventEnvelope } from '../testing/factories.js';
import { configureLogging, resetLogging, type LogEntry, type LogSink } from './logger.js';

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

/** Create a minimal PluginHandler for testing. */
function createMockHandler(overrides?: Partial<PluginHandler>): PluginHandler {
  return {
    initialize: async () => {},
    handleToolInvocation: async () => ({ ok: true, result: {} }),
    shutdown: async () => {},
    ...overrides,
  };
}

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

  // -----------------------------------------------------------------------
  // Session policy
  // -----------------------------------------------------------------------

  describe('session policy', () => {
    describe('fresh policy (default)', () => {
      it('spawns without resume when no policy is configured', async () => {
        deps = createDeps();
        dispatcher = new EventDispatcher(deps);

        const envelope = createEventEnvelope({
          topic: 'task.triggered',
          group: 'email',
          payload: { prompt: 'test' },
        });

        await dispatcher.dispatch(envelope);

        expect(deps.spawnAgent).toHaveBeenCalledWith('email', {
          CARAPACE_TASK_PROMPT: 'test',
        });
      });

      it('spawns without resume when policy is explicitly fresh', async () => {
        deps = createDeps({
          getSessionPolicy: vi.fn(() => 'fresh'),
        });
        dispatcher = new EventDispatcher(deps);

        const envelope = createEventEnvelope({
          topic: 'message.inbound',
          group: 'email',
          payload: VALID_INBOUND_PAYLOAD,
        });

        await dispatcher.dispatch(envelope);

        // No CARAPACE_RESUME_SESSION_ID in the env
        expect(deps.spawnAgent).toHaveBeenCalledWith('email', undefined);
      });
    });

    describe('resume policy', () => {
      it('includes resume session ID in env when latest session exists', async () => {
        deps = createDeps({
          getSessionPolicy: vi.fn(() => 'resume'),
          getLatestSession: vi.fn(() => 'claude-sess-abc-123'),
        });
        dispatcher = new EventDispatcher(deps);

        const envelope = createEventEnvelope({
          topic: 'message.inbound',
          group: 'email',
          payload: VALID_INBOUND_PAYLOAD,
        });

        await dispatcher.dispatch(envelope);

        expect(deps.getLatestSession).toHaveBeenCalledWith('email');
        expect(deps.spawnAgent).toHaveBeenCalledWith('email', {
          CARAPACE_RESUME_SESSION_ID: 'claude-sess-abc-123',
        });
      });

      it('spawns fresh when no latest session is found', async () => {
        deps = createDeps({
          getSessionPolicy: vi.fn(() => 'resume'),
          getLatestSession: vi.fn(() => null),
        });
        dispatcher = new EventDispatcher(deps);

        const envelope = createEventEnvelope({
          topic: 'message.inbound',
          group: 'email',
          payload: VALID_INBOUND_PAYLOAD,
        });

        await dispatcher.dispatch(envelope);

        expect(deps.getLatestSession).toHaveBeenCalledWith('email');
        expect(deps.spawnAgent).toHaveBeenCalledWith('email', undefined);
      });

      it('merges resume session ID with task prompt env', async () => {
        deps = createDeps({
          getSessionPolicy: vi.fn(() => 'resume'),
          getLatestSession: vi.fn(() => 'claude-sess-xyz'),
        });
        dispatcher = new EventDispatcher(deps);

        const envelope = createEventEnvelope({
          topic: 'task.triggered',
          group: 'email',
          payload: { prompt: 'Check inbox' },
        });

        await dispatcher.dispatch(envelope);

        expect(deps.spawnAgent).toHaveBeenCalledWith('email', {
          CARAPACE_TASK_PROMPT: 'Check inbox',
          CARAPACE_RESUME_SESSION_ID: 'claude-sess-xyz',
        });
      });
    });

    describe('explicit policy', () => {
      it('calls plugin resolveSession and uses returned session ID', async () => {
        const resolveSession = vi.fn(async () => 'plugin-chosen-sess');
        const handler = createMockHandler({ resolveSession });
        const mockLookup: SessionLookup = {
          latest: async () => null,
          find: async () => [],
        };

        deps = createDeps({
          getSessionPolicy: vi.fn(() => 'explicit'),
          getPluginHandler: vi.fn(() => handler),
          createSessionLookup: vi.fn(() => mockLookup),
        });
        dispatcher = new EventDispatcher(deps);

        const envelope = createEventEnvelope({
          topic: 'message.inbound',
          group: 'email',
          payload: VALID_INBOUND_PAYLOAD,
        });

        await dispatcher.dispatch(envelope);

        expect(resolveSession).toHaveBeenCalledWith(envelope, mockLookup);
        expect(deps.spawnAgent).toHaveBeenCalledWith('email', {
          CARAPACE_RESUME_SESSION_ID: 'plugin-chosen-sess',
        });
      });

      it('spawns fresh when resolveSession returns null', async () => {
        const resolveSession = vi.fn(async () => null);
        const handler = createMockHandler({ resolveSession });

        deps = createDeps({
          getSessionPolicy: vi.fn(() => 'explicit'),
          getPluginHandler: vi.fn(() => handler),
          createSessionLookup: vi.fn(() => ({
            latest: async () => null,
            find: async () => [],
          })),
        });
        dispatcher = new EventDispatcher(deps);

        const envelope = createEventEnvelope({
          topic: 'message.inbound',
          group: 'email',
          payload: VALID_INBOUND_PAYLOAD,
        });

        await dispatcher.dispatch(envelope);

        expect(deps.spawnAgent).toHaveBeenCalledWith('email', undefined);
      });

      it('falls back to fresh when handler has no resolveSession', async () => {
        const handler = createMockHandler(); // no resolveSession

        deps = createDeps({
          getSessionPolicy: vi.fn(() => 'explicit'),
          getPluginHandler: vi.fn(() => handler),
          createSessionLookup: vi.fn(() => ({
            latest: async () => null,
            find: async () => [],
          })),
        });
        dispatcher = new EventDispatcher(deps);

        const envelope = createEventEnvelope({
          topic: 'message.inbound',
          group: 'email',
          payload: VALID_INBOUND_PAYLOAD,
        });

        await dispatcher.dispatch(envelope);

        expect(deps.spawnAgent).toHaveBeenCalledWith('email', undefined);
      });

      it('falls back to fresh when no handler is found for group', async () => {
        deps = createDeps({
          getSessionPolicy: vi.fn(() => 'explicit'),
          getPluginHandler: vi.fn(() => undefined),
          createSessionLookup: vi.fn(() => ({
            latest: async () => null,
            find: async () => [],
          })),
        });
        dispatcher = new EventDispatcher(deps);

        const envelope = createEventEnvelope({
          topic: 'message.inbound',
          group: 'email',
          payload: VALID_INBOUND_PAYLOAD,
        });

        await dispatcher.dispatch(envelope);

        expect(deps.spawnAgent).toHaveBeenCalledWith('email', undefined);
      });

      it('returns error when resolveSession throws', async () => {
        const resolveSession = vi.fn(async () => {
          throw new Error('Plugin resolver crashed');
        });
        const handler = createMockHandler({ resolveSession });

        deps = createDeps({
          getSessionPolicy: vi.fn(() => 'explicit'),
          getPluginHandler: vi.fn(() => handler),
          createSessionLookup: vi.fn(() => ({
            latest: async () => null,
            find: async () => [],
          })),
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
          expect(result.reason).toContain('Plugin resolver crashed');
        }
      });

      it('merges explicit session ID with task prompt env', async () => {
        const resolveSession = vi.fn(async () => 'explicit-sess');
        const handler = createMockHandler({ resolveSession });

        deps = createDeps({
          getSessionPolicy: vi.fn(() => 'explicit'),
          getPluginHandler: vi.fn(() => handler),
          createSessionLookup: vi.fn(() => ({
            latest: async () => null,
            find: async () => [],
          })),
        });
        dispatcher = new EventDispatcher(deps);

        const envelope = createEventEnvelope({
          topic: 'task.triggered',
          group: 'email',
          payload: { prompt: 'Process inbox' },
        });

        await dispatcher.dispatch(envelope);

        expect(deps.spawnAgent).toHaveBeenCalledWith('email', {
          CARAPACE_TASK_PROMPT: 'Process inbox',
          CARAPACE_RESUME_SESSION_ID: 'explicit-sess',
        });
      });
    });

    describe('security — never trust wire session IDs', () => {
      it('ignores session_id field in event payload', async () => {
        deps = createDeps({
          getSessionPolicy: vi.fn(() => 'fresh'),
        });
        dispatcher = new EventDispatcher(deps);

        const envelope = createEventEnvelope({
          topic: 'task.triggered',
          group: 'email',
          payload: {
            prompt: 'test',
            session_id: 'injected-session-from-wire',
          },
        });

        await dispatcher.dispatch(envelope);

        // The env should NOT contain the injected session_id
        const spawnCall = (deps.spawnAgent as ReturnType<typeof vi.fn>).mock.calls[0]!;
        const env = spawnCall[1] as Record<string, string> | undefined;
        if (env) {
          expect(env['CARAPACE_RESUME_SESSION_ID']).toBeUndefined();
        }
      });
    });
  });

  // -----------------------------------------------------------------------
  // Logging
  // -----------------------------------------------------------------------

  describe('logging', () => {
    let logEntries: LogEntry[];

    beforeEach(() => {
      logEntries = [];
      const logSink: LogSink = (entry) => logEntries.push(entry);
      configureLogging({ level: 'debug', sink: logSink });
    });

    afterEach(() => {
      resetLogging();
    });

    it('logs agent spawned on successful dispatch', async () => {
      deps = createDeps();
      dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });
      await dispatcher.dispatch(envelope);

      const spawnLog = logEntries.find((e) => e.msg === 'agent spawned');
      expect(spawnLog).toBeDefined();
      expect(spawnLog!.group).toBe('email');
      expect(spawnLog!.session).toBe('session-123');
    });

    it('logs event rejected on session limit', async () => {
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
      await dispatcher.dispatch(envelope);

      const rejectLog = logEntries.find(
        (e) => e.msg === 'event rejected' && e.meta?.reason === 'session limit',
      );
      expect(rejectLog).toBeDefined();
      expect(rejectLog!.group).toBe('email');
    });

    it('logs spawn failure at error level', async () => {
      deps = createDeps({
        spawnAgent: vi.fn(async () => {
          throw new Error('Runtime crashed');
        }),
      });
      dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });
      await dispatcher.dispatch(envelope);

      const errLog = logEntries.find((e) => e.msg === 'spawn failed');
      expect(errLog).toBeDefined();
      expect(errLog!.level).toBe('error');
      expect(errLog!.group).toBe('email');
    });

    it('logs dispatch received for every event', async () => {
      deps = createDeps();
      dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'agent.started',
        group: 'email',
      });
      await dispatcher.dispatch(envelope);

      const recvLog = logEntries.find((e) => e.msg === 'dispatch received');
      expect(recvLog).toBeDefined();
      expect(recvLog!.topic).toBe('agent.started');
    });

    it('logs session policy resolution', async () => {
      deps = createDeps({
        getSessionPolicy: vi.fn(() => 'resume'),
        getLatestSession: vi.fn(() => 'claude-sess-abc'),
      });
      dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });
      await dispatcher.dispatch(envelope);

      const policyLog = logEntries.find((e) => e.msg === 'session policy resolved');
      expect(policyLog).toBeDefined();
      expect(policyLog!.meta?.policy).toBe('resume');
      expect(policyLog!.meta?.resumeSessionId).toBe('claude-sess-abc');
    });
  });
});
