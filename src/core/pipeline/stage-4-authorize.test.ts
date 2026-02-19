import { describe, it, expect } from 'vitest';
import { createStage4Authorize } from './stage-4-authorize.js';
import { RateLimiter } from '../rate-limiter.js';
import { ErrorCode } from '../../types/errors.js';
import { createWireMessage, createToolDeclaration } from '../../testing/factories.js';
import type { PipelineContext, PipelineResult } from './types.js';
import type { SessionContext } from './types.js';
import type { RequestEnvelope } from '../../types/protocol.js';

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

function makeEnvelope(group: string): RequestEnvelope {
  return {
    id: 'req-001',
    version: 1,
    type: 'request',
    topic: 'tool.invoke.create_reminder',
    source: 'agent-test',
    correlation: 'corr-001',
    timestamp: '2026-02-19T10:00:00Z',
    group,
    payload: { arguments: { text: 'hello' } },
  };
}

function makeCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  const session = makeSession();
  return {
    wire: createWireMessage({ topic: 'tool.invoke.create_reminder' }),
    session,
    envelope: makeEnvelope(session.group),
    tool: createToolDeclaration({ name: 'create_reminder' }),
    ...overrides,
  };
}

function makeRateLimiter(): RateLimiter {
  return new RateLimiter({ requestsPerMinute: 60, burstSize: 10 });
}

// ---------------------------------------------------------------------------
// Group authorization
// ---------------------------------------------------------------------------

describe('Stage 4: Authorize', () => {
  describe('group authorization', () => {
    it('passes when no group restrictions are configured', () => {
      const stage = createStage4Authorize({
        rateLimiter: makeRateLimiter(),
      });
      const ctx = makeCtx();

      const result = stage.execute(ctx);

      expect(result).not.toHaveProperty('ok');
    });

    it('passes when session group is in the allowed set for the tool', () => {
      const toolGroups = new Map([['create_reminder', new Set(['email', 'slack'])]]);
      const stage = createStage4Authorize({
        rateLimiter: makeRateLimiter(),
        toolGroupRestrictions: toolGroups,
      });
      const ctx = makeCtx({ session: makeSession({ group: 'email' }) });

      const result = stage.execute(ctx);

      expect(result).not.toHaveProperty('ok');
    });

    it('rejects with UNAUTHORIZED when session group is not in allowed set', () => {
      const toolGroups = new Map([['create_reminder', new Set(['slack'])]]);
      const stage = createStage4Authorize({
        rateLimiter: makeRateLimiter(),
        toolGroupRestrictions: toolGroups,
      });
      const ctx = makeCtx({ session: makeSession({ group: 'email' }) });

      const result = stage.execute(ctx);

      expect(result).toHaveProperty('ok', false);
      const err = (result as PipelineResult & { ok: false }).error;
      expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
      expect(err.stage).toBe(4);
    });

    it('UNAUTHORIZED error includes tool name and group in message', () => {
      const toolGroups = new Map([['create_reminder', new Set(['slack'])]]);
      const stage = createStage4Authorize({
        rateLimiter: makeRateLimiter(),
        toolGroupRestrictions: toolGroups,
      });
      const ctx = makeCtx({ session: makeSession({ group: 'email' }) });

      const result = stage.execute(ctx);

      const err = (result as PipelineResult & { ok: false }).error;
      expect(err.message).toContain('create_reminder');
      expect(err.message).toContain('email');
    });

    it('UNAUTHORIZED is not retriable', () => {
      const toolGroups = new Map([['create_reminder', new Set(['slack'])]]);
      const stage = createStage4Authorize({
        rateLimiter: makeRateLimiter(),
        toolGroupRestrictions: toolGroups,
      });
      const ctx = makeCtx({ session: makeSession({ group: 'email' }) });

      const result = stage.execute(ctx);

      const err = (result as PipelineResult & { ok: false }).error;
      expect(err.retriable).toBe(false);
    });

    it('allows tools not in the restriction map (unrestricted tools)', () => {
      const toolGroups = new Map([['other_tool', new Set(['slack'])]]);
      const stage = createStage4Authorize({
        rateLimiter: makeRateLimiter(),
        toolGroupRestrictions: toolGroups,
      });
      const ctx = makeCtx(); // tool is create_reminder, not in restrictions

      const result = stage.execute(ctx);

      expect(result).not.toHaveProperty('ok');
    });

    it('handles missing tool in context gracefully', () => {
      const stage = createStage4Authorize({
        rateLimiter: makeRateLimiter(),
      });
      const ctx = makeCtx();
      delete (ctx as Partial<PipelineContext>).tool;

      const result = stage.execute(ctx);

      expect(result).toHaveProperty('ok', false);
      const err = (result as PipelineResult & { ok: false }).error;
      expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('passes when rate limit is not exceeded', () => {
      const stage = createStage4Authorize({
        rateLimiter: makeRateLimiter(),
      });
      const ctx = makeCtx();

      const result = stage.execute(ctx);

      expect(result).not.toHaveProperty('ok');
    });

    it('rejects with RATE_LIMITED when session exceeds rate limit', () => {
      const rateLimiter = new RateLimiter({ requestsPerMinute: 60, burstSize: 2 });
      const stage = createStage4Authorize({ rateLimiter });
      const ctx = makeCtx();

      // Consume all tokens
      stage.execute(ctx);
      stage.execute(ctx);
      const result = stage.execute(ctx);

      expect(result).toHaveProperty('ok', false);
      const err = (result as PipelineResult & { ok: false }).error;
      expect(err.code).toBe(ErrorCode.RATE_LIMITED);
      expect(err.stage).toBe(4);
    });

    it('RATE_LIMITED includes retry_after', () => {
      const rateLimiter = new RateLimiter({ requestsPerMinute: 60, burstSize: 1 });
      const stage = createStage4Authorize({ rateLimiter });
      const ctx = makeCtx();

      stage.execute(ctx);
      const result = stage.execute(ctx);

      const err = (result as PipelineResult & { ok: false }).error;
      expect(err.retry_after).toBeGreaterThan(0);
    });

    it('RATE_LIMITED is retriable', () => {
      const rateLimiter = new RateLimiter({ requestsPerMinute: 60, burstSize: 1 });
      const stage = createStage4Authorize({ rateLimiter });
      const ctx = makeCtx();

      stage.execute(ctx);
      const result = stage.execute(ctx);

      const err = (result as PipelineResult & { ok: false }).error;
      expect(err.retriable).toBe(true);
    });

    it('rate limits are per-session', () => {
      const rateLimiter = new RateLimiter({ requestsPerMinute: 60, burstSize: 1 });
      const stage = createStage4Authorize({ rateLimiter });

      const ctx1 = makeCtx({ session: makeSession({ sessionId: 'sess-001' }) });
      const ctx2 = makeCtx({ session: makeSession({ sessionId: 'sess-002' }) });

      // Session 1 uses its token
      stage.execute(ctx1);
      // Session 2 should still have its token
      const result = stage.execute(ctx2);

      expect(result).not.toHaveProperty('ok');
    });

    it('rate limiting uses session group for config lookup', () => {
      const rateLimiter = new RateLimiter({ requestsPerMinute: 60, burstSize: 10 });
      // Set a strict limit for group "email"
      rateLimiter.setGroupConfig('email', { requestsPerMinute: 60, burstSize: 1 });

      const stage = createStage4Authorize({ rateLimiter });
      const ctx = makeCtx({ session: makeSession({ group: 'email' }) });

      stage.execute(ctx);
      const result = stage.execute(ctx);

      expect(result).toHaveProperty('ok', false);
      const err = (result as PipelineResult & { ok: false }).error;
      expect(err.code).toBe(ErrorCode.RATE_LIMITED);
    });

    it('group auth runs before rate limiting (no token consumed on auth failure)', () => {
      const rateLimiter = new RateLimiter({ requestsPerMinute: 60, burstSize: 1 });
      const toolGroups = new Map([['create_reminder', new Set(['slack'])]]);
      const stage = createStage4Authorize({
        rateLimiter,
        toolGroupRestrictions: toolGroups,
      });
      const ctx = makeCtx({ session: makeSession({ group: 'email' }) });

      // First call should be UNAUTHORIZED (not consume a token)
      const result1 = stage.execute(ctx);
      expect((result1 as PipelineResult & { ok: false }).error.code).toBe(ErrorCode.UNAUTHORIZED);

      // Now try with an authorized context — should still have a token
      const authorizedCtx = makeCtx({
        session: makeSession({ group: 'slack', sessionId: 'sess-001' }),
        tool: createToolDeclaration({ name: 'create_reminder' }),
        envelope: makeEnvelope('slack'),
      });
      const result2 = stage.execute(authorizedCtx);
      expect(result2).not.toHaveProperty('ok');
    });
  });

  // ---------------------------------------------------------------------------
  // Stage metadata
  // ---------------------------------------------------------------------------

  describe('stage metadata', () => {
    it('has stage name "authorize"', () => {
      const stage = createStage4Authorize({ rateLimiter: makeRateLimiter() });
      expect(stage.name).toBe('authorize');
    });
  });
});
