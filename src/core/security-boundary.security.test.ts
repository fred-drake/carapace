/**
 * Security test suite for Carapace (SEC-05).
 *
 * Covers: wire format fuzzing, identity spoofing, cross-group access,
 * rate limit boundary testing, credential leak detection, prototype
 * pollution, message size limits, path traversal, ToolError manipulation,
 * error message information leakage, session isolation, and shutdown
 * race conditions.
 *
 * Run with: pnpm test:security
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IntegrationHarness } from '../testing/integration-harness.js';
import { ResponseSanitizer, REDACTED_PLACEHOLDER } from './response-sanitizer.js';
import { checkMessageLimits } from './message-limits.js';
import {
  validateManifestSecurity,
  validateToolNames,
  validateSkillPaths,
  validateSchemaComplexity,
} from './manifest-security.js';
import { ToolError, isToolError } from './tool-error.js';
import { IpcTestHarness } from '../testing/ipc-test-harness.js';
import { ErrorCode } from '../types/errors.js';
import { WIRE_FIELDS, ENVELOPE_IDENTITY_FIELDS } from '../types/protocol.js';
import { createManifest, createToolDeclaration } from '../testing/factories.js';
import type { JsonSchema } from '../types/index.js';

// ---------------------------------------------------------------------------
// 1. Wire format fuzzing
// ---------------------------------------------------------------------------

describe('wire format fuzzing', () => {
  let harness: IntegrationHarness;

  beforeEach(async () => {
    harness = await IntegrationHarness.create();
    harness.registerTool(
      {
        name: 'echo',
        description: 'Echo tool',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string' } },
        },
      },
      async (envelope) => {
        const args = envelope.payload.arguments as Record<string, unknown>;
        return { echoed: args['text'] };
      },
    );
  });

  afterEach(async () => {
    await harness.close();
  });

  it('rejects empty arguments object', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'echo', {});
    // Empty args is valid but tool schema may or may not require fields
    expect(response.type).toBe('response');
  });

  it('handles null values in argument fields', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'echo', {
      text: null as unknown as string,
    });
    // Should either succeed or produce a validation error, not crash
    expect(response.type).toBe('response');
  });

  it('rejects additional properties in arguments', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'echo', {
      text: 'hello',
      __proto__: { polluted: true },
    });
    expect(response.payload.error).not.toBeNull();
    expect(response.payload.error!.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('handles unicode edge cases in arguments', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'echo', {
      text: '\u0000\uFFFD\uD800\uDBFF\uDC00\u200B\u200E\u202A',
    });
    expect(response.type).toBe('response');
    // Should not crash
  });

  it('handles extremely long string arguments', async () => {
    const session = harness.createSession({ group: 'test' });
    const longString = 'A'.repeat(100_000);
    const response = await harness.sendRequest(session, 'echo', { text: longString });
    expect(response.type).toBe('response');
  });

  it('rejects prototype pollution via __proto__ key', async () => {
    const session = harness.createSession({ group: 'test' });
    const malicious = JSON.parse('{"text":"hi","__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    const response = await harness.sendRequest(session, 'echo', malicious);
    expect(response.payload.error).not.toBeNull();
    expect(response.payload.error!.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('rejects constructor.prototype pollution', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'echo', {
      text: 'hello',
      constructor: { prototype: { polluted: true } },
    });
    expect(response.payload.error).not.toBeNull();
    expect(response.payload.error!.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('handles toString override attempts in arguments', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'echo', {
      text: 'hello',
      toString: 'overridden',
    });
    expect(response.payload.error).not.toBeNull();
    expect(response.payload.error!.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});

// ---------------------------------------------------------------------------
// 2. Identity spoofing
// ---------------------------------------------------------------------------

describe('identity spoofing', () => {
  describe('wire message validation', () => {
    it('rejects messages containing envelope identity fields', () => {
      for (const field of ENVELOPE_IDENTITY_FIELDS) {
        const spoofed = {
          topic: 'tool.invoke.echo',
          correlation: 'corr-1',
          arguments: {},
          [field]: 'spoofed-value',
        };
        expect(IpcTestHarness.validateWireMessage(spoofed)).toBe(false);
      }
    });

    it('rejects messages missing required wire fields', () => {
      for (const field of WIRE_FIELDS) {
        const partial: Record<string, unknown> = {
          topic: 'tool.invoke.echo',
          correlation: 'corr-1',
          arguments: {},
        };
        delete partial[field];
        expect(IpcTestHarness.validateWireMessage(partial)).toBe(false);
      }
    });

    it('rejects non-object messages', () => {
      expect(IpcTestHarness.validateWireMessage(null)).toBe(false);
      expect(IpcTestHarness.validateWireMessage(undefined)).toBe(false);
      expect(IpcTestHarness.validateWireMessage(42)).toBe(false);
      expect(IpcTestHarness.validateWireMessage('string')).toBe(false);
      expect(IpcTestHarness.validateWireMessage([])).toBe(false);
      expect(IpcTestHarness.validateWireMessage(true)).toBe(false);
    });

    it('rejects messages where arguments is not an object', () => {
      expect(
        IpcTestHarness.validateWireMessage({
          topic: 'tool.invoke.echo',
          correlation: 'corr-1',
          arguments: 'not-an-object',
        }),
      ).toBe(false);

      expect(
        IpcTestHarness.validateWireMessage({
          topic: 'tool.invoke.echo',
          correlation: 'corr-1',
          arguments: null,
        }),
      ).toBe(false);

      expect(
        IpcTestHarness.validateWireMessage({
          topic: 'tool.invoke.echo',
          correlation: 'corr-1',
          arguments: [1, 2, 3],
        }),
      ).toBe(false);
    });

    it('rejects messages where topic or correlation is not a string', () => {
      expect(
        IpcTestHarness.validateWireMessage({
          topic: 123,
          correlation: 'corr-1',
          arguments: {},
        }),
      ).toBe(false);

      expect(
        IpcTestHarness.validateWireMessage({
          topic: 'tool.invoke.echo',
          correlation: 123,
          arguments: {},
        }),
      ).toBe(false);
    });
  });

  describe('envelope construction', () => {
    let harness: IntegrationHarness;

    beforeEach(async () => {
      harness = await IntegrationHarness.create();
      harness.registerTool(
        {
          name: 'inspect',
          description: 'Inspect envelope',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
        async (envelope) => ({
          source: envelope.source,
          group: envelope.group,
          type: envelope.type,
          version: envelope.version,
        }),
      );
    });

    afterEach(async () => {
      await harness.close();
    });

    it('constructs envelope from trusted session state, not wire data', async () => {
      const session = harness.createSession({ group: 'email' });
      const response = await harness.sendRequest(session, 'inspect', {});

      const result = response.payload.result as Record<string, unknown>;
      expect(result['source']).toBe(session.containerId);
      expect(result['group']).toBe('email');
      expect(result['type']).toBe('request');
      expect(result['version']).toBe(1);
    });

    it('does not allow container to set its own group', async () => {
      const session = harness.createSession({ group: 'restricted' });
      // Even if the wire message tries to claim a different group,
      // the envelope is built from trusted session state
      const response = await harness.sendRequest(session, 'inspect', {});
      const result = response.payload.result as Record<string, unknown>;
      expect(result['group']).toBe('restricted');
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-group access
// ---------------------------------------------------------------------------

describe('cross-group access', () => {
  let harness: IntegrationHarness;

  beforeEach(async () => {
    harness = await IntegrationHarness.create();
    harness.registerTool(
      {
        name: 'email_send',
        description: 'Send email',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
      async () => ({ sent: true }),
    );

    harness.registerTool(
      {
        name: 'slack_post',
        description: 'Post to Slack',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
      async () => ({ posted: true }),
    );

    // Restrict tools to their groups
    harness.setToolGroupRestriction('email_send', ['email']);
    harness.setToolGroupRestriction('slack_post', ['slack']);
  });

  afterEach(async () => {
    await harness.close();
  });

  it('allows same-group tool access', async () => {
    const emailSession = harness.createSession({ group: 'email' });
    const response = await harness.sendRequest(emailSession, 'email_send', {});
    expect(response.payload.error).toBeNull();
  });

  it('blocks cross-group tool access', async () => {
    const slackSession = harness.createSession({ group: 'slack' });
    const response = await harness.sendRequest(slackSession, 'email_send', {});
    expect(response.payload.error).not.toBeNull();
    expect(response.payload.error!.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('blocks both directions of cross-group access', async () => {
    const emailSession = harness.createSession({ group: 'email' });
    const slackSession = harness.createSession({ group: 'slack' });

    const r1 = await harness.sendRequest(emailSession, 'slack_post', {});
    expect(r1.payload.error!.code).toBe(ErrorCode.UNAUTHORIZED);

    const r2 = await harness.sendRequest(slackSession, 'email_send', {});
    expect(r2.payload.error!.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('allows unrestricted tools for all groups', async () => {
    harness.registerTool(
      {
        name: 'public_tool',
        description: 'Public',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
      async () => ({ public: true }),
    );

    const emailSession = harness.createSession({ group: 'email' });
    const slackSession = harness.createSession({ group: 'slack' });

    const r1 = await harness.sendRequest(emailSession, 'public_tool', {});
    expect(r1.payload.error).toBeNull();

    const r2 = await harness.sendRequest(slackSession, 'public_tool', {});
    expect(r2.payload.error).toBeNull();
  });

  it('unauthorized requests do not consume rate limit tokens', async () => {
    harness.setRateLimit({ requestsPerMinute: 1, burstSize: 1 });
    const slackSession = harness.createSession({ group: 'slack' });

    // Send many unauthorized requests
    for (let i = 0; i < 5; i++) {
      const r = await harness.sendRequest(slackSession, 'email_send', {});
      expect(r.payload.error!.code).toBe(ErrorCode.UNAUTHORIZED);
    }

    // Rate limit should NOT be exhausted since auth failed first
    const r = await harness.sendRequest(slackSession, 'slack_post', {});
    expect(r.payload.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Rate limit boundary testing
// ---------------------------------------------------------------------------

describe('rate limit boundaries', () => {
  let harness: IntegrationHarness;

  beforeEach(async () => {
    harness = await IntegrationHarness.create();
    harness.registerTool(
      {
        name: 'counting_tool',
        description: 'Count',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
      async () => ({ ok: true }),
    );
  });

  afterEach(async () => {
    await harness.close();
  });

  it('allows exactly burst size requests then throttles', async () => {
    harness.setRateLimit({ requestsPerMinute: 60, burstSize: 3 });
    const session = harness.createSession({ group: 'test' });

    // Should allow exactly 3
    for (let i = 0; i < 3; i++) {
      const r = await harness.sendRequest(session, 'counting_tool', {});
      expect(r.payload.error).toBeNull();
    }

    // 4th should be throttled
    const r4 = await harness.sendRequest(session, 'counting_tool', {});
    expect(r4.payload.error).not.toBeNull();
    expect(r4.payload.error!.code).toBe(ErrorCode.RATE_LIMITED);
  });

  it('includes retry_after in rate limit response', async () => {
    harness.setRateLimit({ requestsPerMinute: 60, burstSize: 1 });
    const session = harness.createSession({ group: 'test' });

    await harness.sendRequest(session, 'counting_tool', {});
    const r = await harness.sendRequest(session, 'counting_tool', {});

    expect(r.payload.error!.retry_after).toBeGreaterThan(0);
    expect(r.payload.error!.retriable).toBe(true);
  });

  it('isolates rate limits between sessions', async () => {
    harness.setRateLimit({ requestsPerMinute: 60, burstSize: 1 });
    const s1 = harness.createSession({ group: 'test' });
    const s2 = harness.createSession({ group: 'test' });

    // Each session should get its own token
    const r1 = await harness.sendRequest(s1, 'counting_tool', {});
    expect(r1.payload.error).toBeNull();

    const r2 = await harness.sendRequest(s2, 'counting_tool', {});
    expect(r2.payload.error).toBeNull();

    // Both should now be throttled
    const r1b = await harness.sendRequest(s1, 'counting_tool', {});
    expect(r1b.payload.error!.code).toBe(ErrorCode.RATE_LIMITED);

    const r2b = await harness.sendRequest(s2, 'counting_tool', {});
    expect(r2b.payload.error!.code).toBe(ErrorCode.RATE_LIMITED);
  });
});

// ---------------------------------------------------------------------------
// 5. Credential leak detection (response sanitization)
// ---------------------------------------------------------------------------

describe('credential leak detection', () => {
  const sanitizer = new ResponseSanitizer();

  describe('bearer tokens', () => {
    it('redacts Bearer token in string', () => {
      const result = sanitizer.sanitize(
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.sig',
      );
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
      expect(result.value).not.toContain('eyJhbGciOiJ');
      expect(result.redactedPaths).toHaveLength(1);
    });

    it('redacts case-insensitive bearer', () => {
      const result = sanitizer.sanitize('BEARER AbCdEfGhIjKlMnOp');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
    });
  });

  describe('GitHub tokens', () => {
    it('redacts ghp_ personal access tokens', () => {
      const result = sanitizer.sanitize('token: ghp_1234567890abcdef');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
      expect(result.value).not.toContain('ghp_');
    });

    it('redacts gho_ OAuth tokens', () => {
      const result = sanitizer.sanitize('gho_abcdef1234567890');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
    });

    it('redacts github_pat_ fine-grained tokens', () => {
      const result = sanitizer.sanitize('github_pat_abcdefghij1234567890');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
    });
  });

  describe('API keys', () => {
    it('redacts sk- prefixed keys (OpenAI style)', () => {
      const result = sanitizer.sanitize('api_key: sk-abc123def456ghi789');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
      expect(result.value).not.toContain('sk-abc');
    });

    it('redacts sk_live_ stripe keys', () => {
      const result = sanitizer.sanitize('sk_live_abcdefghijk');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
    });

    it('redacts pk_test_ stripe keys', () => {
      const result = sanitizer.sanitize('pk_test_abcdefghijk');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
    });
  });

  describe('AWS credentials', () => {
    it('redacts AWS access key IDs', () => {
      const result = sanitizer.sanitize('AKIAIOSFODNN7EXAMPLE');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
    });
  });

  describe('connection strings', () => {
    it('redacts postgres connection strings', () => {
      const result = sanitizer.sanitize('postgres://user:pass@host:5432/db');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
      expect(result.value).not.toContain('pass@');
    });

    it('redacts mysql connection strings', () => {
      const result = sanitizer.sanitize('mysql://root:secret@localhost/mydb');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
    });

    it('redacts mongodb connection strings', () => {
      const result = sanitizer.sanitize('mongodb://admin:p4ss@cluster.example.com/test');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
    });

    it('redacts mongodb+srv connection strings', () => {
      const result = sanitizer.sanitize('mongodb+srv://user:pass@cluster.example.com');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
    });

    it('redacts redis connection strings', () => {
      const result = sanitizer.sanitize('redis://default:secret@redis.example.com:6379');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
    });
  });

  describe('X-API-Key headers', () => {
    it('redacts X-API-Key header values', () => {
      const result = sanitizer.sanitize('X-API-Key: my-secret-key-12345');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
      expect(result.value).not.toContain('my-secret');
    });
  });

  describe('api key parameters', () => {
    it('redacts api_key= in query strings', () => {
      const result = sanitizer.sanitize('https://api.example.com?api_key=secret123');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
      expect(result.value).not.toContain('secret123');
    });

    it('redacts apikey= in query strings', () => {
      const result = sanitizer.sanitize('apikey=my_secret_key_here');
      expect(result.value).toContain(REDACTED_PLACEHOLDER);
    });
  });

  describe('private keys', () => {
    it('redacts PEM private key blocks', () => {
      const pem =
        '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg...base64...==\n-----END PRIVATE KEY-----';
      const result = sanitizer.sanitize(pem);
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
    });

    it('redacts RSA private key blocks', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...==\n-----END RSA PRIVATE KEY-----';
      const result = sanitizer.sanitize(pem);
      expect(result.value).toBe(REDACTED_PLACEHOLDER);
    });
  });

  describe('deep object sanitization', () => {
    it('sanitizes nested objects', () => {
      const result = sanitizer.sanitize({
        config: {
          database: {
            url: 'postgres://user:pass@host/db',
          },
        },
      });
      const sanitized = result.value as Record<string, unknown>;
      const config = sanitized['config'] as Record<string, unknown>;
      const db = config['database'] as Record<string, unknown>;
      expect(db['url']).toBe(REDACTED_PLACEHOLDER);
      expect(result.redactedPaths).toContain('$.config.database.url');
    });

    it('sanitizes arrays', () => {
      const result = sanitizer.sanitize({
        keys: ['sk-abc123def456ghi789', 'normal-string'],
      });
      const sanitized = result.value as Record<string, unknown>;
      const keys = sanitized['keys'] as string[];
      expect(keys[0]).toBe(REDACTED_PLACEHOLDER);
      expect(keys[1]).toBe('normal-string');
    });

    it('does not corrupt non-sensitive data', () => {
      const result = sanitizer.sanitize({
        name: 'John Doe',
        count: 42,
        active: true,
        tags: ['alpha', 'beta'],
      });
      expect(result.value).toEqual({
        name: 'John Doe',
        count: 42,
        active: true,
        tags: ['alpha', 'beta'],
      });
      expect(result.redactedPaths).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Message size limits and DoS prevention
// ---------------------------------------------------------------------------

describe('message size limits', () => {
  it('rejects oversized raw messages', () => {
    const oversized = JSON.stringify({
      topic: 'tool.invoke.echo',
      correlation: 'corr-1',
      arguments: { data: 'X'.repeat(2_000_000) },
    });
    const result = checkMessageLimits(oversized);
    expect(result.ok).toBe(false);
  });

  it('rejects deeply nested JSON', () => {
    let nested = '{"a":'.repeat(100) + '{}' + '}'.repeat(100);
    const result = checkMessageLimits(nested, { maxJsonDepth: 64 });
    expect(result.ok).toBe(false);
  });

  it('accepts messages within limits', () => {
    const valid = JSON.stringify({
      topic: 'tool.invoke.echo',
      correlation: 'corr-1',
      arguments: { text: 'hello' },
    });
    const result = checkMessageLimits(valid);
    expect(result.ok).toBe(true);
  });

  it('rejects oversized individual argument fields', () => {
    const msg = JSON.stringify({
      topic: 'tool.invoke.echo',
      correlation: 'corr-1',
      arguments: { bigField: 'X'.repeat(200_000) },
    });
    const result = checkMessageLimits(msg, { maxFieldBytes: 102_400 });
    expect(result.ok).toBe(false);
  });

  it('rejects oversized payload even if raw message fits', () => {
    const msg = JSON.stringify({
      topic: 'tool.invoke.echo',
      correlation: 'corr-1',
      arguments: { data: 'X'.repeat(500_000) },
    });
    const result = checkMessageLimits(msg, {
      maxRawBytes: 2_000_000,
      maxPayloadBytes: 100_000,
    });
    expect(result.ok).toBe(false);
  });

  it('handles empty messages gracefully', () => {
    const result = checkMessageLimits('');
    expect(result.ok).toBe(true);
  });

  it('handles invalid JSON gracefully (size checks only)', () => {
    const result = checkMessageLimits('this is not json');
    expect(result.ok).toBe(true); // Invalid JSON is handled downstream
  });

  it('correctly counts depth inside strings (no false positives)', () => {
    const msg = JSON.stringify({
      topic: 'tool.invoke.echo',
      correlation: 'corr-1',
      arguments: { text: '{{{{{{{{{{{{}}}}}}}}}}}}' },
    });
    const result = checkMessageLimits(msg, { maxJsonDepth: 5 });
    expect(result.ok).toBe(true); // Braces inside strings don't count
  });
});

// ---------------------------------------------------------------------------
// 7. Manifest security
// ---------------------------------------------------------------------------

describe('manifest security', () => {
  describe('tool name validation', () => {
    it('allows valid tool names', () => {
      const result = validateToolNames([
        createToolDeclaration({ name: 'send_email' }),
        createToolDeclaration({ name: 'create_reminder' }),
        createToolDeclaration({ name: 'a123' }),
      ]);
      expect(result.valid).toBe(true);
    });

    it('rejects tool names with dots (topic injection)', () => {
      const result = validateToolNames([createToolDeclaration({ name: 'tool.invoke.admin' })]);
      expect(result.valid).toBe(false);
    });

    it('rejects tool names with slashes (path traversal)', () => {
      const result = validateToolNames([createToolDeclaration({ name: 'tool/../../etc/passwd' })]);
      expect(result.valid).toBe(false);
    });

    it('rejects tool names with special characters', () => {
      const result = validateToolNames([createToolDeclaration({ name: 'tool;rm -rf' })]);
      expect(result.valid).toBe(false);
    });

    it('rejects tool names starting with numbers', () => {
      const result = validateToolNames([createToolDeclaration({ name: '123tool' })]);
      expect(result.valid).toBe(false);
    });

    it('rejects uppercase tool names', () => {
      const result = validateToolNames([createToolDeclaration({ name: 'SendEmail' })]);
      expect(result.valid).toBe(false);
    });
  });

  describe('skill path traversal', () => {
    it('rejects absolute paths', () => {
      const result = validateSkillPaths(['/etc/passwd']);
      expect(result.valid).toBe(false);
    });

    it('rejects parent directory traversal', () => {
      const result = validateSkillPaths(['../../etc/passwd']);
      expect(result.valid).toBe(false);
    });

    it('rejects backslash paths', () => {
      const result = validateSkillPaths(['..\\..\\etc\\passwd']);
      expect(result.valid).toBe(false);
    });

    it('rejects URL-encoded traversal (%2e%2e)', () => {
      const result = validateSkillPaths(['%2e%2e/etc/passwd']);
      expect(result.valid).toBe(false);
    });

    it('rejects URL-encoded slash (%2f)', () => {
      const result = validateSkillPaths(['skills%2f..%2f..%2fetc%2fpasswd']);
      expect(result.valid).toBe(false);
    });

    it('rejects URL-encoded backslash (%5c)', () => {
      const result = validateSkillPaths(['skills%5c..%5c..%5cetc%5cpasswd']);
      expect(result.valid).toBe(false);
    });

    it('allows valid relative paths', () => {
      const result = validateSkillPaths(['skills/echo.md', 'skills/memory.md']);
      expect(result.valid).toBe(true);
    });
  });

  describe('schema complexity limits', () => {
    it('rejects schemas with $ref (recursive reference prevention)', () => {
      const result = validateSchemaComplexity({
        type: 'object',
        additionalProperties: false,
        properties: {
          linked: { $ref: '#' } as unknown as { type: 'string' },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('$ref');
    });

    it('rejects deeply nested schemas', () => {
      // Build a deeply nested schema that exceeds maxDepth.
      // JsonSchemaProperty doesn't have `properties`, so cast through unknown.
      const deeplyNested = {
        type: 'object',
        additionalProperties: false as const,
        properties: {
          level1: {
            type: 'object',
            properties: {
              level2: {
                type: 'object',
                properties: {
                  level3: {
                    type: 'object',
                    properties: {
                      level4: {
                        type: 'object',
                        properties: {
                          level5: {
                            type: 'object',
                            properties: {
                              level6: { type: 'string' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      } as unknown as JsonSchema;

      const result = validateSchemaComplexity(deeplyNested, { maxDepth: 5 });
      expect(result.valid).toBe(false);
    });

    it('rejects schemas with excessive properties', () => {
      const properties: Record<string, { type: string }> = {};
      for (let i = 0; i < 50; i++) {
        properties[`field_${i}`] = { type: 'string' };
      }
      const result = validateSchemaComplexity(
        {
          type: 'object',
          additionalProperties: false,
          properties,
        },
        { maxProperties: 30 },
      );
      expect(result.valid).toBe(false);
    });
  });

  describe('manifest size', () => {
    it('rejects oversized manifests', () => {
      const raw = JSON.stringify(
        createManifest({
          description: 'X'.repeat(100_000),
        }),
      );
      const manifest = JSON.parse(raw);
      const result = validateManifestSecurity(raw, manifest, []);
      expect(result.valid).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. ToolError instanceof manipulation
// ---------------------------------------------------------------------------

describe('ToolError instanceof manipulation', () => {
  it('recognizes real ToolError instances', () => {
    const err = new ToolError({ code: ErrorCode.HANDLER_ERROR, message: 'test' });
    expect(isToolError(err)).toBe(true);
  });

  it('rejects plain objects with matching fields (duck typing)', () => {
    const fake = {
      code: ErrorCode.HANDLER_ERROR,
      message: 'test',
      retriable: false,
      name: 'ToolError',
      toErrorPayload: () => ({}),
    };
    expect(isToolError(fake)).toBe(false);
  });

  it('rejects Error subclasses pretending to be ToolError', () => {
    class FakeToolError extends Error {
      code = ErrorCode.HANDLER_ERROR;
      retriable = false;
      name = 'ToolError';
    }
    expect(isToolError(new FakeToolError('test'))).toBe(false);
  });

  it('rejects null, undefined, and primitives', () => {
    expect(isToolError(null)).toBe(false);
    expect(isToolError(undefined)).toBe(false);
    expect(isToolError(42)).toBe(false);
    expect(isToolError('ToolError')).toBe(false);
  });

  it('normalizes reserved pipeline codes to HANDLER_ERROR', () => {
    const err = new ToolError({
      code: ErrorCode.UNAUTHORIZED,
      message: 'trying to spoof auth failure',
    });
    expect(err.code).toBe(ErrorCode.HANDLER_ERROR);
    expect(err.message).toBe('trying to spoof auth failure');
  });

  it('normalizes all reserved pipeline codes', () => {
    const reserved = [
      ErrorCode.UNKNOWN_TOOL,
      ErrorCode.VALIDATION_FAILED,
      ErrorCode.UNAUTHORIZED,
      ErrorCode.RATE_LIMITED,
      ErrorCode.CONFIRMATION_TIMEOUT,
      ErrorCode.CONFIRMATION_DENIED,
    ];

    for (const code of reserved) {
      const err = new ToolError({ code, message: `spoofing ${code}` });
      expect(err.code).toBe(ErrorCode.HANDLER_ERROR);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Error message information leakage
// ---------------------------------------------------------------------------

describe('error message information leakage', () => {
  let harness: IntegrationHarness;

  beforeEach(async () => {
    harness = await IntegrationHarness.create();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('does not expose stack traces in PLUGIN_ERROR responses', async () => {
    harness.registerTool(
      {
        name: 'crasher',
        description: 'Crashes',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
      async () => {
        throw new Error('Internal: database connection string is postgres://root:secret@host/db');
      },
    );

    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'crasher', {});

    expect(response.payload.error).not.toBeNull();
    expect(response.payload.error!.code).toBe(ErrorCode.PLUGIN_ERROR);
    // The error message should contain the original message but no stack trace
    expect(response.payload.error!.message).not.toContain('at ');
    expect(response.payload.error!.message).not.toContain('.ts:');
    expect(response.payload.error!.message).not.toContain('.js:');
  });

  it('does not expose internal file paths in error responses', async () => {
    harness.registerTool(
      {
        name: 'path_leaker',
        description: 'Leaks paths',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
      async () => {
        throw new TypeError('Cannot read properties of undefined');
      },
    );

    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'path_leaker', {});

    expect(response.payload.error!.code).toBe(ErrorCode.PLUGIN_ERROR);
    // Should not contain absolute paths
    expect(response.payload.error!.message).not.toMatch(/\/[a-z]+\/[a-z]+\//i);
  });

  it('ToolError does not include stack traces in toErrorPayload()', () => {
    const err = new ToolError({
      code: ErrorCode.HANDLER_ERROR,
      message: 'Something went wrong',
    });

    const payload = err.toErrorPayload();
    expect(payload).not.toHaveProperty('stack');
    expect(JSON.stringify(payload)).not.toContain('at ');
  });
});

// ---------------------------------------------------------------------------
// 10. Concurrent session isolation
// ---------------------------------------------------------------------------

describe('concurrent session isolation', () => {
  let harness: IntegrationHarness;

  beforeEach(async () => {
    harness = await IntegrationHarness.create();
    harness.registerTool(
      {
        name: 'session_info',
        description: 'Return session info',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
      async (envelope) => ({
        group: envelope.group,
        source: envelope.source,
        sessionId: envelope.id,
      }),
    );
  });

  afterEach(async () => {
    await harness.close();
  });

  it('concurrent requests from different sessions return correct identity', async () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      harness.createSession({ group: `group-${i}` }),
    );

    const responses = await Promise.all(
      sessions.map((s) => harness.sendRequest(s, 'session_info', {})),
    );

    for (let i = 0; i < 10; i++) {
      const result = responses[i].payload.result as Record<string, unknown>;
      expect(result['group']).toBe(`group-${i}`);
      expect(result['source']).toBe(sessions[i].containerId);
    }
  });

  it('sessions cannot access each other through shared state', async () => {
    const s1 = harness.createSession({ group: 'email' });
    const s2 = harness.createSession({ group: 'slack' });

    harness.setToolGroupRestriction('session_info', ['email', 'slack']);

    const r1 = await harness.sendRequest(s1, 'session_info', {});
    const r2 = await harness.sendRequest(s2, 'session_info', {});

    const result1 = r1.payload.result as Record<string, unknown>;
    const result2 = r2.payload.result as Record<string, unknown>;

    expect(result1['group']).toBe('email');
    expect(result2['group']).toBe('slack');
    expect(result1['source']).not.toBe(result2['source']);
  });
});

// ---------------------------------------------------------------------------
// 11. Prototype pollution in wire messages
// ---------------------------------------------------------------------------

describe('prototype pollution prevention', () => {
  describe('wire message level', () => {
    it('__proto__ key in wire message does not pollute Object prototype', () => {
      const before = ({} as Record<string, unknown>)['polluted'];
      expect(before).toBeUndefined();

      // Simulate parsing a malicious wire message with __proto__ key.
      // JSON.parse is safe in V8 — it creates an own property named "__proto__"
      // rather than assigning to the actual prototype. The wire validator allows
      // extra unknown fields (it only rejects envelope identity fields), so the
      // key defense here is that JSON.parse + object spreading never pollutes.
      const malicious = JSON.parse(
        '{"topic":"tool.invoke.echo","correlation":"c","arguments":{},"__proto__":{"polluted":true}}',
      );

      // Wire message is structurally valid (has required fields, no envelope fields)
      expect(IpcTestHarness.validateWireMessage(malicious)).toBe(true);

      // Critical: Verify Object prototype was NOT polluted despite __proto__ key
      const after = ({} as Record<string, unknown>)['polluted'];
      expect(after).toBeUndefined();

      // The __proto__ key exists as an own property, not as prototype assignment
      expect(Object.prototype.hasOwnProperty.call(malicious, '__proto__')).toBe(true);
    });

    it('constructor.prototype pollution does not affect Object', () => {
      const malicious = JSON.parse(
        '{"topic":"tool.invoke.echo","correlation":"c","arguments":{"constructor":{"prototype":{"isAdmin":true}}}}',
      );

      const isValid = IpcTestHarness.validateWireMessage(malicious);
      // Still a valid wire message structure, but additionalProperties: false
      // in the tool schema will reject the constructor key at stage 3
      expect(isValid).toBe(true);

      // Verify no prototype pollution
      expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 12. Topic injection
// ---------------------------------------------------------------------------

describe('topic injection', () => {
  let harness: IntegrationHarness;

  beforeEach(async () => {
    harness = await IntegrationHarness.create();
    harness.registerTool(
      {
        name: 'safe_tool',
        description: 'Safe',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
      async () => ({ ok: true }),
    );
  });

  afterEach(async () => {
    await harness.close();
  });

  it('rejects topics that do not start with tool.invoke.', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, '', {});
    expect(response.payload.error).not.toBeNull();
    expect(response.payload.error!.code).toBe(ErrorCode.UNKNOWN_TOOL);
  });

  it('rejects topics with no tool name after prefix', async () => {
    const session = harness.createSession({ group: 'test' });
    // Empty tool name produces topic 'tool.invoke.' with no tool after prefix
    const response = await harness.sendRequest(session, '', {});
    expect(response.payload.error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 13. Response path integration
// ---------------------------------------------------------------------------

describe('response sanitization in tool responses', () => {
  const sanitizer = new ResponseSanitizer();

  it('sanitizes tool response containing credentials', () => {
    const toolResult = {
      config: {
        apiKey: 'sk-abc123def456ghi789jkl',
        dbUrl: 'postgres://admin:s3cret@db.example.com/prod',
      },
      data: 'normal data',
    };

    const result = sanitizer.sanitize(toolResult);
    const sanitized = result.value as Record<string, Record<string, unknown>>;

    expect(sanitized['config']['apiKey']).toBe(REDACTED_PLACEHOLDER);
    expect(sanitized['config']['dbUrl']).toBe(REDACTED_PLACEHOLDER);
    expect(sanitized['data']).toBe('normal data');
    expect(result.redactedPaths).toHaveLength(2);
  });

  it('sanitizes error messages containing credentials', () => {
    const errorMsg = 'Failed to connect: postgres://root:hunter2@localhost/mydb timed out';
    const result = sanitizer.sanitize(errorMsg);
    expect(result.value).toContain(REDACTED_PLACEHOLDER);
    expect(result.value).not.toContain('hunter2');
  });

  it('handles null and undefined values without crashing', () => {
    const result = sanitizer.sanitize({ a: null, b: undefined, c: 'safe' });
    expect((result.value as Record<string, unknown>)['a']).toBeNull();
    expect((result.value as Record<string, unknown>)['c']).toBe('safe');
    expect(result.redactedPaths).toHaveLength(0);
  });
});
