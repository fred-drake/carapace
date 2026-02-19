import { describe, it, expect } from 'vitest';
import {
  ErrorCode,
  type ErrorCodeValue,
  type ErrorPayload,
  ERROR_RETRIABLE_DEFAULTS,
  RESERVED_PIPELINE_CODES,
} from './errors.js';

// ---------------------------------------------------------------------------
// ErrorCode
// ---------------------------------------------------------------------------

describe('ErrorCode', () => {
  const ALL_CODES = [
    'UNKNOWN_TOOL',
    'VALIDATION_FAILED',
    'UNAUTHORIZED',
    'RATE_LIMITED',
    'CONFIRMATION_TIMEOUT',
    'CONFIRMATION_DENIED',
    'PLUGIN_TIMEOUT',
    'PLUGIN_UNAVAILABLE',
    'PLUGIN_ERROR',
    'HANDLER_ERROR',
  ] as const;

  it('contains all 10 error codes', () => {
    expect(Object.keys(ErrorCode)).toHaveLength(10);

    for (const code of ALL_CODES) {
      expect(ErrorCode).toHaveProperty(code);
      expect(ErrorCode[code]).toBe(code);
    }
  });

  it('values are identical to their keys', () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(key).toBe(value);
    }
  });
});

// ---------------------------------------------------------------------------
// ERROR_RETRIABLE_DEFAULTS
// ---------------------------------------------------------------------------

describe('ERROR_RETRIABLE_DEFAULTS', () => {
  it('has entries for all 10 error codes', () => {
    const codes = Object.values(ErrorCode);
    expect(codes).toHaveLength(10);

    for (const code of codes) {
      expect(ERROR_RETRIABLE_DEFAULTS).toHaveProperty(code);
      expect(typeof ERROR_RETRIABLE_DEFAULTS[code]).toBe('boolean');
    }
  });

  it('marks the correct codes as retriable', () => {
    expect(ERROR_RETRIABLE_DEFAULTS[ErrorCode.UNKNOWN_TOOL]).toBe(false);
    expect(ERROR_RETRIABLE_DEFAULTS[ErrorCode.VALIDATION_FAILED]).toBe(false);
    expect(ERROR_RETRIABLE_DEFAULTS[ErrorCode.UNAUTHORIZED]).toBe(false);
    expect(ERROR_RETRIABLE_DEFAULTS[ErrorCode.RATE_LIMITED]).toBe(true);
    expect(ERROR_RETRIABLE_DEFAULTS[ErrorCode.CONFIRMATION_TIMEOUT]).toBe(true);
    expect(ERROR_RETRIABLE_DEFAULTS[ErrorCode.CONFIRMATION_DENIED]).toBe(false);
    expect(ERROR_RETRIABLE_DEFAULTS[ErrorCode.PLUGIN_TIMEOUT]).toBe(true);
    expect(ERROR_RETRIABLE_DEFAULTS[ErrorCode.PLUGIN_UNAVAILABLE]).toBe(true);
    expect(ERROR_RETRIABLE_DEFAULTS[ErrorCode.PLUGIN_ERROR]).toBe(false);
    expect(ERROR_RETRIABLE_DEFAULTS[ErrorCode.HANDLER_ERROR]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RESERVED_PIPELINE_CODES
// ---------------------------------------------------------------------------

describe('RESERVED_PIPELINE_CODES', () => {
  it('contains exactly 6 pipeline error codes', () => {
    expect(RESERVED_PIPELINE_CODES.size).toBe(6);
  });

  it('includes all pipeline codes (stages 2-5)', () => {
    expect(RESERVED_PIPELINE_CODES.has(ErrorCode.UNKNOWN_TOOL)).toBe(true);
    expect(RESERVED_PIPELINE_CODES.has(ErrorCode.VALIDATION_FAILED)).toBe(true);
    expect(RESERVED_PIPELINE_CODES.has(ErrorCode.UNAUTHORIZED)).toBe(true);
    expect(RESERVED_PIPELINE_CODES.has(ErrorCode.RATE_LIMITED)).toBe(true);
    expect(RESERVED_PIPELINE_CODES.has(ErrorCode.CONFIRMATION_TIMEOUT)).toBe(true);
    expect(RESERVED_PIPELINE_CODES.has(ErrorCode.CONFIRMATION_DENIED)).toBe(true);
  });

  it('excludes handler error codes', () => {
    expect(RESERVED_PIPELINE_CODES.has(ErrorCode.PLUGIN_TIMEOUT)).toBe(false);
    expect(RESERVED_PIPELINE_CODES.has(ErrorCode.PLUGIN_UNAVAILABLE)).toBe(false);
    expect(RESERVED_PIPELINE_CODES.has(ErrorCode.PLUGIN_ERROR)).toBe(false);
    expect(RESERVED_PIPELINE_CODES.has(ErrorCode.HANDLER_ERROR)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ErrorPayload
// ---------------------------------------------------------------------------

describe('ErrorPayload', () => {
  it('accepts all required fields', () => {
    const payload: ErrorPayload = {
      code: ErrorCode.PLUGIN_TIMEOUT,
      message: 'Reminders plugin did not respond within 30s',
      retriable: true,
    };

    expect(payload.code).toBe('PLUGIN_TIMEOUT');
    expect(payload.message).toBeDefined();
    expect(payload.retriable).toBe(true);
  });

  it('accepts optional fields', () => {
    const payload: ErrorPayload = {
      code: ErrorCode.VALIDATION_FAILED,
      message: 'additionalProperties "priority" not allowed',
      retriable: false,
      stage: 3,
      field: 'priority',
    };

    expect(payload.stage).toBe(3);
    expect(payload.field).toBe('priority');
  });

  it('accepts retry_after for rate limits', () => {
    const payload: ErrorPayload = {
      code: ErrorCode.RATE_LIMITED,
      message: 'Rate limit exceeded for create_reminder (10 requests/minute)',
      retriable: true,
      stage: 4,
      retry_after: 12,
    };

    expect(payload.retry_after).toBe(12);
  });

  it('omits optional fields when not applicable', () => {
    const payload: ErrorPayload = {
      code: ErrorCode.HANDLER_ERROR,
      message: 'Apple Reminders API returned 503',
      retriable: true,
    };

    expect(payload.stage).toBeUndefined();
    expect(payload.field).toBeUndefined();
    expect(payload.retry_after).toBeUndefined();
  });
});
