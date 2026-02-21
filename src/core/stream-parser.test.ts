import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamParser } from './stream-parser.js';
import type {
  SystemEventPayload,
  ChunkEventPayload,
  ToolCallEventPayload,
  ToolResultEventPayload,
  EndEventPayload,
  ErrorEventPayload,
} from '../types/protocol.js';

describe('StreamParser', () => {
  let parser: StreamParser;

  beforeEach(() => {
    parser = new StreamParser();
  });

  // ---------------------------------------------------------------------------
  // 1. system → response.system
  // ---------------------------------------------------------------------------

  it('parses system event with session_id and model into response.system', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-abc-123',
      model: 'claude-sonnet-4-6-20250514',
      tools: [],
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.system');
    const payload = result!.payload as SystemEventPayload;
    expect(payload.claudeSessionId).toBe('sess-abc-123');
    expect(payload.model).toBe('claude-sonnet-4-6-20250514');
    expect(payload.seq).toBe(1);
    expect(payload.raw).toEqual(JSON.parse(line));
  });

  it('parses system event without optional model field', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-abc-123',
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.system');
    const payload = result!.payload as SystemEventPayload;
    expect(payload.claudeSessionId).toBe('sess-abc-123');
    expect(payload.model).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 2. assistant(text) → response.chunk
  // ---------------------------------------------------------------------------

  it('parses assistant text message into response.chunk', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello, world!' }],
      },
      session_id: 'sess-abc-123',
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.chunk');
    const payload = result!.payload as ChunkEventPayload;
    expect(payload.text).toBe('Hello, world!');
    expect(payload.seq).toBe(1);
    expect(payload.raw).toEqual(JSON.parse(line));
  });

  it('concatenates multiple text blocks in assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part one. ' },
          { type: 'text', text: 'Part two.' },
        ],
      },
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.chunk');
    const payload = result!.payload as ChunkEventPayload;
    expect(payload.text).toBe('Part one. Part two.');
  });

  // ---------------------------------------------------------------------------
  // 3. assistant(tool_use) → response.tool_call
  // ---------------------------------------------------------------------------

  it('parses assistant tool_use into response.tool_call', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            id: 'toolu_abc123',
            input: { file_path: '/app/main.ts' },
          },
        ],
      },
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.tool_call');
    const payload = result!.payload as ToolCallEventPayload;
    expect(payload.toolName).toBe('Read');
    expect(payload.toolInput).toEqual({ file_path: '/app/main.ts' });
    expect(payload.seq).toBe(1);
  });

  it('prefers tool_use over text when both are in content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that file.' },
          {
            type: 'tool_use',
            name: 'Bash',
            id: 'toolu_xyz',
            input: { command: 'ls' },
          },
        ],
      },
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.tool_call');
    const payload = result!.payload as ToolCallEventPayload;
    expect(payload.toolName).toBe('Bash');
  });

  // ---------------------------------------------------------------------------
  // 4. tool_result → response.tool_result (metadata only)
  // ---------------------------------------------------------------------------

  it('parses tool_result into response.tool_result with metadata only', () => {
    const line = JSON.stringify({
      type: 'tool_result',
      tool_use_id: 'toolu_abc123',
      name: 'Read',
      content: 'file contents here — should NOT be in payload',
      is_error: false,
      duration_ms: 42,
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.tool_result');
    const payload = result!.payload as ToolResultEventPayload;
    expect(payload.toolName).toBe('Read');
    expect(payload.success).toBe(true);
    expect(payload.durationMs).toBe(42);
    expect(payload.seq).toBe(1);
    // Security: no content leaks into the payload (metadata only)
    expect((payload as unknown as Record<string, unknown>)['content']).toBeUndefined();
    // Security: content is also stripped from raw to prevent data leakage
    expect((payload.raw as Record<string, unknown>)['content']).toBeUndefined();
    // Verify other raw fields are preserved
    expect((payload.raw as Record<string, unknown>)['type']).toBe('tool_result');
    expect((payload.raw as Record<string, unknown>)['name']).toBe('Read');
  });

  it('maps is_error: true to success: false', () => {
    const line = JSON.stringify({
      type: 'tool_result',
      tool_use_id: 'toolu_abc123',
      name: 'Bash',
      content: 'command not found',
      is_error: true,
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    const payload = result!.payload as ToolResultEventPayload;
    expect(payload.toolName).toBe('Bash');
    expect(payload.success).toBe(false);
    expect(payload.durationMs).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 5. result → response.end
  // ---------------------------------------------------------------------------

  it('parses result into response.end with session_id, usage, and cost', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'Task completed successfully.',
      session_id: 'sess-abc-123',
      input_tokens: 500,
      output_tokens: 200,
      cost_usd: 0.0035,
      duration_ms: 12000,
      duration_api_ms: 8000,
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.end');
    const payload = result!.payload as EndEventPayload;
    expect(payload.claudeSessionId).toBe('sess-abc-123');
    expect(payload.exitCode).toBe(0);
    expect(payload.usage).toEqual({ inputTokens: 500, outputTokens: 200 });
    expect(payload.cost).toEqual({ totalUsd: 0.0035 });
    expect(payload.seq).toBe(1);
  });

  it('parses result without optional usage/cost fields', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'Done.',
      session_id: 'sess-abc-123',
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    const payload = result!.payload as EndEventPayload;
    expect(payload.claudeSessionId).toBe('sess-abc-123');
    expect(payload.exitCode).toBe(0);
    expect(payload.usage).toBeUndefined();
    expect(payload.cost).toBeUndefined();
  });

  it('maps result is_error to non-zero exitCode', () => {
    const line = JSON.stringify({
      type: 'result',
      result: '',
      session_id: 'sess-abc-123',
      is_error: true,
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    const payload = result!.payload as EndEventPayload;
    expect(payload.exitCode).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 6. Empty line → null
  // ---------------------------------------------------------------------------

  it('returns null for empty string', () => {
    expect(parser.parseLine('')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 7. Unknown type → null (no throw)
  // ---------------------------------------------------------------------------

  it('returns null for unknown type and logs warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const line = JSON.stringify({ type: 'ping', data: {} });
    const result = parser.parseLine(line);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toMatch(/unknown.*type/i);
    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 8. Malformed JSON → response.error
  // ---------------------------------------------------------------------------

  it('returns response.error for malformed JSON', () => {
    const result = parser.parseLine('{not valid json}');
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.error');
    const payload = result!.payload as ErrorEventPayload;
    expect(payload.reason).toMatch(/malformed|parse|json/i);
    expect(payload.seq).toBe(1);
    expect(payload.raw).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // 9. Seq counter increments monotonically
  // ---------------------------------------------------------------------------

  it('increments seq monotonically across parsed events', () => {
    const system = JSON.stringify({
      type: 'system',
      session_id: 'sess-1',
    });
    const chunk = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    });
    const end = JSON.stringify({
      type: 'result',
      result: 'Done.',
      session_id: 'sess-1',
    });

    const r1 = parser.parseLine(system);
    const r2 = parser.parseLine(chunk);
    const r3 = parser.parseLine(end);

    expect((r1!.payload as SystemEventPayload).seq).toBe(1);
    expect((r2!.payload as ChunkEventPayload).seq).toBe(2);
    expect((r3!.payload as EndEventPayload).seq).toBe(3);
  });

  it('does not increment seq for null results', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknown = JSON.stringify({ type: 'ping', data: {} });
    const chunk = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    });

    const r1 = parser.parseLine(unknown);
    const r2 = parser.parseLine(chunk);

    expect(r1).toBeNull();
    expect((r2!.payload as ChunkEventPayload).seq).toBe(1);
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 10. Oversized line (>1 MB) → response.error
  // ---------------------------------------------------------------------------

  it('returns response.error for lines exceeding 1 MB', () => {
    const bigPayload = 'x'.repeat(1_048_576 + 1);
    const line = JSON.stringify({ type: 'system', session_id: 'sess-1', data: bigPayload });
    const result = parser.parseLine(line);

    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.error');
    const payload = result!.payload as ErrorEventPayload;
    expect(payload.reason).toMatch(/size limit/i);
    expect(payload.raw).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // 11. Whitespace-only line → null
  // ---------------------------------------------------------------------------

  it('returns null for whitespace-only line', () => {
    expect(parser.parseLine('   \t  \n  ')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 12. Missing fields handled gracefully
  // ---------------------------------------------------------------------------

  it('handles assistant message with empty content array gracefully', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [] },
    });
    expect(parser.parseLine(line)).toBeNull();
    vi.restoreAllMocks();
  });

  it('handles assistant message without message field gracefully', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const line = JSON.stringify({ type: 'assistant' });
    expect(parser.parseLine(line)).toBeNull();
    vi.restoreAllMocks();
  });

  it('handles system event missing session_id gracefully', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init' });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.system');
    const payload = result!.payload as SystemEventPayload;
    expect(payload.claudeSessionId).toBe('');
  });

  it('handles result missing session_id gracefully', () => {
    const line = JSON.stringify({ type: 'result', result: 'Done.' });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.end');
    const payload = result!.payload as EndEventPayload;
    expect(payload.claudeSessionId).toBe('');
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases
  // ---------------------------------------------------------------------------

  it('strips leading/trailing whitespace before parsing', () => {
    const line = `  ${JSON.stringify({ type: 'system', session_id: 'sess-1' })}  `;
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.system');
  });

  // ---------------------------------------------------------------------------
  // JSON depth limit (matches IPC 64-level limit)
  // ---------------------------------------------------------------------------

  it('returns response.error for deeply nested JSON exceeding 64 levels', () => {
    // Build valid JSON with 65 nesting levels
    const nested = '{"a":'.repeat(65) + '{}' + '}'.repeat(65);
    const result = parser.parseLine(nested);

    expect(result).not.toBeNull();
    expect(result!.topic).toBe('response.error');
    const payload = result!.payload as ErrorEventPayload;
    expect(payload.reason).toMatch(/depth/i);
  });

  it('accepts JSON at exactly 64 nesting levels', () => {
    // 63 wrapping levels + 1 inner {} = 64 total depth
    const nested = '{"a":'.repeat(63) + '{}' + '}'.repeat(63);
    const result = parser.parseLine(nested);

    // At 64 levels, depth check should pass (parse may result in unknown type → null)
    if (result !== null) {
      expect(result.topic).not.toBe('response.error');
    }
  });

  it('does increment seq for error results (malformed JSON)', () => {
    parser.parseLine('{bad}');
    const line = JSON.stringify({
      type: 'system',
      session_id: 'sess-1',
    });
    const result = parser.parseLine(line);
    expect((result!.payload as SystemEventPayload).seq).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Security: tool_result content stripping
  // ---------------------------------------------------------------------------

  it('strips content from raw in tool_result even when content contains secrets', () => {
    const line = JSON.stringify({
      type: 'tool_result',
      tool_use_id: 'toolu_sec',
      name: 'Read',
      content: 'ANTHROPIC_API_KEY=sk-ant-secret-key-here\nDB_PASSWORD=hunter2',
      is_error: false,
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    const payload = result!.payload as ToolResultEventPayload;
    // Content must not appear anywhere in the payload
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain('sk-ant-secret-key-here');
    expect(payloadStr).not.toContain('hunter2');
    // raw.content specifically must be absent
    expect((payload.raw as Record<string, unknown>)['content']).toBeUndefined();
  });

  it('preserves all non-content fields in tool_result raw', () => {
    const line = JSON.stringify({
      type: 'tool_result',
      tool_use_id: 'toolu_fields',
      name: 'Bash',
      content: 'should be stripped',
      is_error: false,
      duration_ms: 100,
      extra_field: 'preserved',
    });
    const result = parser.parseLine(line);
    expect(result).not.toBeNull();
    const raw = result!.payload.raw as Record<string, unknown>;
    expect(raw['type']).toBe('tool_result');
    expect(raw['tool_use_id']).toBe('toolu_fields');
    expect(raw['name']).toBe('Bash');
    expect(raw['is_error']).toBe(false);
    expect(raw['duration_ms']).toBe(100);
    expect(raw['extra_field']).toBe('preserved');
    expect(raw['content']).toBeUndefined();
  });
});
