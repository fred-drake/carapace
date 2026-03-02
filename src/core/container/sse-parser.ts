/**
 * SSE (Server-Sent Events) parser for claude-cli-api streaming responses.
 *
 * Parses `data: {...}\n\n` and `data: [DONE]\n\n` from an HTTP response
 * stream. Yields typed OpenAI ChatCompletionChunk objects.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single delta within a ChatCompletionChunk choice. */
export interface ChunkDelta {
  role?: string;
  content?: string;
}

/** A single choice within a ChatCompletionChunk. */
export interface ChunkChoice {
  index: number;
  delta: ChunkDelta;
  finish_reason: string | null;
}

/** Usage stats optionally present in the final chunk. */
export interface ChunkUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** OpenAI ChatCompletionChunk shape (subset relevant to Carapace). */
export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChunkChoice[];
  usage?: ChunkUsage;
}

/** Sentinel value indicating stream completion. */
export const SSE_DONE = '[DONE]' as const;

// ---------------------------------------------------------------------------
// SSE line parser
// ---------------------------------------------------------------------------

/**
 * Parse a single SSE data line.
 *
 * @returns The parsed ChatCompletionChunk, the string `'[DONE]'`, or null
 *   for comment/empty/non-data lines.
 */
export function parseSseLine(line: string): ChatCompletionChunk | typeof SSE_DONE | null {
  const trimmed = line.trim();

  // Empty lines are SSE event separators — skip
  if (trimmed.length === 0) return null;

  // SSE comments start with ':'
  if (trimmed.startsWith(':')) return null;

  // Only process 'data:' lines
  if (!trimmed.startsWith('data:')) return null;

  const payload = trimmed.slice(5).trim();

  // Stream terminator
  if (payload === '[DONE]') return SSE_DONE;

  // Parse JSON payload — malformed data is skipped (not fatal)
  try {
    return JSON.parse(payload) as ChatCompletionChunk;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Async generator: stream → typed chunks
// ---------------------------------------------------------------------------

/**
 * Consume a ReadableStream of SSE text and yield ChatCompletionChunks.
 *
 * Handles line buffering (SSE lines may be split across chunks) and
 * terminates when `data: [DONE]` is received or the stream ends.
 */
export async function* parseSseStream(
  stream: AsyncIterable<string | Buffer>,
): AsyncGenerator<ChatCompletionChunk> {
  let buffer = '';

  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      const parsed = parseSseLine(line);
      if (parsed === SSE_DONE) return;
      if (parsed !== null) yield parsed;
    }
  }

  // Process any remaining data in the buffer
  if (buffer.trim().length > 0) {
    const parsed = parseSseLine(buffer);
    if (parsed !== null && parsed !== SSE_DONE) yield parsed;
  }
}
