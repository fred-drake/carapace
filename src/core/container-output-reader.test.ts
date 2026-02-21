import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'stream';
import { ContainerOutputReader } from './container-output-reader.js';
import { PROTOCOL_VERSION } from '../types/protocol.js';
import type { EventEnvelope } from '../types/protocol.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockDeps() {
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

function makeSession(
  overrides?: Partial<{ sessionId: string; group: string; containerId: string }>,
) {
  return {
    sessionId: overrides?.sessionId ?? 'sess-001',
    group: overrides?.group ?? 'test-group',
    containerId: overrides?.containerId ?? 'ctr-abc123',
  };
}

function streamFrom(lines: string[]): NodeJS.ReadableStream {
  return Readable.from(lines.map((l) => l + '\n'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContainerOutputReader', () => {
  let reader: ContainerOutputReader;
  let published: EventEnvelope[];
  let saved: Array<{ group: string; claudeSessionId: string }>;

  beforeEach(() => {
    const mocks = createMockDeps();
    reader = new ContainerOutputReader(mocks.deps);
    published = mocks.published;
    saved = mocks.saved;
  });

  // -------------------------------------------------------------------------
  // 1. Publishes response.chunk for text delta lines
  // -------------------------------------------------------------------------

  it('publishes response.chunk for assistant text delta', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello, world!' }],
      },
    });

    await reader.start(streamFrom([line]), makeSession());

    expect(published).toHaveLength(1);
    expect(published[0]!.topic).toBe('response.chunk');
    expect(published[0]!.payload).toMatchObject({ text: 'Hello, world!' });
  });

  // -------------------------------------------------------------------------
  // 2. Publishes response.tool_call for tool_use lines
  // -------------------------------------------------------------------------

  it('publishes response.tool_call for tool_use lines', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            id: 'toolu_abc',
            input: { file_path: '/app/main.ts' },
          },
        ],
      },
    });

    await reader.start(streamFrom([line]), makeSession());

    expect(published).toHaveLength(1);
    expect(published[0]!.topic).toBe('response.tool_call');
    expect(published[0]!.payload).toMatchObject({
      toolName: 'Read',
      toolInput: { file_path: '/app/main.ts' },
    });
  });

  // -------------------------------------------------------------------------
  // 3. Publishes response.tool_result with metadata only
  // -------------------------------------------------------------------------

  it('publishes response.tool_result with metadata only', async () => {
    const line = JSON.stringify({
      type: 'tool_result',
      tool_use_id: 'toolu_abc',
      name: 'Read',
      content: 'file contents — should not leak',
      is_error: false,
      duration_ms: 42,
    });

    await reader.start(streamFrom([line]), makeSession());

    expect(published).toHaveLength(1);
    expect(published[0]!.topic).toBe('response.tool_result');
    expect(published[0]!.payload).toMatchObject({
      toolName: 'Read',
      success: true,
      durationMs: 42,
    });
    // Security: content must not leak through the event bus
    const payloadStr = JSON.stringify(published[0]!.payload);
    expect(payloadStr).not.toContain('file contents');
    expect((published[0]!.payload as Record<string, unknown>)['content']).toBeUndefined();
    expect(
      ((published[0]!.payload as Record<string, unknown>)['raw'] as Record<string, unknown>)?.[
        'content'
      ],
    ).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 4. Publishes response.end on result line
  // -------------------------------------------------------------------------

  it('publishes response.end on result line', async () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'Task completed.',
      session_id: '550e8400-e29b-41d4-a716-446655440000',
      input_tokens: 500,
      output_tokens: 200,
      cost_usd: 0.0035,
    });

    await reader.start(streamFrom([line]), makeSession());

    expect(published).toHaveLength(1);
    expect(published[0]!.topic).toBe('response.end');
    expect(published[0]!.payload).toMatchObject({
      claudeSessionId: '550e8400-e29b-41d4-a716-446655440000',
      exitCode: 0,
    });
  });

  // -------------------------------------------------------------------------
  // 5. Extracts and saves claudeSessionId from system event
  // -------------------------------------------------------------------------

  it('extracts and saves claudeSessionId from response.system', async () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: '550e8400-e29b-41d4-a716-446655440000',
      model: 'claude-sonnet-4-6-20250514',
    });

    await reader.start(streamFrom([line]), makeSession({ group: 'email' }));

    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      group: 'email',
      claudeSessionId: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  // -------------------------------------------------------------------------
  // 6. Extracts and saves claudeSessionId from end event
  // -------------------------------------------------------------------------

  it('extracts and saves claudeSessionId from response.end', async () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'Done.',
      session_id: '660e8400-e29b-41d4-a716-446655440000',
    });

    await reader.start(streamFrom([line]), makeSession({ group: 'slack' }));

    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      group: 'slack',
      claudeSessionId: '660e8400-e29b-41d4-a716-446655440000',
    });
  });

  // -------------------------------------------------------------------------
  // 7. Constructs valid EventEnvelope
  // -------------------------------------------------------------------------

  it('constructs valid EventEnvelope with all identity fields', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
      },
    });

    await reader.start(streamFrom([line]), makeSession({ group: 'email', containerId: 'ctr-xyz' }));

    expect(published).toHaveLength(1);
    const envelope = published[0]!;
    expect(envelope.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(envelope.version).toBe(PROTOCOL_VERSION);
    expect(envelope.type).toBe('event');
    expect(envelope.topic).toBe('response.chunk');
    expect(envelope.source).toBe('ctr-xyz');
    expect(envelope.correlation).toBeNull();
    expect(envelope.group).toBe('email');
    expect(envelope.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // -------------------------------------------------------------------------
  // 8. Skips lines that StreamParser returns null for
  // -------------------------------------------------------------------------

  it('skips lines that StreamParser returns null for', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const unknownLine = JSON.stringify({ type: 'ping', data: {} });
    const chunkLine = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
    });

    await reader.start(streamFrom([unknownLine, chunkLine]), makeSession());

    expect(published).toHaveLength(1);
    expect(published[0]!.topic).toBe('response.chunk');

    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 9. Handles empty stream (no events published)
  // -------------------------------------------------------------------------

  it('handles empty stream without publishing any events', async () => {
    await reader.start(streamFrom([]), makeSession());

    expect(published).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 10. Handles malformed JSON lines — publishes response.error
  // -------------------------------------------------------------------------

  it('publishes response.error for malformed JSON lines without crashing', async () => {
    const badLine = '{not valid json}';
    const goodLine = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'After error' }],
      },
    });

    await reader.start(streamFrom([badLine, goodLine]), makeSession());

    expect(published).toHaveLength(2);
    expect(published[0]!.topic).toBe('response.error');
    expect(published[0]!.payload).toMatchObject({
      reason: expect.stringMatching(/malformed|parse|json/i),
    });
    expect(published[1]!.topic).toBe('response.chunk');
  });

  // -------------------------------------------------------------------------
  // 11. Does not save claudeSessionId for non-session events
  // -------------------------------------------------------------------------

  it('does not save claudeSessionId for response.chunk events', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
    });

    await reader.start(streamFrom([line]), makeSession());

    expect(saved).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 12. Does not save when claudeSessionId is empty string
  // -------------------------------------------------------------------------

  it('does not save when claudeSessionId is empty string', async () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
    });

    await reader.start(streamFrom([line]), makeSession());

    expect(published).toHaveLength(1);
    expect(saved).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 13. Processes multiple lines in sequence
  // -------------------------------------------------------------------------

  it('processes a full stream of multiple event types', async () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        model: 'claude-sonnet-4-6-20250514',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Working on it...' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_1', input: { command: 'ls' } }],
        },
      }),
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        name: 'Bash',
        content: 'file1.ts\nfile2.ts',
        is_error: false,
      }),
      JSON.stringify({
        type: 'result',
        result: 'Done.',
        session_id: '550e8400-e29b-41d4-a716-446655440000',
      }),
    ];

    await reader.start(streamFrom(lines), makeSession({ group: 'email' }));

    expect(published).toHaveLength(5);
    expect(published.map((e) => e.topic)).toEqual([
      'response.system',
      'response.chunk',
      'response.tool_call',
      'response.tool_result',
      'response.end',
    ]);
    // Both system and end events should trigger saves
    expect(saved).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // ResponseSanitizer integration
  // -------------------------------------------------------------------------

  describe('ResponseSanitizer on response.* events', () => {
    it('sanitizes credential patterns in payload raw fields before publishing', async () => {
      const { deps, published } = createMockDeps();
      const sanitizer = {
        sanitize: vi.fn((value: unknown) => ({
          value,
          redactedPaths: [],
        })),
      };
      const reader = new ContainerOutputReader({ ...deps, sanitizer });

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here is a token: Bearer sk-abc123xyz' }],
          },
        }),
      ];

      await reader.start(streamFrom(lines), makeSession());

      // Sanitizer should have been called once for the chunk event payload
      expect(sanitizer.sanitize).toHaveBeenCalledTimes(1);
      expect(published).toHaveLength(1);
    });

    it('replaces credential patterns in text content', async () => {
      const { deps, published } = createMockDeps();
      // Real-ish sanitizer that replaces bearer tokens
      const sanitizer = {
        sanitize: (value: unknown) => {
          const json = JSON.stringify(value);
          const cleaned = json.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/g, 'Bearer [REDACTED]');
          return {
            value: JSON.parse(cleaned),
            redactedPaths: json !== cleaned ? ['$.text'] : [],
          };
        },
      };
      const reader = new ContainerOutputReader({ ...deps, sanitizer });

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Token: Bearer sk-ant-secret123456' }],
          },
        }),
      ];

      await reader.start(streamFrom(lines), makeSession());

      expect(published).toHaveLength(1);
      const payloadStr = JSON.stringify(published[0]!.payload);
      expect(payloadStr).not.toContain('sk-ant-secret123456');
      expect(payloadStr).toContain('[REDACTED]');
    });

    it('works without sanitizer (backward compatible)', async () => {
      const { deps, published } = createMockDeps();
      // No sanitizer in deps
      const reader = new ContainerOutputReader(deps);

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello' }],
          },
        }),
      ];

      await reader.start(streamFrom(lines), makeSession());

      expect(published).toHaveLength(1);
      expect((published[0]!.payload as Record<string, unknown>)['text']).toBe('Hello');
    });
  });
});
