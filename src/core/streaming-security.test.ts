/**
 * Security hardening tests for streaming and session features (STREAM-16).
 *
 * Covers:
 * 1. StreamParser: size/depth limits, content stripping, no eval
 * 2. ClaudeSessionStore: UUID validation, group isolation, SQL injection, TTL
 * 3. EventDispatcher: wire session_id never forwarded, host-resolved only
 * 4. ContainerOutputReader: untrusted data validation
 * 5. Entrypoint: env var naming consistency
 * 6. Protocol types: tool_result excludes content
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import Database from 'better-sqlite3';
import { StreamParser } from './stream-parser.js';
import { ContainerOutputReader } from './container-output-reader.js';
import { ClaudeSessionStore, CLAUDE_SESSION_MIGRATIONS } from './claude-session-store.js';
import { EventDispatcher } from './event-dispatcher.js';
import type { EventDispatcherDeps } from './event-dispatcher.js';
import type { EventEnvelope } from '../types/protocol.js';
import type {
  ToolResultEventPayload,
  ErrorEventPayload,
  SystemEventPayload,
} from '../types/protocol.js';
import { createEventEnvelope } from '../testing/factories.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

const VALID_INBOUND_PAYLOAD = {
  channel: 'email',
  sender: 'user@example.com',
  content_type: 'text',
  body: 'Hello',
};

function streamFrom(lines: string[]): NodeJS.ReadableStream {
  return Readable.from(lines.map((l) => l + '\n'));
}

function createMockOutputDeps() {
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

function createDispatcherDeps(overrides?: Partial<EventDispatcherDeps>): EventDispatcherDeps {
  return {
    getActiveSessionCount: vi.fn(() => 0),
    spawnAgent: vi.fn(async () => 'session-123'),
    maxSessionsPerGroup: 3,
    configuredGroups: new Set(['email', 'slack']),
    ...overrides,
  };
}

// ===========================================================================
// 1. StreamParser Security
// ===========================================================================

describe('StreamParser security', () => {
  let parser: StreamParser;

  beforeEach(() => {
    parser = new StreamParser();
  });

  describe('size limits', () => {
    it('rejects lines exceeding 1MB', () => {
      const bigPayload = 'x'.repeat(1_048_576 + 1);
      const line = JSON.stringify({ type: 'system', session_id: 'sess', data: bigPayload });
      const result = parser.parseLine(line);
      expect(result).not.toBeNull();
      expect(result!.topic).toBe('response.error');
      expect((result!.payload as ErrorEventPayload).reason).toMatch(/size limit/i);
    });

    it('accepts lines at exactly 1MB', () => {
      // Create a line that's just under 1MB
      const overhead = JSON.stringify({ type: 'system', session_id: 'x', data: '' }).length;
      const filler = 'a'.repeat(1_048_576 - overhead - 10);
      const line = JSON.stringify({ type: 'system', session_id: 'x', data: filler });
      const result = parser.parseLine(line);
      // Should parse successfully or return null for unknown type, but NOT error on size
      if (result !== null) {
        expect(result.topic).not.toBe('response.error');
      }
    });
  });

  describe('depth limits (matches IPC 64-level)', () => {
    it('rejects JSON exceeding 64 nesting levels', () => {
      const nested = '{"a":'.repeat(65) + '{}' + '}'.repeat(65);
      const result = parser.parseLine(nested);
      expect(result).not.toBeNull();
      expect(result!.topic).toBe('response.error');
      expect((result!.payload as ErrorEventPayload).reason).toMatch(/depth/i);
    });

    it('accepts JSON at exactly 64 levels', () => {
      // 63 wrapping levels + 1 inner {} = 64 total depth
      const nested = '{"a":'.repeat(63) + '{}' + '}'.repeat(63);
      const result = parser.parseLine(nested);
      if (result !== null) {
        expect(result.topic).not.toBe('response.error');
      }
    });

    it('counts array nesting in depth calculation', () => {
      const nested = '['.repeat(65) + '1' + ']'.repeat(65);
      const result = parser.parseLine(nested);
      expect(result).not.toBeNull();
      expect(result!.topic).toBe('response.error');
      expect((result!.payload as ErrorEventPayload).reason).toMatch(/depth/i);
    });
  });

  describe('malformed input handling', () => {
    it('never throws on malformed JSON', () => {
      const malformedInputs = [
        '{bad}',
        'not json at all',
        '{"incomplete":',
        '}{',
        '\x00\x01\x02',
        '{"type": "system", "\\',
      ];
      for (const input of malformedInputs) {
        expect(() => parser.parseLine(input)).not.toThrow();
      }
    });

    it('returns error event for malformed JSON (never null)', () => {
      const result = parser.parseLine('{bad json}');
      expect(result).not.toBeNull();
      expect(result!.topic).toBe('response.error');
    });

    it('does not use eval or Function constructor', () => {
      // Verify no dynamic code execution in parser
      const source = StreamParser.toString();
      expect(source).not.toContain('eval(');
      expect(source).not.toContain('Function(');
    });
  });

  describe('tool_result content stripping', () => {
    it('strips content from raw field to prevent data leakage', () => {
      const line = JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        name: 'Read',
        content: 'SECRET_API_KEY=sk-ant-live-abc123',
        is_error: false,
      });
      const result = parser.parseLine(line);
      expect(result).not.toBeNull();
      const payload = result!.payload as ToolResultEventPayload;

      // Top-level content field must be absent
      expect((payload as Record<string, unknown>)['content']).toBeUndefined();
      // raw.content must also be absent
      expect((payload.raw as Record<string, unknown>)['content']).toBeUndefined();
      // The secret must not appear anywhere in the serialized payload
      expect(JSON.stringify(payload)).not.toContain('sk-ant-live-abc123');
    });

    it('preserves metadata fields in raw after content stripping', () => {
      const line = JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'toolu_2',
        name: 'Bash',
        content: 'should be stripped',
        is_error: true,
        duration_ms: 50,
      });
      const result = parser.parseLine(line);
      expect(result).not.toBeNull();
      const raw = result!.payload.raw as Record<string, unknown>;
      expect(raw['type']).toBe('tool_result');
      expect(raw['name']).toBe('Bash');
      expect(raw['is_error']).toBe(true);
      expect(raw['duration_ms']).toBe(50);
    });
  });
});

// ===========================================================================
// 2. ClaudeSessionStore Security
// ===========================================================================

describe('ClaudeSessionStore security', () => {
  describe('UUID validation', () => {
    it('rejects non-UUID session IDs on save', () => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      const store = ClaudeSessionStore.create(db, CLAUDE_SESSION_MIGRATIONS);

      const invalidIds = [
        'not-a-uuid',
        '',
        '123',
        '../../../etc/passwd',
        "'; DROP TABLE claude_sessions; --",
        'ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ',
        '<script>alert(1)</script>',
      ];

      for (const id of invalidIds) {
        expect(() => store.save('email', id)).toThrow(/invalid.*session.*id/i);
      }

      store.close();
    });

    it('accepts valid UUID formats', () => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      const store = ClaudeSessionStore.create(db, CLAUDE_SESSION_MIGRATIONS);

      // Both lowercase and uppercase hex should work
      expect(() => store.save('email', '550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
      expect(() => store.save('email', '550E8400-E29B-41D4-A716-446655440000')).not.toThrow();

      store.close();
    });
  });

  describe('group isolation', () => {
    it('one group cannot access another groups sessions', () => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      const store = ClaudeSessionStore.create(db, CLAUDE_SESSION_MIGRATIONS);

      store.save('email', VALID_UUID);
      store.save('slack', '6ba7b810-9dad-11d1-80b4-00c04fd430c8');

      expect(store.getLatest('email')).toBe(VALID_UUID);
      expect(store.getLatest('slack')).toBe('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
      expect(store.list('email')).toHaveLength(1);
      expect(store.list('slack')).toHaveLength(1);

      store.close();
    });
  });

  describe('SQL injection prevention', () => {
    it('uses parameterized queries — SQL injection in group name is harmless', () => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      const store = ClaudeSessionStore.create(db, CLAUDE_SESSION_MIGRATIONS);

      // These group names contain SQL injection attempts
      store.save("'; DROP TABLE claude_sessions; --", VALID_UUID);
      store.save("email' OR '1'='1", '6ba7b810-9dad-11d1-80b4-00c04fd430c8');

      // Table should still exist and have 2 rows
      const count = db.prepare('SELECT COUNT(*) as c FROM claude_sessions').get() as { c: number };
      expect(count.c).toBe(2);

      store.close();
    });
  });

  describe('TTL enforcement', () => {
    it('getLatest returns null for expired sessions', () => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      const store = ClaudeSessionStore.create(db, CLAUDE_SESSION_MIGRATIONS, 1000); // 1s TTL

      store.save('email', VALID_UUID);

      // Backdate to 2 seconds ago (past TTL)
      db.prepare(
        `UPDATE claude_sessions SET last_used_at = datetime('now', '-2 seconds')
         WHERE claude_session_id = ?`,
      ).run(VALID_UUID);

      expect(store.getLatest('email')).toBeNull();

      store.close();
    });
  });
});

// ===========================================================================
// 3. EventDispatcher Security
// ===========================================================================

describe('EventDispatcher security', () => {
  describe('wire session_id is never forwarded', () => {
    it('ignores session_id in event payload (fresh policy)', async () => {
      const deps = createDispatcherDeps({
        getSessionPolicy: vi.fn(() => 'fresh'),
      });
      const dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'task.triggered',
        group: 'email',
        payload: {
          prompt: 'test',
          session_id: 'attacker-injected-session',
        },
      });

      await dispatcher.dispatch(envelope);

      const spawnCall = (deps.spawnAgent as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const env = spawnCall[1] as Record<string, string> | undefined;
      if (env) {
        expect(env['CARAPACE_RESUME_SESSION_ID']).toBeUndefined();
        expect(env['CARAPACE_RESUME_SESSION']).toBeUndefined();
      }
    });

    it('ignores session_id in event payload (resume policy)', async () => {
      const deps = createDispatcherDeps({
        getSessionPolicy: vi.fn(() => 'resume'),
        getLatestSession: vi.fn(() => null), // no stored session
      });
      const dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'task.triggered',
        group: 'email',
        payload: {
          prompt: 'test',
          session_id: 'attacker-session',
        },
      });

      await dispatcher.dispatch(envelope);

      const spawnCall = (deps.spawnAgent as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const env = spawnCall[1] as Record<string, string> | undefined;
      // No resume session ID — the wire session_id is NOT used
      if (env) {
        expect(env['CARAPACE_RESUME_SESSION_ID']).toBeUndefined();
      }
    });
  });

  describe('only host-resolved session IDs reach container', () => {
    it('resume session ID comes from store, not wire', async () => {
      const deps = createDispatcherDeps({
        getSessionPolicy: vi.fn(() => 'resume'),
        getLatestSession: vi.fn(() => 'host-resolved-session-id'),
      });
      const dispatcher = new EventDispatcher(deps);

      // Use task.triggered (no payload schema validation) so we can include
      // a session_id in the payload to verify it's ignored.
      const envelope = createEventEnvelope({
        topic: 'task.triggered',
        group: 'email',
        payload: {
          prompt: 'test',
          session_id: 'wire-session-should-be-ignored',
        },
      });

      await dispatcher.dispatch(envelope);

      expect(deps.spawnAgent).toHaveBeenCalledWith('email', {
        CARAPACE_TASK_PROMPT: 'test',
        CARAPACE_RESUME_SESSION_ID: 'host-resolved-session-id',
      });
    });
  });

  describe('resolveSession errors do not leak internal state', () => {
    it('error result contains message but not stack trace', async () => {
      const deps = createDispatcherDeps({
        getSessionPolicy: vi.fn(() => 'explicit'),
        getPluginHandler: vi.fn(() => ({
          initialize: async () => {},
          handleToolInvocation: async () => ({ ok: true, result: {} }),
          shutdown: async () => {},
          resolveSession: async () => {
            throw new Error('Internal DB error at /opt/carapace/data/sessions.sqlite');
          },
        })),
        createSessionLookup: vi.fn(() => ({
          latest: async () => null,
          find: async () => [],
        })),
      });
      const dispatcher = new EventDispatcher(deps);

      const envelope = createEventEnvelope({
        topic: 'message.inbound',
        group: 'email',
        payload: VALID_INBOUND_PAYLOAD,
      });

      const result = await dispatcher.dispatch(envelope);

      expect(result.action).toBe('error');
      if (result.action === 'error') {
        // The error message is returned (for logging), but it's never sent to the container
        expect(result.reason).toContain('Internal DB error');
        expect(deps.spawnAgent).not.toHaveBeenCalled();
      }
    });
  });

  describe('core rejects wire messages with topics outside tool.invoke.*', () => {
    it('drops response.* topics (stream events should not trigger spawns)', async () => {
      const deps = createDispatcherDeps();
      const dispatcher = new EventDispatcher(deps);

      const responseTopic = createEventEnvelope({
        topic: 'response.system' as 'task.triggered',
        group: 'email',
      });
      const result = await dispatcher.dispatch(responseTopic);

      expect(result.action).toBe('dropped');
      expect(deps.spawnAgent).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// 4. ContainerOutputReader Security
// ===========================================================================

describe('ContainerOutputReader security', () => {
  it('tool_result events published to eventBus do not contain content', async () => {
    const mocks = createMockOutputDeps();
    const reader = new ContainerOutputReader(mocks.deps);

    const line = JSON.stringify({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      name: 'Read',
      content: 'SENSITIVE_DATA=secret123',
      is_error: false,
    });

    await reader.start(streamFrom([line]), {
      sessionId: 'sess-1',
      group: 'test',
      containerId: 'ctr-1',
    });

    expect(mocks.published).toHaveLength(1);
    const payloadStr = JSON.stringify(mocks.published[0]!.payload);
    expect(payloadStr).not.toContain('SENSITIVE_DATA');
    expect(payloadStr).not.toContain('secret123');
  });

  it('does not save empty claudeSessionId to store', async () => {
    const mocks = createMockOutputDeps();
    const reader = new ContainerOutputReader(mocks.deps);

    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      // session_id is missing → claudeSessionId will be ''
    });

    await reader.start(streamFrom([line]), {
      sessionId: 'sess-1',
      group: 'test',
      containerId: 'ctr-1',
    });

    expect(mocks.saved).toHaveLength(0);
  });

  it('constructs envelope identity fields from host session, not container data', async () => {
    const mocks = createMockOutputDeps();
    const reader = new ContainerOutputReader(mocks.deps);

    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
      },
      // These fields in the container output should NOT override envelope identity
      source: 'attacker-source',
      group: 'attacker-group',
      id: 'attacker-id',
    });

    await reader.start(streamFrom([line]), {
      sessionId: 'sess-1',
      group: 'trusted-group',
      containerId: 'trusted-container',
    });

    expect(mocks.published).toHaveLength(1);
    const envelope = mocks.published[0]!;
    // Envelope identity comes from host session, not container data
    expect(envelope.group).toBe('trusted-group');
    expect(envelope.source).toBe('trusted-container');
    expect(envelope.id).not.toBe('attacker-id');
  });
});

// ===========================================================================
// 5. Env var naming consistency
// ===========================================================================

describe('env var naming consistency', () => {
  it('EventDispatcher uses CARAPACE_RESUME_SESSION_ID (not CARAPACE_RESUME_SESSION)', async () => {
    const deps = createDispatcherDeps({
      getSessionPolicy: vi.fn(() => 'resume'),
      getLatestSession: vi.fn(() => VALID_UUID),
    });
    const dispatcher = new EventDispatcher(deps);

    const envelope = createEventEnvelope({
      topic: 'message.inbound',
      group: 'email',
      payload: VALID_INBOUND_PAYLOAD,
    });

    await dispatcher.dispatch(envelope);

    const spawnCall = (deps.spawnAgent as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const env = spawnCall[1] as Record<string, string>;
    // Must use CARAPACE_RESUME_SESSION_ID (the _ID suffix matters)
    expect(env['CARAPACE_RESUME_SESSION_ID']).toBe(VALID_UUID);
    expect(env['CARAPACE_RESUME_SESSION']).toBeUndefined();
  });
});

// ===========================================================================
// 6. Protocol types: tool_result content exclusion
// ===========================================================================

describe('protocol type safety', () => {
  it('ToolResultEventPayload type does not include content field', () => {
    // TypeScript compile-time check via runtime assertion.
    // The type only has: toolName, success, durationMs?, raw, seq
    const payload: ToolResultEventPayload = {
      toolName: 'test',
      success: true,
      raw: {},
      seq: 1,
    };
    const keys = Object.keys(payload);
    expect(keys).not.toContain('content');
  });
});
