import { describe, it, expect, vi } from 'vitest';
import { MessageValidator } from './message-validator.js';
import { ToolCatalog } from './tool-catalog.js';
import { SchemaValidator } from './schema-validator.js';
import { RateLimiter } from './rate-limiter.js';
import { ErrorCode } from '../types/errors.js';
import { createWireMessage, createToolDeclaration } from '../testing/factories.js';
import type { SessionContext, PipelineStage, PipelineContext } from './pipeline/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides?: Partial<SessionContext>): SessionContext {
  return {
    sessionId: 'sess-001',
    group: 'email',
    source: 'agent-test',
    startedAt: '2026-02-19T10:00:00Z',
    ...overrides,
  };
}

function setupValidator(options?: {
  toolGroupRestrictions?: Map<string, Set<string>>;
  rateLimiterConfig?: { requestsPerMinute: number; burstSize: number };
  onRejection?: MessageValidator['onRejection'];
}): { validator: MessageValidator; catalog: ToolCatalog } {
  const catalog = new ToolCatalog();
  const tool = createToolDeclaration({
    name: 'create_reminder',
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
    },
  });
  catalog.register(tool, async () => ({ ok: true }));

  const schemaValidator = new SchemaValidator();
  schemaValidator.compile('create_reminder', tool.arguments_schema);

  const rateLimiter = new RateLimiter(
    options?.rateLimiterConfig ?? { requestsPerMinute: 60, burstSize: 10 },
  );

  const validator = new MessageValidator({
    catalog,
    schemaValidator,
    rateLimiter,
    toolGroupRestrictions: options?.toolGroupRestrictions,
    onRejection: options?.onRejection,
  });

  return { validator, catalog };
}

// ---------------------------------------------------------------------------
// End-to-end validation: happy path
// ---------------------------------------------------------------------------

describe('MessageValidator', () => {
  describe('happy path', () => {
    it('passes a valid message through all stages', () => {
      const { validator } = setupValidator();
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 'hello' },
      });

      const result = validator.validate(wire, makeSession());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.envelope).toBeDefined();
        expect(result.envelope.topic).toBe('tool.invoke.create_reminder');
        expect(result.tool).toBeDefined();
        expect(result.tool.name).toBe('create_reminder');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Stage 2: Topic whitelist
  // ---------------------------------------------------------------------------

  describe('topic whitelist (stage 2)', () => {
    it('rejects unknown tool topics with UNKNOWN_TOOL', () => {
      const { validator } = setupValidator();
      const wire = createWireMessage({ topic: 'tool.invoke.nonexistent' });

      const result = validator.validate(wire, makeSession());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.UNKNOWN_TOOL);
        expect(result.error.stage).toBe(2);
      }
    });

    it('rejects malformed topics with UNKNOWN_TOOL', () => {
      const { validator } = setupValidator();
      const wire = createWireMessage({ topic: 'bad.topic' });

      const result = validator.validate(wire, makeSession());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.UNKNOWN_TOOL);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Stage 3: Schema validation
  // ---------------------------------------------------------------------------

  describe('schema validation (stage 3)', () => {
    it('rejects messages with invalid arguments (wrong type)', () => {
      const { validator } = setupValidator();
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 42 },
      });

      const result = validator.validate(wire, makeSession());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
        expect(result.error.stage).toBe(3);
      }
    });

    it('rejects messages with additional properties', () => {
      const { validator } = setupValidator();
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 'hello', extra: 'bad' },
      });

      const result = validator.validate(wire, makeSession());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Stage 4: Group authorization
  // ---------------------------------------------------------------------------

  describe('group authorization (stage 4)', () => {
    it('blocks cross-group access', () => {
      const toolGroups = new Map([['create_reminder', new Set(['slack'])]]);
      const { validator } = setupValidator({ toolGroupRestrictions: toolGroups });
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 'hello' },
      });

      const result = validator.validate(wire, makeSession({ group: 'email' }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.UNAUTHORIZED);
        expect(result.error.stage).toBe(4);
        expect(result.error.message).toContain('email');
        expect(result.error.message).toContain('create_reminder');
      }
    });

    it('allows access when group is authorized', () => {
      const toolGroups = new Map([['create_reminder', new Set(['email'])]]);
      const { validator } = setupValidator({ toolGroupRestrictions: toolGroups });
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 'hello' },
      });

      const result = validator.validate(wire, makeSession({ group: 'email' }));

      expect(result.ok).toBe(true);
    });

    it('allows access when no group restrictions configured', () => {
      const { validator } = setupValidator();
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 'hello' },
      });

      const result = validator.validate(wire, makeSession({ group: 'any-group' }));

      expect(result.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Stage 4: Rate limiting
  // ---------------------------------------------------------------------------

  describe('rate limiting (stage 4)', () => {
    it('throttles sessions exceeding the rate limit', () => {
      const { validator } = setupValidator({
        rateLimiterConfig: { requestsPerMinute: 60, burstSize: 2 },
      });
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 'hello' },
      });
      const session = makeSession();

      // Consume all tokens
      validator.validate(wire, session);
      validator.validate(wire, session);
      const result = validator.validate(wire, session);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.RATE_LIMITED);
        expect(result.error.stage).toBe(4);
        expect(result.error.retriable).toBe(true);
        expect(result.error.retry_after).toBeGreaterThan(0);
      }
    });

    it('does not throttle different sessions independently', () => {
      const { validator } = setupValidator({
        rateLimiterConfig: { requestsPerMinute: 60, burstSize: 1 },
      });
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 'hello' },
      });

      // Session 1 uses its token
      validator.validate(wire, makeSession({ sessionId: 'sess-001' }));
      // Session 2 should still have its token
      const result = validator.validate(wire, makeSession({ sessionId: 'sess-002' }));

      expect(result.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Rejection logging
  // ---------------------------------------------------------------------------

  describe('rejection logging', () => {
    it('calls onRejection callback for UNKNOWN_TOOL rejections', () => {
      const onRejection = vi.fn();
      const { validator } = setupValidator({ onRejection });
      const wire = createWireMessage({ topic: 'tool.invoke.nonexistent' });

      validator.validate(wire, makeSession());

      expect(onRejection).toHaveBeenCalledOnce();
      const [entry] = onRejection.mock.calls[0];
      expect(entry.error.code).toBe(ErrorCode.UNKNOWN_TOOL);
      expect(entry.stage).toBe('topic');
      expect(entry.wire).toBe(wire);
    });

    it('calls onRejection callback for VALIDATION_FAILED rejections', () => {
      const onRejection = vi.fn();
      const { validator } = setupValidator({ onRejection });
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 42 },
      });

      validator.validate(wire, makeSession());

      expect(onRejection).toHaveBeenCalledOnce();
      const [entry] = onRejection.mock.calls[0];
      expect(entry.error.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(entry.stage).toBe('payload');
    });

    it('calls onRejection callback for UNAUTHORIZED rejections', () => {
      const toolGroups = new Map([['create_reminder', new Set(['slack'])]]);
      const onRejection = vi.fn();
      const { validator } = setupValidator({ toolGroupRestrictions: toolGroups, onRejection });
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 'hello' },
      });

      validator.validate(wire, makeSession({ group: 'email' }));

      expect(onRejection).toHaveBeenCalledOnce();
      const [entry] = onRejection.mock.calls[0];
      expect(entry.error.code).toBe(ErrorCode.UNAUTHORIZED);
      expect(entry.stage).toBe('authorize');
    });

    it('calls onRejection callback for RATE_LIMITED rejections', () => {
      const onRejection = vi.fn();
      const { validator } = setupValidator({
        rateLimiterConfig: { requestsPerMinute: 60, burstSize: 1 },
        onRejection,
      });
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 'hello' },
      });
      const session = makeSession();

      validator.validate(wire, session);
      validator.validate(wire, session);

      expect(onRejection).toHaveBeenCalledOnce();
      const [entry] = onRejection.mock.calls[0];
      expect(entry.error.code).toBe(ErrorCode.RATE_LIMITED);
      expect(entry.stage).toBe('authorize');
    });

    it('does not call onRejection on successful validation', () => {
      const onRejection = vi.fn();
      const { validator } = setupValidator({ onRejection });
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 'hello' },
      });

      validator.validate(wire, makeSession());

      expect(onRejection).not.toHaveBeenCalled();
    });

    it('rejection entry includes session context', () => {
      const onRejection = vi.fn();
      const { validator } = setupValidator({ onRejection });
      const wire = createWireMessage({ topic: 'tool.invoke.nonexistent' });
      const session = makeSession({ group: 'email', sessionId: 'sess-test' });

      validator.validate(wire, session);

      const [entry] = onRejection.mock.calls[0];
      expect(entry.session.group).toBe('email');
      expect(entry.session.sessionId).toBe('sess-test');
    });
  });

  // ---------------------------------------------------------------------------
  // Pipeline order
  // ---------------------------------------------------------------------------

  describe('pipeline stage ordering', () => {
    it('stage 2 (topic) runs before stage 3 (payload)', () => {
      const onRejection = vi.fn();
      const { validator } = setupValidator({ onRejection });
      // Invalid topic AND invalid args — should fail on topic first
      const wire = createWireMessage({
        topic: 'tool.invoke.nonexistent',
        arguments: { bad: true },
      });

      const result = validator.validate(wire, makeSession());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.UNKNOWN_TOOL);
      }
    });

    it('stage 3 (payload) runs before stage 4 (authorize)', () => {
      const toolGroups = new Map([['create_reminder', new Set(['slack'])]]);
      const onRejection = vi.fn();
      const { validator } = setupValidator({ toolGroupRestrictions: toolGroups, onRejection });
      // Valid topic, invalid args, unauthorized group — should fail on payload first
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 42 },
      });

      const result = validator.validate(wire, makeSession({ group: 'email' }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
      }
    });

    it('stage 4 (auth) runs before rate limiting', () => {
      const toolGroups = new Map([['create_reminder', new Set(['slack'])]]);
      const { validator } = setupValidator({
        toolGroupRestrictions: toolGroups,
        rateLimiterConfig: { requestsPerMinute: 60, burstSize: 1 },
      });
      const wire = createWireMessage({
        topic: 'tool.invoke.create_reminder',
        arguments: { text: 'hello' },
      });
      // Unauthorized group — should fail with UNAUTHORIZED, not RATE_LIMITED
      const result = validator.validate(wire, makeSession({ group: 'email' }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.UNAUTHORIZED);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Defensive guards
  // ---------------------------------------------------------------------------

  describe('defensive pipeline guards', () => {
    it('returns PLUGIN_ERROR when pipeline completes without envelope or tool', () => {
      // Use custom stages that pass through context unchanged (no envelope/tool set)
      const passthrough: PipelineStage = {
        name: 'passthrough',
        execute: (ctx: PipelineContext) => ctx,
      };
      const minimalOptions = {
        catalog: new ToolCatalog(),
        schemaValidator: new SchemaValidator(),
        rateLimiter: new RateLimiter({ requestsPerMinute: 60, burstSize: 10 }),
      };
      const customValidator = new MessageValidator(minimalOptions, [passthrough]);
      const wire = createWireMessage({ topic: 'tool.invoke.test' });

      const result = customValidator.validate(wire, makeSession());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLUGIN_ERROR');
        expect(result.error.message).toContain('envelope or tool not resolved');
      }
    });
  });
});
