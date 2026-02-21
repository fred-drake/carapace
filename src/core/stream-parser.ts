/**
 * StreamParser — stateful NDJSON parser for Claude Code `--output-format stream-json`.
 *
 * Classifies each line into a Carapace response topic with a typed payload.
 * Maintains a monotonic sequence counter across successfully parsed messages.
 */

import type {
  Topic,
  SystemEventPayload,
  ChunkEventPayload,
  ToolCallEventPayload,
  ToolResultEventPayload,
  EndEventPayload,
  ErrorEventPayload,
} from '../types/protocol.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ResponseTopic = Extract<Topic, `response.${string}`>;

export interface ParsedEvent {
  topic: ResponseTopic;
  payload:
    | SystemEventPayload
    | ChunkEventPayload
    | ToolCallEventPayload
    | ToolResultEventPayload
    | EndEventPayload
    | ErrorEventPayload;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum line size in bytes before rejecting. */
const MAX_LINE_BYTES = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// StreamParser
// ---------------------------------------------------------------------------

export class StreamParser {
  private seq = 0;

  /** Parse a single NDJSON line. Returns null for unknown/skipped types. */
  parse(line: string): ParsedEvent | null {
    const trimmed = line.trim();

    // Empty / whitespace-only → error
    if (trimmed.length === 0) {
      return this.errorEvent('Malformed JSON: empty line');
    }

    // Size limit check (byte length)
    if (Buffer.byteLength(trimmed, 'utf-8') > MAX_LINE_BYTES) {
      return this.errorEvent('Line exceeds size limit (1 MB)');
    }

    // JSON parse
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return this.errorEvent('Malformed JSON: parse error');
    }

    const type = obj.type as string | undefined;

    switch (type) {
      case 'system':
        return this.parseSystem(obj);
      case 'assistant':
        return this.parseAssistant(obj);
      case 'tool_result':
        return this.parseToolResult(obj);
      case 'result':
        return this.parseResult(obj);
      default:
        // Unknown types (including stream_event) → null, no seq increment
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Parsers for each message type
  // -------------------------------------------------------------------------

  private parseSystem(obj: Record<string, unknown>): ParsedEvent {
    const payload: SystemEventPayload = {
      claudeSessionId: (obj.session_id as string) ?? '',
      raw: obj,
      seq: this.nextSeq(),
    };
    if (typeof obj.model === 'string') {
      payload.model = obj.model;
    }
    return { topic: 'response.system', payload };
  }

  private parseAssistant(obj: Record<string, unknown>): ParsedEvent | null {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) return null;

    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content) || content.length === 0) return null;

    // Check for tool_use first (takes precedence over text)
    const toolUse = content.find((block) => block.type === 'tool_use');
    if (toolUse) {
      const payload: ToolCallEventPayload = {
        toolName: (toolUse.name as string) ?? '',
        toolInput: (toolUse.input as Record<string, unknown>) ?? {},
        raw: obj,
        seq: this.nextSeq(),
      };
      return { topic: 'response.tool_call', payload };
    }

    // Text blocks
    const textBlocks = content.filter((block) => block.type === 'text');
    if (textBlocks.length === 0) return null;

    const text = textBlocks.map((block) => (block.text as string) ?? '').join('');
    const payload: ChunkEventPayload = {
      text,
      raw: obj,
      seq: this.nextSeq(),
    };
    return { topic: 'response.chunk', payload };
  }

  private parseToolResult(obj: Record<string, unknown>): ParsedEvent {
    const payload: ToolResultEventPayload = {
      toolName: (obj.name as string) ?? '',
      success: obj.is_error !== true,
      raw: obj,
      seq: this.nextSeq(),
    };
    if (typeof obj.duration_ms === 'number') {
      payload.durationMs = obj.duration_ms;
    }
    return { topic: 'response.tool_result', payload };
  }

  private parseResult(obj: Record<string, unknown>): ParsedEvent {
    const payload: EndEventPayload = {
      claudeSessionId: (obj.session_id as string) ?? '',
      exitCode: obj.is_error === true ? 1 : 0,
      raw: obj,
      seq: this.nextSeq(),
    };

    if (typeof obj.input_tokens === 'number' && typeof obj.output_tokens === 'number') {
      payload.usage = {
        inputTokens: obj.input_tokens,
        outputTokens: obj.output_tokens,
      };
    }

    if (typeof obj.cost_usd === 'number') {
      payload.cost = { totalUsd: obj.cost_usd };
    }

    return { topic: 'response.end', payload };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private nextSeq(): number {
    return ++this.seq;
  }

  private errorEvent(reason: string): ParsedEvent {
    const payload: ErrorEventPayload = {
      reason,
      raw: {},
      seq: this.nextSeq(),
    };
    return { topic: 'response.error', payload };
  }
}
