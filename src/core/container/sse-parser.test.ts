import { describe, it, expect } from 'vitest';
import { parseSseLine, parseSseStream, SSE_DONE } from './sse-parser.js';
import type { ChatCompletionChunk } from './sse-parser.js';

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

async function* asyncLines(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) {
    yield line;
  }
}

async function collectChunks(
  gen: AsyncGenerator<ChatCompletionChunk>,
): Promise<ChatCompletionChunk[]> {
  const results: ChatCompletionChunk[] = [];
  for await (const chunk of gen) {
    results.push(chunk);
  }
  return results;
}

// ---------------------------------------------------------------------------
// parseSseLine
// ---------------------------------------------------------------------------

describe('parseSseLine', () => {
  it('parses a valid data line into a ChatCompletionChunk', () => {
    const chunk = makeChunk();
    const result = parseSseLine(`data: ${JSON.stringify(chunk)}`);
    expect(result).toEqual(chunk);
  });

  it('returns SSE_DONE for [DONE] terminator', () => {
    expect(parseSseLine('data: [DONE]')).toBe(SSE_DONE);
  });

  it('returns null for empty lines', () => {
    expect(parseSseLine('')).toBeNull();
    expect(parseSseLine('  ')).toBeNull();
  });

  it('returns null for SSE comment lines', () => {
    expect(parseSseLine(': this is a comment')).toBeNull();
  });

  it('returns null for non-data lines', () => {
    expect(parseSseLine('event: message')).toBeNull();
    expect(parseSseLine('id: 123')).toBeNull();
  });

  it('trims whitespace around data payload', () => {
    const chunk = makeChunk();
    const result = parseSseLine(`data:  ${JSON.stringify(chunk)}  `);
    expect(result).toEqual(chunk);
  });

  it('returns null for malformed JSON', () => {
    expect(parseSseLine('data: {invalid json}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSseStream
// ---------------------------------------------------------------------------

describe('parseSseStream', () => {
  it('yields chunks from a stream of SSE lines', async () => {
    const chunk1 = makeChunk({ id: 'c1' });
    const chunk2 = makeChunk({ id: 'c2' });

    const lines = [
      `data: ${JSON.stringify(chunk1)}\n`,
      '\n',
      `data: ${JSON.stringify(chunk2)}\n`,
      '\n',
      'data: [DONE]\n',
      '\n',
    ];

    const results = await collectChunks(parseSseStream(asyncLines(lines)));
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe('c1');
    expect(results[1]!.id).toBe('c2');
  });

  it('terminates on [DONE]', async () => {
    const chunk = makeChunk();
    const lines = [
      `data: ${JSON.stringify(chunk)}\n`,
      '\n',
      'data: [DONE]\n',
      '\n',
      `data: ${JSON.stringify(makeChunk({ id: 'should-not-appear' }))}\n`,
    ];

    const results = await collectChunks(parseSseStream(asyncLines(lines)));
    expect(results).toHaveLength(1);
  });

  it('handles chunks split across multiple yields', async () => {
    const chunk = makeChunk();
    const fullLine = `data: ${JSON.stringify(chunk)}\n\n`;
    // Split the line in the middle
    const part1 = fullLine.slice(0, 20);
    const part2 = fullLine.slice(20);

    const results = await collectChunks(
      parseSseStream(asyncLines([part1, part2, 'data: [DONE]\n'])),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(chunk);
  });

  it('handles an empty stream', async () => {
    const results = await collectChunks(parseSseStream(asyncLines([])));
    expect(results).toHaveLength(0);
  });

  it('skips comment and empty lines', async () => {
    const chunk = makeChunk();
    const lines = [
      ': keep-alive\n',
      '\n',
      `data: ${JSON.stringify(chunk)}\n`,
      '\n',
      'data: [DONE]\n',
    ];

    const results = await collectChunks(parseSseStream(asyncLines(lines)));
    expect(results).toHaveLength(1);
  });

  it('skips malformed JSON lines without crashing', async () => {
    const validChunk = makeChunk({ id: 'valid' });
    const lines = [
      'data: {not valid json}\n',
      '\n',
      `data: ${JSON.stringify(validChunk)}\n`,
      '\n',
      'data: [DONE]\n',
    ];

    const results = await collectChunks(parseSseStream(asyncLines(lines)));
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('valid');
  });

  it('propagates errors from the source stream', async () => {
    async function* failingStream(): AsyncGenerator<string> {
      yield `data: ${JSON.stringify(makeChunk())}\n\n`;
      throw new Error('Connection lost');
    }

    await expect(collectChunks(parseSseStream(failingStream()))).rejects.toThrow('Connection lost');
  });

  it('handles Buffer inputs', async () => {
    const chunk = makeChunk();
    async function* bufferStream(): AsyncGenerator<Buffer> {
      yield Buffer.from(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    }

    const results = await collectChunks(parseSseStream(bufferStream()));
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(chunk);
  });
});
