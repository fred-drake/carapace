import { describe, it, expect } from 'vitest';
import { createStage5Confirm } from './stage-5-confirm.js';
import type { PipelineContext, PipelineResult } from './types.js';
import { ErrorCode } from '../../types/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContext(riskLevel: 'low' | 'high'): PipelineContext {
  return {
    wire: {
      topic: 'tool.invoke.test_tool',
      correlation: 'corr-001',
      arguments: {},
    },
    session: {
      sessionId: 'sess-001',
      group: 'test-group',
      source: 'agent-test',
      startedAt: new Date().toISOString(),
    },
    envelope: {
      id: 'req-001',
      version: 1,
      type: 'request',
      topic: 'tool.invoke.test_tool',
      source: 'agent-test',
      correlation: 'corr-001',
      timestamp: new Date().toISOString(),
      group: 'test-group',
      payload: { arguments: {} },
    },
    tool: {
      name: 'test_tool',
      description: 'A test tool',
      risk_level: riskLevel,
      arguments_schema: {
        type: 'object',
        additionalProperties: false as const,
        properties: {},
      },
    },
  };
}

// ---------------------------------------------------------------------------
// createStage5Confirm
// ---------------------------------------------------------------------------

describe('stage5Confirm', () => {
  describe('low-risk tools', () => {
    it('passes through without confirmation', () => {
      const stage = createStage5Confirm();
      const ctx = createContext('low');
      const result = stage.execute(ctx);
      // Should return context (pass), not a PipelineResult
      expect('ok' in result).toBe(false);
      expect(result).toBe(ctx);
    });
  });

  describe('high-risk tools', () => {
    it('rejects with CONFIRMATION_TIMEOUT when no pre-approval exists', () => {
      const stage = createStage5Confirm();
      const ctx = createContext('high');
      const result = stage.execute(ctx) as PipelineResult;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.CONFIRMATION_TIMEOUT);
        expect(result.error.stage).toBe(5);
        expect(result.error.retriable).toBe(true);
      }
    });

    it('passes through when pre-approval exists for the correlation', () => {
      const preApprovedCorrelations = new Set(['corr-001']);
      const stage = createStage5Confirm({ preApprovedCorrelations });
      const ctx = createContext('high');
      const result = stage.execute(ctx);
      expect('ok' in result).toBe(false);
      expect(result).toBe(ctx);
    });

    it('does not pass through for a different correlation', () => {
      const preApprovedCorrelations = new Set(['other-corr']);
      const stage = createStage5Confirm({ preApprovedCorrelations });
      const ctx = createContext('high');
      const result = stage.execute(ctx) as PipelineResult;
      expect(result.ok).toBe(false);
    });
  });

  describe('missing tool context', () => {
    it('returns error when tool is not resolved', () => {
      const stage = createStage5Confirm();
      const ctx: PipelineContext = {
        wire: {
          topic: 'tool.invoke.test',
          correlation: 'corr-001',
          arguments: {},
        },
        session: {
          sessionId: 'sess-001',
          group: 'test-group',
          source: 'agent-test',
          startedAt: new Date().toISOString(),
        },
      };
      const result = stage.execute(ctx) as PipelineResult;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.stage).toBe(5);
      }
    });
  });

  it('has the correct stage name', () => {
    const stage = createStage5Confirm();
    expect(stage.name).toBe('confirm');
  });
});
