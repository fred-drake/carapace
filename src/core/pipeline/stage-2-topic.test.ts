import { describe, it, expect } from 'vitest';
import { createStage2Topic } from './stage-2-topic.js';
import { ToolCatalog } from '../tool-catalog.js';
import { ErrorCode } from '../../types/errors.js';
import { createWireMessage, createToolDeclaration } from '../../testing/factories.js';
import type { PipelineContext, PipelineResult } from './types.js';
import type { SessionContext } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(): SessionContext {
  return {
    sessionId: 'sess-001',
    group: 'test-group',
    source: 'agent-test',
    startedAt: '2026-02-18T10:00:00Z',
  };
}

function makeCatalogWithTool(toolName: string): ToolCatalog {
  const catalog = new ToolCatalog();
  const tool = createToolDeclaration({ name: toolName });
  catalog.register(tool, async () => ({ ok: true }));
  return catalog;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Stage 2: Topic validation', () => {
  it('passes when topic exists in the catalog', () => {
    const catalog = makeCatalogWithTool('create_reminder');
    const stage = createStage2Topic(catalog);
    const wire = createWireMessage({ topic: 'tool.invoke.create_reminder' });

    const result = stage.execute({ wire, session: makeSession() });

    // Should be a PipelineContext with tool set
    expect(result).not.toHaveProperty('ok');
    expect(result).toHaveProperty('tool');
    expect((result as PipelineContext).tool!.name).toBe('create_reminder');
  });

  it('returns UNKNOWN_TOOL error when topic not in catalog', () => {
    const catalog = new ToolCatalog();
    const stage = createStage2Topic(catalog);
    const wire = createWireMessage({ topic: 'tool.invoke.nonexistent' });

    const result = stage.execute({ wire, session: makeSession() });

    expect(result).toHaveProperty('ok', false);
    const errorResult = result as PipelineResult & { ok: false };
    expect(errorResult.error.code).toBe(ErrorCode.UNKNOWN_TOOL);
    expect(errorResult.error.message).toContain('nonexistent');
  });

  it('extracts tool name from "tool.invoke.{name}" format', () => {
    const catalog = makeCatalogWithTool('send_telegram');
    const stage = createStage2Topic(catalog);
    const wire = createWireMessage({ topic: 'tool.invoke.send_telegram' });

    const result = stage.execute({ wire, session: makeSession() });

    expect(result).not.toHaveProperty('ok');
    expect((result as PipelineContext).tool!.name).toBe('send_telegram');
  });

  it('handles malformed topic without "tool.invoke." prefix', () => {
    const catalog = new ToolCatalog();
    const stage = createStage2Topic(catalog);
    const wire = createWireMessage({ topic: 'message.inbound' });

    const result = stage.execute({ wire, session: makeSession() });

    expect(result).toHaveProperty('ok', false);
    const errorResult = result as PipelineResult & { ok: false };
    expect(errorResult.error.code).toBe(ErrorCode.UNKNOWN_TOOL);
    expect(errorResult.error.message).toContain('Malformed topic');
  });

  it('handles "tool.invoke." with empty tool name', () => {
    const catalog = new ToolCatalog();
    const stage = createStage2Topic(catalog);
    const wire = createWireMessage({ topic: 'tool.invoke.' });

    const result = stage.execute({ wire, session: makeSession() });

    expect(result).toHaveProperty('ok', false);
    const errorResult = result as PipelineResult & { ok: false };
    expect(errorResult.error.code).toBe(ErrorCode.UNKNOWN_TOOL);
    expect(errorResult.error.message).toContain('empty');
  });

  it('error includes stage number 2', () => {
    const catalog = new ToolCatalog();
    const stage = createStage2Topic(catalog);
    const wire = createWireMessage({ topic: 'tool.invoke.missing_tool' });

    const result = stage.execute({ wire, session: makeSession() });

    const errorResult = result as PipelineResult & { ok: false };
    expect(errorResult.error.stage).toBe(2);
  });

  it('error is not retriable', () => {
    const catalog = new ToolCatalog();
    const stage = createStage2Topic(catalog);
    const wire = createWireMessage({ topic: 'tool.invoke.missing_tool' });

    const result = stage.execute({ wire, session: makeSession() });

    const errorResult = result as PipelineResult & { ok: false };
    expect(errorResult.error.retriable).toBe(false);
  });

  it('has stage name "topic"', () => {
    const stage = createStage2Topic(new ToolCatalog());
    expect(stage.name).toBe('topic');
  });
});
