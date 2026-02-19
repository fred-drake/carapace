import { describe, it, expect } from 'vitest';
import { ToolError, isToolError } from './tool-error.js';
import { ErrorCode, ERROR_RETRIABLE_DEFAULTS } from '../types/errors.js';
import type { ErrorPayload } from '../types/errors.js';

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('ToolError', () => {
  describe('construction', () => {
    it('creates an instance with required fields', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'Something went wrong',
      });

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ToolError);
      expect(err.name).toBe('ToolError');
      expect(err.code).toBe('HANDLER_ERROR');
      expect(err.message).toBe('Something went wrong');
    });

    it('defaults retriable from ERROR_RETRIABLE_DEFAULTS', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'fail',
      });

      expect(err.retriable).toBe(ERROR_RETRIABLE_DEFAULTS[ErrorCode.HANDLER_ERROR]);
      expect(err.retriable).toBe(false);
    });

    it('allows overriding retriable', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'transient failure',
        retriable: true,
      });

      expect(err.retriable).toBe(true);
    });

    it('accepts optional field', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'bad input',
        field: 'email',
      });

      expect(err.field).toBe('email');
    });

    it('accepts optional retry_after', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'rate limited upstream',
        retriable: true,
        retry_after: 30,
      });

      expect(err.retry_after).toBe(30);
    });

    it('omits optional fields when not provided', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'basic error',
      });

      expect(err.field).toBeUndefined();
      expect(err.retry_after).toBeUndefined();
    });

    it('preserves stack trace', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'traced',
      });

      expect(err.stack).toBeDefined();
      expect(err.stack).toContain('ToolError');
    });
  });

  // ---------------------------------------------------------------------------
  // Reserved pipeline code normalization
  // ---------------------------------------------------------------------------

  describe('reserved pipeline code normalization', () => {
    it('normalizes reserved pipeline codes to HANDLER_ERROR', () => {
      const err = new ToolError({
        code: ErrorCode.UNKNOWN_TOOL,
        message: 'handler tried to use pipeline code',
      });

      expect(err.code).toBe(ErrorCode.HANDLER_ERROR);
    });

    it('normalizes VALIDATION_FAILED to HANDLER_ERROR', () => {
      const err = new ToolError({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'handler tried to spoof',
      });

      expect(err.code).toBe(ErrorCode.HANDLER_ERROR);
    });

    it('normalizes UNAUTHORIZED to HANDLER_ERROR', () => {
      const err = new ToolError({
        code: ErrorCode.UNAUTHORIZED,
        message: 'spoof',
      });

      expect(err.code).toBe(ErrorCode.HANDLER_ERROR);
    });

    it('normalizes RATE_LIMITED to HANDLER_ERROR', () => {
      const err = new ToolError({
        code: ErrorCode.RATE_LIMITED,
        message: 'spoof',
      });

      expect(err.code).toBe(ErrorCode.HANDLER_ERROR);
    });

    it('normalizes CONFIRMATION_TIMEOUT to HANDLER_ERROR', () => {
      const err = new ToolError({
        code: ErrorCode.CONFIRMATION_TIMEOUT,
        message: 'spoof',
      });

      expect(err.code).toBe(ErrorCode.HANDLER_ERROR);
    });

    it('normalizes CONFIRMATION_DENIED to HANDLER_ERROR', () => {
      const err = new ToolError({
        code: ErrorCode.CONFIRMATION_DENIED,
        message: 'spoof',
      });

      expect(err.code).toBe(ErrorCode.HANDLER_ERROR);
    });

    it('preserves original message when normalizing', () => {
      const err = new ToolError({
        code: ErrorCode.UNKNOWN_TOOL,
        message: 'original handler message',
      });

      expect(err.code).toBe(ErrorCode.HANDLER_ERROR);
      expect(err.message).toBe('original handler message');
    });

    it('allows HANDLER_ERROR code (not reserved)', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'legitimate',
      });

      expect(err.code).toBe(ErrorCode.HANDLER_ERROR);
    });

    it('allows PLUGIN_ERROR code (not reserved)', () => {
      const err = new ToolError({
        code: ErrorCode.PLUGIN_ERROR,
        message: 'legitimate',
      });

      expect(err.code).toBe(ErrorCode.PLUGIN_ERROR);
    });

    it('allows PLUGIN_TIMEOUT code (not reserved)', () => {
      const err = new ToolError({
        code: ErrorCode.PLUGIN_TIMEOUT,
        message: 'legitimate',
      });

      expect(err.code).toBe(ErrorCode.PLUGIN_TIMEOUT);
    });

    it('allows PLUGIN_UNAVAILABLE code (not reserved)', () => {
      const err = new ToolError({
        code: ErrorCode.PLUGIN_UNAVAILABLE,
        message: 'legitimate',
      });

      expect(err.code).toBe(ErrorCode.PLUGIN_UNAVAILABLE);
    });
  });

  // ---------------------------------------------------------------------------
  // toErrorPayload
  // ---------------------------------------------------------------------------

  describe('toErrorPayload', () => {
    it('produces a valid ErrorPayload with required fields', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'Apple API returned 503',
        retriable: true,
      });

      const payload: ErrorPayload = err.toErrorPayload();

      expect(payload).toEqual({
        code: 'HANDLER_ERROR',
        message: 'Apple API returned 503',
        retriable: true,
      });
    });

    it('includes field when provided', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'invalid email',
        field: 'email',
      });

      const payload = err.toErrorPayload();

      expect(payload.field).toBe('email');
    });

    it('includes retry_after when provided', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'upstream rate limited',
        retriable: true,
        retry_after: 60,
      });

      const payload = err.toErrorPayload();

      expect(payload.retry_after).toBe(60);
    });

    it('omits undefined optional fields from payload', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'basic',
      });

      const payload = err.toErrorPayload();

      expect('field' in payload).toBe(false);
      expect('retry_after' in payload).toBe(false);
      expect('stage' in payload).toBe(false);
    });

    it('does not include stack trace in payload', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'traced error',
      });

      const payload = err.toErrorPayload();
      const serialized = JSON.stringify(payload);

      expect(serialized).not.toContain('stack');
      expect(serialized).not.toContain('at ');
    });
  });

  // ---------------------------------------------------------------------------
  // isToolError — instanceof and duck-typing guard
  // ---------------------------------------------------------------------------

  describe('isToolError', () => {
    it('returns true for ToolError instances', () => {
      const err = new ToolError({
        code: ErrorCode.HANDLER_ERROR,
        message: 'test',
      });

      expect(isToolError(err)).toBe(true);
    });

    it('returns false for plain Error', () => {
      expect(isToolError(new Error('nope'))).toBe(false);
    });

    it('returns false for null', () => {
      expect(isToolError(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isToolError(undefined)).toBe(false);
    });

    it('returns false for strings', () => {
      expect(isToolError('HANDLER_ERROR')).toBe(false);
    });

    it('returns false for numbers', () => {
      expect(isToolError(42)).toBe(false);
    });

    it('returns false for plain object with ToolError-like fields', () => {
      const fake = {
        name: 'ToolError',
        code: 'HANDLER_ERROR',
        message: 'fake',
        retriable: false,
      };

      expect(isToolError(fake)).toBe(false);
    });

    it('returns false for object with __proto__ manipulated to look like ToolError', () => {
      const fake = Object.create(null) as Record<string, unknown>;
      fake.name = 'ToolError';
      fake.code = 'HANDLER_ERROR';
      fake.message = 'proto hack';
      fake.retriable = false;

      expect(isToolError(fake)).toBe(false);
    });

    it('returns false for Error subclass with ToolError fields', () => {
      class FakeToolError extends Error {
        code = 'HANDLER_ERROR';
        retriable = false;
        constructor(message: string) {
          super(message);
          this.name = 'ToolError';
        }
      }

      expect(isToolError(new FakeToolError('impersonator'))).toBe(false);
    });

    it('returns true for ToolError from same module (identity check)', () => {
      const err = new ToolError({
        code: ErrorCode.PLUGIN_ERROR,
        message: 'same module',
      });

      // Direct instanceof should work within same module
      expect(err instanceof ToolError).toBe(true);
      expect(isToolError(err)).toBe(true);
    });
  });
});
