import { describe, it, expect } from 'vitest';
import {
  checkMessageLimits,
  DEFAULT_MESSAGE_LIMITS,
  type MessageLimitsConfig,
} from './message-limits.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a raw JSON string of approximately `byteSize` bytes. */
function makeRawPayload(byteSize: number): string {
  // {"topic":"t","correlation":"c","arguments":{"x":"..."}}
  const overhead = '{"topic":"t","correlation":"c","arguments":{"x":"'.length + '"}}'.length;
  const filler = 'a'.repeat(Math.max(0, byteSize - overhead));
  return `{"topic":"t","correlation":"c","arguments":{"x":"${filler}"}}`;
}

/** Build a raw JSON string with a specific field value length. */
function makePayloadWithFieldLength(fieldLength: number): string {
  const value = 'b'.repeat(fieldLength);
  return JSON.stringify({
    topic: 'tool.invoke.test_tool',
    correlation: 'corr-001',
    arguments: { data: value },
  });
}

/** Build a deeply nested JSON structure. */
function makeNestedJson(depth: number): string {
  // Builds: {"topic":"t","correlation":"c","arguments":{"a":{"a":{...}}}}
  let inner = '"leaf"';
  for (let i = 0; i < depth; i++) {
    inner = `{"a":${inner}}`;
  }
  return `{"topic":"t","correlation":"c","arguments":${inner}}`;
}

/** Build a deeply nested JSON using arrays. */
function makeNestedArrayJson(depth: number): string {
  let inner = '"leaf"';
  for (let i = 0; i < depth; i++) {
    inner = `[${inner}]`;
  }
  return `{"topic":"t","correlation":"c","arguments":{"a":${inner}}}`;
}

/** Build a deeply nested JSON mixing objects and arrays. */
function makeMixedNestedJson(depth: number): string {
  let inner = '"leaf"';
  for (let i = 0; i < depth; i++) {
    if (i % 2 === 0) {
      inner = `{"a":${inner}}`;
    } else {
      inner = `[${inner}]`;
    }
  }
  return `{"topic":"t","correlation":"c","arguments":${inner}}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Message limits: defaults', () => {
  it('exposes default configuration', () => {
    expect(DEFAULT_MESSAGE_LIMITS.maxRawBytes).toBe(1_048_576); // 1 MB
    expect(DEFAULT_MESSAGE_LIMITS.maxPayloadBytes).toBe(1_048_576);
    expect(DEFAULT_MESSAGE_LIMITS.maxFieldBytes).toBe(102_400); // 100 KB
    expect(DEFAULT_MESSAGE_LIMITS.maxJsonDepth).toBe(64);
  });
});

describe('Message limits: raw byte size', () => {
  it('allows messages within the raw byte limit', () => {
    const raw = makeRawPayload(500);
    const result = checkMessageLimits(raw);
    expect(result.ok).toBe(true);
  });

  it('allows messages exactly at the raw byte limit', () => {
    const limit = 256;
    const raw = makeRawPayload(limit);
    const result = checkMessageLimits(raw, { maxRawBytes: limit });
    expect(result.ok).toBe(true);
  });

  it('rejects messages one byte over the raw byte limit', () => {
    const limit = 256;
    const raw = makeRawPayload(limit + 1);
    const result = checkMessageLimits(raw, { maxRawBytes: limit });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('raw byte size');
      expect(result.error).toContain(String(limit));
      expect(result.error).toContain(String(Buffer.byteLength(raw)));
    }
  });

  it('rejects before JSON parsing when raw size exceeds limit', () => {
    // Intentionally malformed JSON — if it tries to parse, it would throw.
    // But size check should reject first.
    const oversized = '{' + 'x'.repeat(200) + '}broken json{{{{';
    const result = checkMessageLimits(oversized, { maxRawBytes: 50 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('raw byte size');
    }
  });

  it('counts multi-byte unicode characters correctly for byte limits', () => {
    // "😀" is 4 bytes in UTF-8 but 1 character
    const emoji = '😀'.repeat(10); // 40 bytes
    const raw = JSON.stringify({
      topic: 't',
      correlation: 'c',
      arguments: { data: emoji },
    });
    const byteLen = Buffer.byteLength(raw);
    // Allow enough for the JSON overhead but not the emoji payload
    const tightLimit = byteLen - 1;
    const result = checkMessageLimits(raw, { maxRawBytes: tightLimit });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(String(byteLen));
    }
  });
});

describe('Message limits: payload size', () => {
  it('rejects when arguments payload exceeds limit', () => {
    const largeValue = 'x'.repeat(200);
    const raw = JSON.stringify({
      topic: 't',
      correlation: 'c',
      arguments: { data: largeValue },
    });
    const result = checkMessageLimits(raw, {
      maxRawBytes: 10_000,
      maxPayloadBytes: 50,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('payload size');
    }
  });

  it('allows when arguments payload is within limit', () => {
    const raw = JSON.stringify({
      topic: 't',
      correlation: 'c',
      arguments: { data: 'small' },
    });
    const result = checkMessageLimits(raw, {
      maxRawBytes: 10_000,
      maxPayloadBytes: 10_000,
    });
    expect(result.ok).toBe(true);
  });
});

describe('Message limits: field length', () => {
  it('rejects when a single argument field exceeds the field limit', () => {
    const raw = makePayloadWithFieldLength(200);
    const result = checkMessageLimits(raw, {
      maxRawBytes: 10_000,
      maxPayloadBytes: 10_000,
      maxFieldBytes: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('field');
      expect(result.error).toContain('data');
      expect(result.error).toContain('100');
    }
  });

  it('allows fields within the field limit', () => {
    const raw = makePayloadWithFieldLength(50);
    const result = checkMessageLimits(raw, {
      maxRawBytes: 10_000,
      maxPayloadBytes: 10_000,
      maxFieldBytes: 100,
    });
    expect(result.ok).toBe(true);
  });

  it('checks all argument fields, not just the first', () => {
    const raw = JSON.stringify({
      topic: 't',
      correlation: 'c',
      arguments: {
        small: 'ok',
        big: 'x'.repeat(200),
      },
    });
    const result = checkMessageLimits(raw, {
      maxRawBytes: 10_000,
      maxPayloadBytes: 10_000,
      maxFieldBytes: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('big');
    }
  });
});

describe('Message limits: JSON depth', () => {
  it('rejects deeply nested JSON objects', () => {
    const raw = makeNestedJson(100);
    const result = checkMessageLimits(raw, {
      maxRawBytes: 100_000,
      maxJsonDepth: 64,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('depth');
      expect(result.error).toContain('64');
    }
  });

  it('rejects deeply nested JSON arrays', () => {
    const raw = makeNestedArrayJson(100);
    const result = checkMessageLimits(raw, {
      maxRawBytes: 100_000,
      maxJsonDepth: 64,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('depth');
    }
  });

  it('rejects mixed object/array nesting', () => {
    const raw = makeMixedNestedJson(100);
    const result = checkMessageLimits(raw, {
      maxRawBytes: 100_000,
      maxJsonDepth: 64,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('depth');
    }
  });

  it('allows JSON within the depth limit', () => {
    const raw = makeNestedJson(10);
    const result = checkMessageLimits(raw, {
      maxRawBytes: 100_000,
      maxJsonDepth: 64,
    });
    expect(result.ok).toBe(true);
  });

  it('allows JSON exactly at the depth limit', () => {
    // makeNestedJson(N) produces depth N+1 (outer wrapper adds 1 level)
    // so makeNestedJson(63) => depth 64 == limit
    const raw = makeNestedJson(63);
    const result = checkMessageLimits(raw, {
      maxRawBytes: 100_000,
      maxJsonDepth: 64,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects JSON one level over the depth limit', () => {
    // makeNestedJson(64) => depth 65 > limit of 64
    const raw = makeNestedJson(64);
    const result = checkMessageLimits(raw, {
      maxRawBytes: 100_000,
      maxJsonDepth: 64,
    });
    expect(result.ok).toBe(false);
  });
});

describe('Message limits: configuration', () => {
  it('uses default limits when no config is provided', () => {
    const small = makeRawPayload(100);
    const result = checkMessageLimits(small);
    expect(result.ok).toBe(true);
  });

  it('allows overriding individual limits', () => {
    const raw = makeRawPayload(200);
    // Override only maxRawBytes, rest should be defaults
    const result = checkMessageLimits(raw, { maxRawBytes: 100 });
    expect(result.ok).toBe(false);
  });

  it('allows all limits to be configured simultaneously', () => {
    const config: MessageLimitsConfig = {
      maxRawBytes: 500,
      maxPayloadBytes: 300,
      maxFieldBytes: 50,
      maxJsonDepth: 10,
    };
    const raw = makeNestedJson(15);
    const result = checkMessageLimits(raw, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('depth');
    }
  });
});

describe('Message limits: edge cases', () => {
  it('allows empty arguments object', () => {
    const raw = JSON.stringify({
      topic: 't',
      correlation: 'c',
      arguments: {},
    });
    const result = checkMessageLimits(raw);
    expect(result.ok).toBe(true);
  });

  it('allows empty string as message (does not reject as too small)', () => {
    // An empty string will fail JSON parsing but should not be rejected
    // by a "too small" check — size-based checks should pass for empty.
    const result = checkMessageLimits('');
    // Empty string is 0 bytes, within any limit. But JSON parse will fail.
    // The function should not reject on size — the parse failure is a
    // separate concern handled downstream.
    expect(result.ok).toBe(true);
  });

  it('returns descriptive error with limit name, actual value, and configured limit', () => {
    const raw = makeRawPayload(500);
    const result = checkMessageLimits(raw, { maxRawBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Must mention which limit
      expect(result.error).toContain('raw byte size');
      // Must mention actual value
      expect(result.error).toContain(String(Buffer.byteLength(raw)));
      // Must mention configured limit
      expect(result.error).toContain('100');
    }
  });
});

describe('Message limits: result type', () => {
  it('returns ok: true with no error on success', () => {
    const raw = makeRawPayload(100);
    const result = checkMessageLimits(raw);
    expect(result).toEqual({ ok: true });
  });

  it('returns ok: false with error string on failure', () => {
    const raw = makeRawPayload(500);
    const result = checkMessageLimits(raw, { maxRawBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
