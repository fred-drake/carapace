/**
 * ApiOutputReader — bridges claude-cli-api SSE responses → EventBus.
 *
 * Replaces ContainerOutputReader for API mode. Consumes an async generator
 * of ChatCompletionChunks (from ContainerApiClient.completeStream) and
 * publishes Carapace EventEnvelopes on the EventBus.
 *
 * Event mapping (OpenAI ChatCompletionChunk → Carapace topic):
 *   - First chunk → response.system
 *   - delta.content → response.chunk
 *   - finish_reason: "stop" → response.end
 */

import { createInterface } from 'node:readline';
import { PROTOCOL_VERSION } from '../types/protocol.js';
import type { EventEnvelope } from '../types/protocol.js';
import type {
  SystemEventPayload,
  ChunkEventPayload,
  EndEventPayload,
  ErrorEventPayload,
} from '../types/protocol.js';
import type { ChatCompletionChunk } from './container/sse-parser.js';
import { createLogger, type Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiOutputReaderDeps {
  eventBus: { publish(envelope: EventEnvelope): Promise<void> };
  claudeSessionStore: { save(group: string, claudeSessionId: string): void };
  logger?: Logger;
  /** Optional response sanitizer for defense-in-depth credential redaction. */
  sanitizer?: { sanitize(value: unknown): { value: unknown; redactedPaths: string[] } };
}

export interface ApiOutputSession {
  sessionId: string;
  group: string;
  containerId: string;
}

// ---------------------------------------------------------------------------
// ApiOutputReader
// ---------------------------------------------------------------------------

export class ApiOutputReader {
  private readonly deps: ApiOutputReaderDeps;
  private readonly logger: Logger;

  constructor(deps: ApiOutputReaderDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createLogger('api-output-reader');
  }

  /**
   * Process a stream of ChatCompletionChunks, publishing events to the EventBus.
   *
   * @param chunks - Async generator of ChatCompletionChunks from ContainerApiClient.
   * @param session - Session context for envelope construction.
   * @param stderr - Optional stderr stream for logging container diagnostics.
   */
  async processStream(
    chunks: AsyncIterable<ChatCompletionChunk>,
    session: ApiOutputSession,
    stderr?: NodeJS.ReadableStream,
  ): Promise<void> {
    // Capture stderr in background for diagnostics
    if (stderr) {
      this.captureStderr(stderr, session);
    }

    let seq = 0;
    let isFirstChunk = true;
    let lastModel = '';
    let lastId = '';

    try {
      for await (const chunk of chunks) {
        lastModel = chunk.model || lastModel;
        lastId = chunk.id || lastId;

        // Emit response.system on first chunk
        if (isFirstChunk) {
          isFirstChunk = false;
          seq++;

          const systemPayload: SystemEventPayload = {
            claudeSessionId: lastId,
            model: lastModel,
            raw: chunk as unknown as Record<string, unknown>,
            seq,
          };

          await this.publishEvent('response.system', systemPayload, session);

          // Persist session ID for --resume support
          if (lastId) {
            this.deps.claudeSessionStore.save(session.group, lastId);
          }
        }

        // Process each choice's delta
        for (const choice of chunk.choices) {
          if (choice.delta.content) {
            seq++;

            const chunkPayload: ChunkEventPayload = {
              text: choice.delta.content,
              raw: chunk as unknown as Record<string, unknown>,
              seq,
            };

            await this.publishEvent('response.chunk', chunkPayload, session);
          }

          // Stream finished
          if (choice.finish_reason === 'stop') {
            seq++;

            const endPayload: EndEventPayload = {
              claudeSessionId: lastId,
              exitCode: 0,
              raw: chunk as unknown as Record<string, unknown>,
              seq,
            };

            // Include usage if present in the final chunk
            if (chunk.usage) {
              endPayload.usage = {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
              };
            }

            await this.publishEvent('response.end', endPayload, session);

            // Persist final session ID
            if (lastId) {
              this.deps.claudeSessionStore.save(session.group, lastId);
            }
          }
        }
      }
    } catch (err) {
      // Emit response.error so downstream consumers know the stream failed
      seq++;
      const errorPayload: ErrorEventPayload = {
        reason: err instanceof Error ? err.message : String(err),
        raw: { error: err instanceof Error ? err.message : String(err) },
        seq,
      };
      await this.publishEvent('response.error', errorPayload, session);
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async publishEvent(
    topic: string,
    payload:
      | SystemEventPayload
      | ChunkEventPayload
      | EndEventPayload
      | ErrorEventPayload
      | Record<string, unknown>,
    session: ApiOutputSession,
  ): Promise<void> {
    // All typed payloads are structurally compatible with Record<string, unknown>
    const record = payload as Record<string, unknown>;

    // Apply sanitizer if available
    const sanitizedPayload = this.deps.sanitizer
      ? (this.deps.sanitizer.sanitize(record).value as Record<string, unknown>)
      : record;

    const envelope: EventEnvelope = {
      id: crypto.randomUUID(),
      version: PROTOCOL_VERSION,
      type: 'event',
      topic,
      source: session.containerId,
      correlation: null,
      timestamp: new Date().toISOString(),
      group: session.group,
      payload: sanitizedPayload,
    };

    await this.deps.eventBus.publish(envelope);
  }

  /**
   * Capture container stderr for diagnostics (fire-and-forget).
   *
   * The readline interface is intentionally NOT closed here. It will be
   * cleaned up when the underlying stderr stream ends (container exit or
   * shutdown). If the container hangs and stderr never closes, the readline
   * instance leaks — acceptable since the container itself is the larger
   * leak in that scenario. A future enhancement could accept an AbortSignal
   * to force-close the readline on external shutdown.
   */
  private captureStderr(stderr: NodeJS.ReadableStream, session: ApiOutputSession): void {
    const rl = createInterface({ input: stderr });

    rl.on('line', (line: string) => {
      this.logger.debug('container stderr', {
        session: session.sessionId,
        containerId: session.containerId,
        line,
      });
    });
  }
}
