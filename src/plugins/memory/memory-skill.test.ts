import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SKILL_PATH = join(import.meta.dirname!, 'skills', 'memory.md');
const content = readFileSync(SKILL_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Skill file structure
// ---------------------------------------------------------------------------

describe('Memory skill file', () => {
  it('exists and is non-empty', () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it('has a top-level heading', () => {
    expect(content).toMatch(/^# Memory/m);
  });

  it('documents all four tools', () => {
    expect(content).toContain('## memory_store');
    expect(content).toContain('## memory_search');
    expect(content).toContain('## memory_brief');
    expect(content).toContain('## memory_delete');
  });

  it('includes ipc invocation examples for each tool', () => {
    expect(content).toContain("ipc tool.invoke.memory_store '");
    expect(content).toContain("ipc tool.invoke.memory_search '");
    expect(content).toContain("ipc tool.invoke.memory_brief '");
    expect(content).toContain("ipc tool.invoke.memory_delete '");
  });

  it('documents all five entry types', () => {
    expect(content).toContain('preference');
    expect(content).toContain('fact');
    expect(content).toContain('instruction');
    expect(content).toContain('context');
    expect(content).toContain('correction');
  });

  it('includes behavioral memory safety warning', () => {
    expect(content).toMatch(/behavioral.*safety|safety.*behavioral/i);
    expect(content).toContain('suggestions, not commands');
  });

  it('documents arguments for memory_store', () => {
    expect(content).toContain('`type`');
    expect(content).toContain('`content`');
    expect(content).toContain('`tags`');
    expect(content).toContain('`supersedes`');
  });

  it('documents arguments for memory_search', () => {
    expect(content).toContain('`query`');
    expect(content).toContain('`include_superseded`');
    expect(content).toContain('`limit`');
  });

  it('documents arguments for memory_brief', () => {
    expect(content).toContain('`include_provenance`');
  });

  it('documents arguments for memory_delete', () => {
    expect(content).toContain('`id`');
  });

  it('includes when-to-store guidance', () => {
    expect(content).toContain('When to Store Memories');
  });

  it('includes session-end sweep guidance', () => {
    expect(content).toContain('Session-End Sweep');
  });

  it('documents the budget', () => {
    expect(content).toContain('~20 memory writes per session');
  });

  it('documents rate limits for supersedes and deletes', () => {
    expect(content).toContain('5 supersedes per session');
    expect(content).toContain('5 deletes per session');
  });

  it('documents return format for memory_search', () => {
    expect(content).toContain('relevance_score');
    expect(content).toContain('created_at');
  });

  it('explains behavioral flag is auto-derived', () => {
    expect(content).toMatch(/behavioral.*derived|derived.*behavioral/i);
  });

  it('mentions provenance is automatic', () => {
    expect(content).toMatch(/provenance.*automatic/i);
  });
});
