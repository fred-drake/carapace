import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiOutputReader } from './api-output-reader.js';
import type { ApiOutputReaderDeps, ApiOutputSession } from './api-output-reader.js';
import type { ChatCompletionChunk } from './container/sse-parser.js';
import type { EventEnvelope } from '../types/protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(overrides?: Partial<ChatCompletionChunk>): ChatCompletionChunk {
  return {
    id: 'chatcmpl-123',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'sonnet',
    choices: [
      {
        index: 0,
        delta: { content: 'hello' },
        finish_reason: null,
      },
    ],
    ...overrides,
  };
}

function makeSession(): ApiOutputSession {
  return {
    sessionId: 'session-1',
    group: 'email',
    containerId: 'container-1',
  };
}

async function* asyncChunks(chunks: ChatCompletionChunk[]): AsyncGenerator<ChatCompletionChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApiOutputReader', () => {
  let published: EventEnvelope[];
  let savedSessions: Array<{ group: string; sessionId: string }>;
  let deps: ApiOutputReaderDeps;
  let reader: ApiOutputReader;

  beforeEach(() => {
    published = [];
    savedSessions = [];
    deps = {
      eventBus: {
        publish: vi.fn(async (envelope: EventEnvelope) => {
          published.push(envelope);
        }),
      },
      claudeSessionStore: {
        save: vi.fn((group: string, sessionId: string) => {
          savedSessions.push({ group, sessionId });
        }),
      },
    };
    reader = new ApiOutputReader(deps);
  });

  it('emits response.system on first chunk', async () => {
    const chunks = [
      makeChunk({ id: 'sess-1', model: 'claude-4' }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
    ];

    await reader.processStream(asyncChunks(chunks), makeSession());

    const systemEvent = published.find((e) => e.topic === 'response.system');
    expect(systemEvent).toBeDefined();
    expect(systemEvent!.payload).toMatchObject({
      claudeSessionId: 'sess-1',
      model: 'claude-4',
      seq: 1,
    });
  });

  it('emits response.chunk for content deltas', async () => {
    const chunks = [
      makeChunk({ choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] }),
      makeChunk({ choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] }),
      makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ];

    await reader.processStream(asyncChunks(chunks), makeSession());

    const chunkEvents = published.filter((e) => e.topic === 'response.chunk');
    expect(chunkEvents).toHaveLength(2);
    expect(chunkEvents[0]!.payload).toMatchObject({ text: 'Hello' });
    expect(chunkEvents[1]!.payload).toMatchObject({ text: ' world' });
  });

  it('emits response.end on finish_reason stop', async () => {
    const chunks = [
      makeChunk(),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    ];

    await reader.processStream(asyncChunks(chunks), makeSession());

    const endEvent = published.find((e) => e.topic === 'response.end');
    expect(endEvent).toBeDefined();
    expect(endEvent!.payload).toMatchObject({
      claudeSessionId: 'chatcmpl-123',
      exitCode: 0,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  });

  it('persists session ID via claudeSessionStore', async () => {
    const chunks = [
      makeChunk({ id: 'sess-abc' }),
      makeChunk({
        id: 'sess-abc',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
    ];

    await reader.processStream(asyncChunks(chunks), makeSession());

    expect(savedSessions).toContainEqual({ group: 'email', sessionId: 'sess-abc' });
  });

  it('assigns monotonically increasing sequence numbers', async () => {
    const chunks = [
      makeChunk({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] }),
      makeChunk({ choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }] }),
      makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ];

    await reader.processStream(asyncChunks(chunks), makeSession());

    const seqs = published.map((e) => (e.payload as { seq: number }).seq);
    // Should be monotonically increasing
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it('constructs valid EventEnvelopes', async () => {
    const session = makeSession();
    const chunks = [
      makeChunk(),
      makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ];

    await reader.processStream(asyncChunks(chunks), session);

    for (const envelope of published) {
      expect(envelope.version).toBe(1);
      expect(envelope.type).toBe('event');
      expect(envelope.source).toBe(session.containerId);
      expect(envelope.group).toBe(session.group);
      expect(envelope.id).toBeDefined();
      expect(envelope.timestamp).toBeDefined();
    }
  });

  it('applies sanitizer when provided', async () => {
    const sanitizer = {
      sanitize: vi.fn((value: unknown) => ({
        value: { ...(value as Record<string, unknown>), sanitized: true },
        redactedPaths: [],
      })),
    };

    const sanitizedReader = new ApiOutputReader({ ...deps, sanitizer });
    const chunks = [
      makeChunk(),
      makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ];

    await sanitizedReader.processStream(asyncChunks(chunks), makeSession());

    expect(sanitizer.sanitize).toHaveBeenCalled();
    for (const envelope of published) {
      expect((envelope.payload as Record<string, unknown>).sanitized).toBe(true);
    }
  });

  it('handles an empty stream gracefully', async () => {
    await reader.processStream(asyncChunks([]), makeSession());
    expect(published).toHaveLength(0);
  });

  it('emits response.error when stream throws', async () => {
    async function* failingStream(): AsyncGenerator<ChatCompletionChunk> {
      yield makeChunk({ id: 'sess-fail', model: 'claude-4' });
      throw new Error('Stream disconnected');
    }

    await expect(reader.processStream(failingStream(), makeSession())).rejects.toThrow(
      'Stream disconnected',
    );

    const errorEvent = published.find((e) => e.topic === 'response.error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.payload).toMatchObject({
      reason: 'Stream disconnected',
      raw: { error: 'Stream disconnected' },
    });
  });

  it('handles chunks without content delta', async () => {
    const chunks = [
      makeChunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
      makeChunk({ choices: [{ index: 0, delta: { content: 'text' }, finish_reason: null }] }),
      makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ];

    await reader.processStream(asyncChunks(chunks), makeSession());

    // First chunk is system (no content), second is chunk, third is end
    const chunkEvents = published.filter((e) => e.topic === 'response.chunk');
    expect(chunkEvents).toHaveLength(1);
    expect(chunkEvents[0]!.payload).toMatchObject({ text: 'text' });
  });
});
