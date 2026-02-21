/**
 * STREAM-15: Streaming pipeline integration tests.
 *
 * Exercises the full chain from container stdout through StreamParser,
 * ContainerOutputReader, ClaudeSessionStore, and EventDispatcher session
 * policy WITHOUT real containers or ZMQ. Transport/infrastructure layers
 * are mocked; core logic uses real implementations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'stream';
import Database from 'better-sqlite3';

import { ContainerOutputReader } from './container-output-reader.js';
import type { OutputSession } from './container-output-reader.js';
import { StreamParser } from './stream-parser.js';
import { ClaudeSessionStore, CLAUDE_SESSION_MIGRATIONS } from './claude-session-store.js';
import { EventDispatcher } from './event-dispatcher.js';
import type { EventDispatcherDeps } from './event-dispatcher.js';
import type { PluginHandler, SessionLookup } from './plugin-handler.js';
import { PROTOCOL_VERSION } from '../types/protocol.js';
import type { EventEnvelope } from '../types/protocol.js';
import { createEventEnvelope } from '../testing/factories.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** A valid message.inbound payload that passes schema validation. */
const VALID_INBOUND_PAYLOAD = {
  channel: 'email',
  sender: 'user@example.com',
  content_type: 'text',
  body: 'Hello',
};

function streamFrom(lines: string[]): NodeJS.ReadableStream {
  return Readable.from(lines.map((l) => l + '\n'));
}

function makeSession(overrides?: Partial<OutputSession>): OutputSession {
  return {
    sessionId: overrides?.sessionId ?? 'sess-001',
    group: overrides?.group ?? 'test-group',
    containerId: overrides?.containerId ?? 'ctr-abc123',
  };
}

function createInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

function createStore(
  db?: Database.Database,
  ttlMs?: number,
): { store: ClaudeSessionStore; db: Database.Database } {
  const database = db ?? createInMemoryDb();
  const store = ClaudeSessionStore.create(database, CLAUDE_SESSION_MIGRATIONS, ttlMs);
  return { store, db: database };
}

/** Collects published envelopes and session saves from ContainerOutputReader. */
function createCollectingDeps() {
  const published: EventEnvelope[] = [];
  const saved: Array<{ group: string; claudeSessionId: string }> = [];

  return {
    deps: {
      eventBus: {
        async publish(envelope: EventEnvelope): Promise<void> {
          published.push(envelope);
        },
      },
      claudeSessionStore: {
        save(group: string, claudeSessionId: string): void {
          saved.push({ group, claudeSessionId });
        },
      },
    },
    published,
    saved,
  };
}

// ---------------------------------------------------------------------------
// Stream-json line builders (simulated Claude Code output)
// ---------------------------------------------------------------------------

function systemLine(sessionId: string, model = 'claude-sonnet-4-6-20250514') {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model,
  });
}

function textChunkLine(text: string) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

function toolCallLine(name: string, input: Record<string, unknown>) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name, id: `toolu_${Date.now()}`, input }],
    },
  });
}

function toolResultLine(
  name: string,
  content: string,
  opts?: { isError?: boolean; durationMs?: number },
) {
  return JSON.stringify({
    type: 'tool_result',
    tool_use_id: `toolu_${Date.now()}`,
    name,
    content,
    is_error: opts?.isError ?? false,
    duration_ms: opts?.durationMs ?? 100,
  });
}

function resultLine(sessionId: string, opts?: { isError?: boolean }) {
  return JSON.stringify({
    type: 'result',
    result: 'Task completed.',
    session_id: sessionId,
    is_error: opts?.isError ?? false,
    input_tokens: 500,
    output_tokens: 200,
    cost_usd: 0.0035,
  });
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Streaming pipeline integration', () => {
  // -------------------------------------------------------------------------
  // 1. Full streaming pipeline: stdout → events
  // -------------------------------------------------------------------------

  describe('full pipeline: stdout → parsed events on EventBus', () => {
    it('publishes all event types in order through real ContainerOutputReader + StreamParser', async () => {
      const { deps, published, saved } = createCollectingDeps();
      const reader = new ContainerOutputReader(deps);

      const lines = [
        systemLine(VALID_UUID),
        textChunkLine('Hello, world!'),
        toolCallLine('Bash', { command: 'ls -la' }),
        toolResultLine('Bash', 'file1.ts\nfile2.ts', { durationMs: 42 }),
        resultLine(VALID_UUID),
      ];

      await reader.start(streamFrom(lines), makeSession({ group: 'email' }));

      // All 5 events published
      expect(published).toHaveLength(5);

      // Correct topic ordering
      const topics = published.map((e) => e.topic);
      expect(topics).toEqual([
        'response.system',
        'response.chunk',
        'response.tool_call',
        'response.tool_result',
        'response.end',
      ]);

      // response.system payload
      expect(published[0]!.payload).toMatchObject({
        claudeSessionId: VALID_UUID,
        model: 'claude-sonnet-4-6-20250514',
      });

      // response.chunk payload
      expect(published[1]!.payload).toMatchObject({ text: 'Hello, world!' });

      // response.tool_call payload
      expect(published[2]!.payload).toMatchObject({
        toolName: 'Bash',
        toolInput: { command: 'ls -la' },
      });

      // response.tool_result payload (metadata only)
      expect(published[3]!.payload).toMatchObject({
        toolName: 'Bash',
        success: true,
        durationMs: 42,
      });

      // response.end payload
      expect(published[4]!.payload).toMatchObject({
        claudeSessionId: VALID_UUID,
        exitCode: 0,
      });

      // Session ID saved from both system and end events
      expect(saved).toHaveLength(2);
      expect(saved[0]).toEqual({ group: 'email', claudeSessionId: VALID_UUID });
      expect(saved[1]).toEqual({ group: 'email', claudeSessionId: VALID_UUID });
    });

    it('constructs valid EventEnvelopes with core identity fields', async () => {
      const { deps, published } = createCollectingDeps();
      const reader = new ContainerOutputReader(deps);

      await reader.start(
        streamFrom([textChunkLine('test')]),
        makeSession({ group: 'email', containerId: 'ctr-xyz' }),
      );

      expect(published).toHaveLength(1);
      const envelope = published[0]!;
      expect(envelope.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(envelope.version).toBe(PROTOCOL_VERSION);
      expect(envelope.type).toBe('event');
      expect(envelope.source).toBe('ctr-xyz');
      expect(envelope.correlation).toBeNull();
      expect(envelope.group).toBe('email');
      expect(envelope.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('maintains monotonic sequence numbers across events', async () => {
      const { deps, published } = createCollectingDeps();
      const reader = new ContainerOutputReader(deps);

      const lines = [
        systemLine(VALID_UUID),
        textChunkLine('one'),
        textChunkLine('two'),
        resultLine(VALID_UUID),
      ];

      await reader.start(streamFrom(lines), makeSession());

      const seqs = published.map((e) => (e.payload as Record<string, unknown>)['seq'] as number);
      // Sequences should be strictly increasing
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Session persistence across streams
  // -------------------------------------------------------------------------

  describe('session persistence across streams', () => {
    let store: ClaudeSessionStore;
    let db: Database.Database;

    beforeEach(() => {
      ({ store, db } = createStore());
    });

    afterEach(() => {
      store.close();
    });

    it('saves session ID from first stream and retrieves it', async () => {
      const reader = new ContainerOutputReader({
        eventBus: { publish: async () => {} },
        claudeSessionStore: store,
      });

      await reader.start(
        streamFrom([systemLine(VALID_UUID), resultLine(VALID_UUID)]),
        makeSession({ group: 'email' }),
      );

      const latest = store.getLatest('email');
      expect(latest).toBe(VALID_UUID);
    });

    it('second stream updates the session for the same group', async () => {
      const reader = new ContainerOutputReader({
        eventBus: { publish: async () => {} },
        claudeSessionStore: store,
      });

      // First stream
      await reader.start(
        streamFrom([systemLine(VALID_UUID), resultLine(VALID_UUID)]),
        makeSession({ group: 'email' }),
      );

      // Backdate first session so second stream is clearly newer
      // (SQLite datetime('now') has second-level granularity)
      db.prepare(
        `UPDATE claude_sessions SET last_used_at = datetime('now', '-60 seconds')
         WHERE group_name = 'email'`,
      ).run();

      // Second stream with different session ID
      await reader.start(
        streamFrom([systemLine(VALID_UUID_2), resultLine(VALID_UUID_2)]),
        makeSession({ group: 'email' }),
      );

      // getLatest should return the most recent
      const latest = store.getLatest('email');
      expect(latest).toBe(VALID_UUID_2);

      // Both sessions should exist in the store
      const all = store.list('email');
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.claudeSessionId)).toContain(VALID_UUID);
      expect(all.map((s) => s.claudeSessionId)).toContain(VALID_UUID_2);
    });

    it('isolates sessions between different groups', async () => {
      const reader = new ContainerOutputReader({
        eventBus: { publish: async () => {} },
        claudeSessionStore: store,
      });

      await reader.start(streamFrom([systemLine(VALID_UUID)]), makeSession({ group: 'email' }));

      await reader.start(streamFrom([systemLine(VALID_UUID_2)]), makeSession({ group: 'slack' }));

      expect(store.getLatest('email')).toBe(VALID_UUID);
      expect(store.getLatest('slack')).toBe(VALID_UUID_2);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Session policy: resume flow
  // -------------------------------------------------------------------------

  describe('session policy: resume', () => {
    it('passes CARAPACE_RESUME_SESSION_ID when latest session exists', async () => {
      const spawnAgent = vi.fn(async () => 'new-session');
      const deps: EventDispatcherDeps = {
        getActiveSessionCount: () => 0,
        spawnAgent,
        maxSessionsPerGroup: 5,
        configuredGroups: new Set(['email']),
        getSessionPolicy: () => 'resume',
        getLatestSession: () => 'claude-sess-abc',
      };
      const dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('spawned');
      expect(spawnAgent).toHaveBeenCalledWith('email', {
        CARAPACE_RESUME_SESSION_ID: 'claude-sess-abc',
      });
    });

    it('spawns fresh when no previous session exists', async () => {
      const spawnAgent = vi.fn(async () => 'new-session');
      const deps: EventDispatcherDeps = {
        getActiveSessionCount: () => 0,
        spawnAgent,
        maxSessionsPerGroup: 5,
        configuredGroups: new Set(['email']),
        getSessionPolicy: () => 'resume',
        getLatestSession: () => null,
      };
      const dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('spawned');
      // No resume ID → no env
      expect(spawnAgent).toHaveBeenCalledWith('email', undefined);
    });

    it('integrates with real ClaudeSessionStore for resume lookup', async () => {
      // Real store with a saved session
      const { store } = createStore();
      store.save('email', VALID_UUID);

      const spawnAgent = vi.fn(async () => 'new-session');
      const deps: EventDispatcherDeps = {
        getActiveSessionCount: () => 0,
        spawnAgent,
        maxSessionsPerGroup: 5,
        configuredGroups: new Set(['email']),
        getSessionPolicy: () => 'resume',
        getLatestSession: (group: string) => store.getLatest(group),
      };
      const dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      await dispatcher.dispatch(envelope);

      expect(spawnAgent).toHaveBeenCalledWith('email', {
        CARAPACE_RESUME_SESSION_ID: VALID_UUID,
      });

      store.close();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Session policy: explicit flow
  // -------------------------------------------------------------------------

  describe('session policy: explicit', () => {
    it('uses session ID from plugin resolveSession handler', async () => {
      const resolveSession = vi.fn(async () => 'plugin-chosen-session');
      const handler: PluginHandler = {
        initialize: async () => {},
        handleToolInvocation: async () => ({ ok: true, result: {} }),
        shutdown: async () => {},
        resolveSession,
      };
      const mockLookup: SessionLookup = {
        latest: async () => null,
        find: async () => [],
      };

      const spawnAgent = vi.fn(async () => 'new-session');
      const deps: EventDispatcherDeps = {
        getActiveSessionCount: () => 0,
        spawnAgent,
        maxSessionsPerGroup: 5,
        configuredGroups: new Set(['email']),
        getSessionPolicy: () => 'explicit',
        getPluginHandler: () => handler,
        createSessionLookup: () => mockLookup,
      };
      const dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      await dispatcher.dispatch(envelope);

      expect(resolveSession).toHaveBeenCalledWith(envelope, mockLookup);
      expect(spawnAgent).toHaveBeenCalledWith('email', {
        CARAPACE_RESUME_SESSION_ID: 'plugin-chosen-session',
      });
    });

    it('falls back to fresh when resolveSession returns null', async () => {
      const resolveSession = vi.fn(async () => null);
      const handler: PluginHandler = {
        initialize: async () => {},
        handleToolInvocation: async () => ({ ok: true, result: {} }),
        shutdown: async () => {},
        resolveSession,
      };

      const spawnAgent = vi.fn(async () => 'new-session');
      const deps: EventDispatcherDeps = {
        getActiveSessionCount: () => 0,
        spawnAgent,
        maxSessionsPerGroup: 5,
        configuredGroups: new Set(['email']),
        getSessionPolicy: () => 'explicit',
        getPluginHandler: () => handler,
        createSessionLookup: () => ({
          latest: async () => null,
          find: async () => [],
        }),
      };
      const dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      await dispatcher.dispatch(envelope);

      expect(spawnAgent).toHaveBeenCalledWith('email', undefined);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Session policy: fresh flow (default)
  // -------------------------------------------------------------------------

  describe('session policy: fresh (default)', () => {
    it('never passes resume session ID when no policy deps exist', async () => {
      const spawnAgent = vi.fn(async () => 'new-session');
      const deps: EventDispatcherDeps = {
        getActiveSessionCount: () => 0,
        spawnAgent,
        maxSessionsPerGroup: 5,
        configuredGroups: new Set(['email']),
        // No session policy deps → defaults to fresh
      };
      const dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      await dispatcher.dispatch(envelope);

      // No CARAPACE_RESUME_SESSION_ID in env
      expect(spawnAgent).toHaveBeenCalledWith('email', undefined);
    });

    it('never passes resume session ID when policy is explicitly fresh', async () => {
      const spawnAgent = vi.fn(async () => 'new-session');
      const deps: EventDispatcherDeps = {
        getActiveSessionCount: () => 0,
        spawnAgent,
        maxSessionsPerGroup: 5,
        configuredGroups: new Set(['email']),
        getSessionPolicy: () => 'fresh',
        getLatestSession: () => VALID_UUID, // exists but should be ignored
      };
      const dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      await dispatcher.dispatch(envelope);

      expect(spawnAgent).toHaveBeenCalledWith('email', undefined);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Error resilience: malformed JSON in stream
  // -------------------------------------------------------------------------

  describe('error resilience: malformed JSON in stream', () => {
    it('publishes response.error for bad lines and continues processing good lines', async () => {
      const { deps, published } = createCollectingDeps();
      const reader = new ContainerOutputReader(deps);

      const lines = [
        '{not valid json}',
        textChunkLine('After first error'),
        'totally broken',
        textChunkLine('After second error'),
      ];

      await reader.start(streamFrom(lines), makeSession());

      expect(published).toHaveLength(4);

      // Error events for malformed lines
      expect(published[0]!.topic).toBe('response.error');
      expect(published[0]!.payload).toMatchObject({
        reason: expect.stringMatching(/malformed|parse/i),
      });

      // Good line after first error
      expect(published[1]!.topic).toBe('response.chunk');
      expect(published[1]!.payload).toMatchObject({ text: 'After first error' });

      // Second error
      expect(published[2]!.topic).toBe('response.error');

      // Good line after second error
      expect(published[3]!.topic).toBe('response.chunk');
      expect(published[3]!.payload).toMatchObject({ text: 'After second error' });
    });

    it('stream does not crash on a mix of valid, invalid, and empty lines', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { deps, published } = createCollectingDeps();
      const reader = new ContainerOutputReader(deps);

      const lines = [
        '',
        '   ',
        '{bad}',
        systemLine(VALID_UUID),
        'also broken!',
        textChunkLine('hello'),
        resultLine(VALID_UUID),
      ];

      await reader.start(streamFrom(lines), makeSession());

      // Empty/whitespace lines produce null from StreamParser → skipped
      // {bad} → response.error
      // system → response.system
      // also broken! → response.error
      // text → response.chunk
      // result → response.end
      const topics = published.map((e) => e.topic);
      expect(topics).toEqual([
        'response.error',
        'response.system',
        'response.error',
        'response.chunk',
        'response.end',
      ]);

      vi.restoreAllMocks();
    });
  });

  // -------------------------------------------------------------------------
  // 7. Security: tool_result metadata only
  // -------------------------------------------------------------------------

  describe('security: tool_result contains metadata only', () => {
    it('does NOT expose tool result content in published event', async () => {
      const { deps, published } = createCollectingDeps();
      const reader = new ContainerOutputReader(deps);

      const sensitiveContent = 'SECRET_API_KEY=sk-12345\nPASSWORD=hunter2';
      const line = toolResultLine('Read', sensitiveContent, { durationMs: 55 });

      await reader.start(streamFrom([line]), makeSession());

      expect(published).toHaveLength(1);
      const payload = published[0]!.payload as Record<string, unknown>;

      // Should have metadata
      expect(payload['toolName']).toBe('Read');
      expect(payload['success']).toBe(true);
      expect(payload['durationMs']).toBe(55);

      // The top-level payload should NOT have `content` field
      // (content lives only inside raw, which is the full stream-json object)
      expect(payload['content']).toBeUndefined();
      expect(payload['text']).toBeUndefined();

      // Verify the payload type is response.tool_result (metadata only)
      expect(published[0]!.topic).toBe('response.tool_result');
    });

    it('correctly reports failed tool results', async () => {
      const { deps, published } = createCollectingDeps();
      const reader = new ContainerOutputReader(deps);

      const line = toolResultLine('Bash', 'Command failed: permission denied', {
        isError: true,
        durationMs: 10,
      });

      await reader.start(streamFrom([line]), makeSession());

      expect(published).toHaveLength(1);
      const payload = published[0]!.payload as Record<string, unknown>;
      expect(payload['toolName']).toBe('Bash');
      expect(payload['success']).toBe(false);
      expect(payload['durationMs']).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // 8. ClaudeSessionStore TTL
  // -------------------------------------------------------------------------

  describe('ClaudeSessionStore TTL expiry', () => {
    it('getLatest returns null for expired sessions', () => {
      // 1-second TTL
      const { store, db } = createStore(undefined, 1000);

      store.save('email', VALID_UUID);

      // Backdate to 5 seconds ago (beyond 1-second TTL)
      db.prepare(
        `UPDATE claude_sessions SET last_used_at = datetime('now', '-5 seconds')
         WHERE claude_session_id = ?`,
      ).run(VALID_UUID);

      expect(store.getLatest('email')).toBeNull();

      store.close();
    });

    it('getLatest returns session within TTL', () => {
      // 1-hour TTL
      const { store } = createStore(undefined, 3600 * 1000);

      store.save('email', VALID_UUID);

      // No backdating — session is fresh
      expect(store.getLatest('email')).toBe(VALID_UUID);

      store.close();
    });

    it('expired sessions still appear in list() for audit purposes', () => {
      const { store, db } = createStore(undefined, 1000);

      store.save('email', VALID_UUID);

      // Backdate past TTL
      db.prepare(
        `UPDATE claude_sessions SET last_used_at = datetime('now', '-10 seconds')
         WHERE claude_session_id = ?`,
      ).run(VALID_UUID);

      // getLatest returns null (expired)
      expect(store.getLatest('email')).toBeNull();

      // list() still returns the session
      const all = store.list('email');
      expect(all).toHaveLength(1);
      expect(all[0]!.claudeSessionId).toBe(VALID_UUID);

      store.close();
    });

    it('resume policy falls back to fresh when session is expired', async () => {
      const { store, db } = createStore(undefined, 1000);
      store.save('email', VALID_UUID);

      // Expire the session
      db.prepare(
        `UPDATE claude_sessions SET last_used_at = datetime('now', '-5 seconds')
         WHERE claude_session_id = ?`,
      ).run(VALID_UUID);

      const spawnAgent = vi.fn(async () => 'new-session');
      const dispatcherDeps: EventDispatcherDeps = {
        getActiveSessionCount: () => 0,
        spawnAgent,
        maxSessionsPerGroup: 5,
        configuredGroups: new Set(['email']),
        getSessionPolicy: () => 'resume',
        getLatestSession: (group: string) => store.getLatest(group),
      };
      const dispatcher = new EventDispatcher(dispatcherDeps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      await dispatcher.dispatch(envelope);

      // Session expired → no resume ID → fresh spawn
      expect(spawnAgent).toHaveBeenCalledWith('email', undefined);

      store.close();
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end: streaming → session store → dispatcher resume
  // -------------------------------------------------------------------------

  describe('end-to-end: stream → persist → resume', () => {
    it('session ID from stream is persisted and used for subsequent resume dispatch', async () => {
      // Real session store
      const { store } = createStore();

      // Phase 1: Stream output saves session ID
      const reader = new ContainerOutputReader({
        eventBus: { publish: async () => {} },
        claudeSessionStore: store,
      });

      await reader.start(
        streamFrom([systemLine(VALID_UUID), resultLine(VALID_UUID)]),
        makeSession({ group: 'email' }),
      );

      // Verify saved
      expect(store.getLatest('email')).toBe(VALID_UUID);

      // Phase 2: Dispatch with resume policy picks up the saved session
      const spawnAgent = vi.fn(async () => 'resumed-session');
      const dispatcher = new EventDispatcher({
        getActiveSessionCount: () => 0,
        spawnAgent,
        maxSessionsPerGroup: 5,
        configuredGroups: new Set(['email']),
        getSessionPolicy: () => 'resume',
        getLatestSession: (group: string) => store.getLatest(group),
      });

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('spawned');
      expect(spawnAgent).toHaveBeenCalledWith('email', {
        CARAPACE_RESUME_SESSION_ID: VALID_UUID,
      });

      store.close();
    });
  });
});
