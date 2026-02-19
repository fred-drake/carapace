import { describe, it, expect } from 'vitest';
import { ResponseSanitizer, REDACTED_PLACEHOLDER } from './response-sanitizer.js';
import type { SanitizeResult } from './response-sanitizer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitize(value: unknown): SanitizeResult {
  const sanitizer = new ResponseSanitizer();
  return sanitizer.sanitize(value);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResponseSanitizer', () => {
  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  describe('construction', () => {
    it('creates a sanitizer instance', () => {
      const sanitizer = new ResponseSanitizer();
      expect(sanitizer).toBeInstanceOf(ResponseSanitizer);
    });
  });

  // -----------------------------------------------------------------------
  // REDACTED_PLACEHOLDER
  // -----------------------------------------------------------------------

  describe('REDACTED_PLACEHOLDER', () => {
    it('is a bracketed string', () => {
      expect(REDACTED_PLACEHOLDER).toBe('[REDACTED]');
    });
  });

  // -----------------------------------------------------------------------
  // Pass-through for safe data
  // -----------------------------------------------------------------------

  describe('safe data pass-through', () => {
    it('passes through strings without credential patterns', () => {
      const result = sanitize('hello world');
      expect(result.value).toBe('hello world');
      expect(result.redactedPaths).toHaveLength(0);
    });

    it('passes through numbers unchanged', () => {
      const result = sanitize(42);
      expect(result.value).toBe(42);
      expect(result.redactedPaths).toHaveLength(0);
    });

    it('passes through booleans unchanged', () => {
      const result = sanitize(true);
      expect(result.value).toBe(true);
      expect(result.redactedPaths).toHaveLength(0);
    });

    it('passes through null unchanged', () => {
      const result = sanitize(null);
      expect(result.value).toBeNull();
      expect(result.redactedPaths).toHaveLength(0);
    });

    it('passes through undefined unchanged', () => {
      const result = sanitize(undefined);
      expect(result.value).toBeUndefined();
      expect(result.redactedPaths).toHaveLength(0);
    });

    it('passes through arrays of safe values', () => {
      const result = sanitize([1, 'safe', true]);
      expect(result.value).toEqual([1, 'safe', true]);
      expect(result.redactedPaths).toHaveLength(0);
    });

    it('passes through objects with safe values', () => {
      const data = { name: 'Alice', count: 5 };
      const result = sanitize(data);
      expect(result.value).toEqual(data);
      expect(result.redactedPaths).toHaveLength(0);
    });

    it('does not corrupt valid data that contains partial matches', () => {
      const data = {
        message: 'The bearer of this message is authorized',
        apiInfo: 'This API key concept is important',
        note: 'Use sk- prefix for your sketch files',
      };
      const result = sanitize(data);
      expect(result.value).toEqual(data);
      expect(result.redactedPaths).toHaveLength(0);
    });

    it('preserves empty strings', () => {
      const result = sanitize('');
      expect(result.value).toBe('');
      expect(result.redactedPaths).toHaveLength(0);
    });

    it('preserves empty objects', () => {
      const result = sanitize({});
      expect(result.value).toEqual({});
      expect(result.redactedPaths).toHaveLength(0);
    });

    it('preserves empty arrays', () => {
      const result = sanitize([]);
      expect(result.value).toEqual([]);
      expect(result.redactedPaths).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Bearer tokens
  // -----------------------------------------------------------------------

  describe('Bearer token sanitization', () => {
    it('redacts Bearer token in a string', () => {
      const result = sanitize(
        'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
      );
      expect(result.value).toBe(`Authorization: Bearer ${REDACTED_PLACEHOLDER}`);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts Bearer token in an object field', () => {
      const result = sanitize({
        headers: { Authorization: 'Bearer abc123def456' },
      });
      expect((result.value as Record<string, unknown>).headers).toEqual({
        Authorization: `Bearer ${REDACTED_PLACEHOLDER}`,
      });
      expect(result.redactedPaths).toEqual(['$.headers.Authorization']);
    });

    it('redacts bearer token case-insensitively', () => {
      const result = sanitize('bearer mytoken123');
      expect(result.value).toBe(`bearer ${REDACTED_PLACEHOLDER}`);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('does not redact the word bearer in normal text', () => {
      const result = sanitize('The bearer of bad news arrived');
      expect(result.value).toBe('The bearer of bad news arrived');
      expect(result.redactedPaths).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // API key patterns (sk-*, pk-*, key-*)
  // -----------------------------------------------------------------------

  describe('API key pattern sanitization', () => {
    it('redacts OpenAI-style sk- keys', () => {
      const result = sanitize('key: sk-abc123def456ghi789jklmno');
      expect(result.value).toBe(`key: ${REDACTED_PLACEHOLDER}`);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts Stripe-style sk_live_ keys', () => {
      const result = sanitize('sk_live_abc123def456');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts Stripe-style pk_live_ keys', () => {
      const result = sanitize('pk_live_abc123def456');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts sk_test_ keys', () => {
      const result = sanitize('sk_test_abc123def456');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts AWS access key IDs', () => {
      const result = sanitize('AKIAIOSFODNN7EXAMPLE');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts generic api_key= patterns', () => {
      const result = sanitize('url?api_key=abcdef123456789');
      expect(result.value).not.toContain('abcdef123456789');
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts X-API-Key header values', () => {
      const result = sanitize('X-API-Key: abcdef123456');
      expect(result.value).toBe(`X-API-Key: ${REDACTED_PLACEHOLDER}`);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts x-api-key case-insensitively', () => {
      const result = sanitize('x-api-key: mySecretKey123');
      expect(result.value).toBe(`x-api-key: ${REDACTED_PLACEHOLDER}`);
      expect(result.redactedPaths).toEqual(['$']);
    });
  });

  // -----------------------------------------------------------------------
  // OAuth / GitHub tokens
  // -----------------------------------------------------------------------

  describe('OAuth and GitHub token sanitization', () => {
    it('redacts GitHub personal access tokens (ghp_)', () => {
      const result = sanitize('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ123456');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts GitHub OAuth tokens (gho_)', () => {
      const result = sanitize('gho_abcdef123456789012345678901234567');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts GitHub App tokens (ghs_)', () => {
      const result = sanitize('ghs_abcdef123456789012345678901234567');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts github_pat_ tokens', () => {
      const result = sanitize('github_pat_abc123def456ghi789');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts Google OAuth tokens (ya29.)', () => {
      const result = sanitize('ya29.a0ARrdaM8_long_token_value_here');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });
  });

  // -----------------------------------------------------------------------
  // Connection strings
  // -----------------------------------------------------------------------

  describe('connection string sanitization', () => {
    it('redacts PostgreSQL connection strings', () => {
      const result = sanitize('postgres://user:password@localhost:5432/mydb');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts MySQL connection strings', () => {
      const result = sanitize('mysql://admin:secret@db.host.com:3306/app');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts MongoDB connection strings', () => {
      const result = sanitize('mongodb://user:pass@cluster.mongodb.net/db');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts MongoDB+srv connection strings', () => {
      const result = sanitize('mongodb+srv://user:pass@cluster.mongodb.net/db');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts Redis connection strings', () => {
      const result = sanitize('redis://user:pass@redis.host:6379/0');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts AMQP connection strings', () => {
      const result = sanitize('amqp://user:pass@rabbitmq.host:5672/vhost');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('does not redact URLs without credentials', () => {
      const result = sanitize('https://api.example.com/data');
      expect(result.value).toBe('https://api.example.com/data');
      expect(result.redactedPaths).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Generic secret patterns
  // -----------------------------------------------------------------------

  describe('generic secret pattern sanitization', () => {
    it('redacts private key headers', () => {
      const result = sanitize('-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('redacts generic private key headers', () => {
      const result = sanitize('-----BEGIN PRIVATE KEY-----\nMIIEvg...');
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$']);
    });
  });

  // -----------------------------------------------------------------------
  // Deep object traversal
  // -----------------------------------------------------------------------

  describe('deep object traversal', () => {
    it('sanitizes nested objects', () => {
      const data = {
        result: {
          user: 'alice',
          config: {
            dbUrl: 'postgres://admin:s3cret@db:5432/app',
          },
        },
      };
      const result = sanitize(data);
      const value = result.value as Record<string, Record<string, Record<string, string>>>;
      expect(value.result.config.dbUrl).toBe(REDACTED_PLACEHOLDER);
      expect(value.result.user).toBe('alice');
      expect(result.redactedPaths).toEqual(['$.result.config.dbUrl']);
    });

    it('sanitizes values inside arrays', () => {
      const data = {
        tokens: ['safe-value', 'Bearer secret123', 'another-safe'],
      };
      const result = sanitize(data);
      const value = result.value as Record<string, string[]>;
      expect(value.tokens[0]).toBe('safe-value');
      expect(value.tokens[1]).toBe(`Bearer ${REDACTED_PLACEHOLDER}`);
      expect(value.tokens[2]).toBe('another-safe');
      expect(result.redactedPaths).toEqual(['$.tokens[1]']);
    });

    it('sanitizes multiple fields and reports all paths', () => {
      const data = {
        primary: 'Bearer token1',
        secondary: { key: 'sk-abcdef123456' },
        safe: 'hello',
      };
      const result = sanitize(data);
      expect(result.redactedPaths).toHaveLength(2);
      expect(result.redactedPaths).toContain('$.primary');
      expect(result.redactedPaths).toContain('$.secondary.key');
    });

    it('handles deeply nested arrays of objects', () => {
      const data = {
        items: [
          { name: 'safe' },
          { name: 'also safe', secret: 'ghp_abc123def456ghi789jklmnopqrstuv12' },
        ],
      };
      const result = sanitize(data);
      const value = result.value as Record<string, Array<Record<string, string>>>;
      expect(value.items[0].name).toBe('safe');
      expect(value.items[1].name).toBe('also safe');
      expect(value.items[1].secret).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toEqual(['$.items[1].secret']);
    });
  });

  // -----------------------------------------------------------------------
  // Response payload shape (ResponsePayload)
  // -----------------------------------------------------------------------

  describe('ResponsePayload sanitization', () => {
    it('sanitizes a successful response payload result', () => {
      const payload = {
        result: {
          message: 'Created reminder',
          debug: 'Bearer eyJ.token.sig',
        },
        error: null,
      };
      const result = sanitize(payload);
      const value = result.value as Record<string, Record<string, string> | null>;
      expect(value.result!.message).toBe('Created reminder');
      expect(value.result!.debug).toBe(`Bearer ${REDACTED_PLACEHOLDER}`);
      expect(value.error).toBeNull();
    });

    it('sanitizes error message fields', () => {
      const payload = {
        result: null,
        error: {
          code: 'HANDLER_ERROR',
          message: 'Connection failed: postgres://admin:pass@db:5432/app',
          retriable: false,
        },
      };
      const result = sanitize(payload);
      const value = result.value as Record<string, unknown>;
      const error = value.error as Record<string, unknown>;
      expect(error.code).toBe('HANDLER_ERROR');
      expect(error.message).not.toContain('admin:pass');
      expect(error.retriable).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Does not corrupt valid data
  // -----------------------------------------------------------------------

  describe('data integrity', () => {
    it('preserves numeric values in objects', () => {
      const data = { count: 42, rate: 3.14, flag: true };
      const result = sanitize(data);
      expect(result.value).toEqual(data);
    });

    it('preserves nested structure shapes', () => {
      const data = {
        level1: {
          level2: {
            level3: ['a', 'b', 'c'],
          },
          sibling: 'value',
        },
      };
      const result = sanitize(data);
      expect(result.value).toEqual(data);
    });

    it('handles mixed arrays correctly', () => {
      const data = [1, 'safe', true, null, { key: 'value' }];
      const result = sanitize(data);
      expect(result.value).toEqual(data);
    });

    it('does not mutate the original input', () => {
      const data = {
        secret: 'Bearer mytoken123',
        safe: 'hello',
      };
      const original = JSON.parse(JSON.stringify(data));
      sanitize(data);
      expect(data).toEqual(original);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles strings with multiple credential patterns', () => {
      const input = 'Auth: Bearer abc123 and key sk-xyz789long';
      const result = sanitize(input);
      const value = result.value as string;
      expect(value).not.toContain('abc123');
      expect(value).not.toContain('xyz789');
      expect(result.redactedPaths).toEqual(['$']);
    });

    it('handles very long strings efficiently', () => {
      const safe = 'a'.repeat(10000);
      const result = sanitize(safe);
      expect(result.value).toBe(safe);
      expect(result.redactedPaths).toHaveLength(0);
    });

    it('handles circular-like deep structures up to reasonable depth', () => {
      // Build a 50-level deep object
      let obj: Record<string, unknown> = { value: 'Bearer deeptoken123' };
      for (let i = 0; i < 50; i++) {
        obj = { nested: obj };
      }
      const result = sanitize(obj);
      expect(result.redactedPaths.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple patterns in same value
  // -----------------------------------------------------------------------

  describe('multiple patterns in same string', () => {
    it('redacts multiple different pattern types', () => {
      const input = 'token=Bearer abc123, db=postgres://u:p@h/d';
      const result = sanitize(input);
      const value = result.value as string;
      expect(value).not.toContain('abc123');
      expect(value).not.toContain('u:p@');
      expect(result.redactedPaths).toEqual(['$']);
    });
  });
});
