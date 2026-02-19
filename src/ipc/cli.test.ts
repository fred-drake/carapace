/**
 * Tests for the IPC CLI argument parser and runner.
 *
 * The CLI is the entry point for the `ipc` binary:
 *   ipc <topic> <arguments-json>
 *
 * Tests cover: argument parsing, validation, output formatting,
 * and exit code semantics.
 */

import { describe, it, expect } from 'vitest';

import { parseCliArgs, formatOutput, type CliArgs } from './cli.js';

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

describe('parseCliArgs', () => {
  it('parses valid topic and arguments', () => {
    const result = parseCliArgs(['node', 'ipc', 'tool.invoke.create_reminder', '{"title":"test"}']);

    expect(result.ok).toBe(true);
    const args = (result as { ok: true; value: CliArgs }).value;
    expect(args.topic).toBe('tool.invoke.create_reminder');
    expect(args.arguments).toEqual({ title: 'test' });
  });

  it('parses empty arguments object', () => {
    const result = parseCliArgs(['node', 'ipc', 'tool.invoke.list_tools', '{}']);

    expect(result.ok).toBe(true);
    const args = (result as { ok: true; value: CliArgs }).value;
    expect(args.topic).toBe('tool.invoke.list_tools');
    expect(args.arguments).toEqual({});
  });

  it('parses nested arguments', () => {
    const json = '{"config":{"nested":true},"items":[1,2,3]}';
    const result = parseCliArgs(['node', 'ipc', 'tool.invoke.test', json]);

    expect(result.ok).toBe(true);
    const args = (result as { ok: true; value: CliArgs }).value;
    expect(args.arguments).toEqual({ config: { nested: true }, items: [1, 2, 3] });
  });

  it('returns error when topic is missing', () => {
    const result = parseCliArgs(['node', 'ipc']);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/usage/i);
  });

  it('returns error when arguments JSON is missing', () => {
    const result = parseCliArgs(['node', 'ipc', 'tool.invoke.test']);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/usage/i);
  });

  it('returns error when arguments is not valid JSON', () => {
    const result = parseCliArgs(['node', 'ipc', 'tool.invoke.test', 'not-json']);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/json/i);
  });

  it('returns error when arguments JSON is not an object', () => {
    const result = parseCliArgs(['node', 'ipc', 'tool.invoke.test', '"string"']);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/object/i);
  });

  it('returns error when arguments JSON is an array', () => {
    const result = parseCliArgs(['node', 'ipc', 'tool.invoke.test', '[1,2,3]']);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/object/i);
  });

  it('returns error when arguments JSON is null', () => {
    const result = parseCliArgs(['node', 'ipc', 'tool.invoke.test', 'null']);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/object/i);
  });
});

// ---------------------------------------------------------------------------
// formatOutput
// ---------------------------------------------------------------------------

describe('formatOutput', () => {
  it('formats a success response as JSON to stdout', () => {
    const response = {
      id: 'res-1',
      version: 1,
      type: 'response' as const,
      topic: 'tool.invoke.test',
      source: 'test-plugin',
      correlation: 'corr-1',
      timestamp: '2026-02-19T00:00:00Z',
      group: 'test',
      payload: { result: { reminder_id: 'R-123' }, error: null },
    };

    const output = formatOutput(response);

    expect(output.exitCode).toBe(0);
    expect(output.stdout).toBe(JSON.stringify({ reminder_id: 'R-123' }));
    expect(output.stderr).toBe('');
  });

  it('formats an error response to stderr with exit code 1', () => {
    const response = {
      id: 'res-1',
      version: 1,
      type: 'response' as const,
      topic: 'tool.invoke.test',
      source: 'test-plugin',
      correlation: 'corr-1',
      timestamp: '2026-02-19T00:00:00Z',
      group: 'test',
      payload: {
        result: null,
        error: {
          code: 'UNKNOWN_TOOL' as const,
          message: 'No such tool: test_tool',
          retriable: false,
        },
      },
    };

    const output = formatOutput(response);

    expect(output.exitCode).toBe(1);
    expect(output.stdout).toBe('');
    const parsed = JSON.parse(output.stderr);
    expect(parsed.code).toBe('UNKNOWN_TOOL');
    expect(parsed.message).toBe('No such tool: test_tool');
    expect(parsed.retriable).toBe(false);
  });

  it('includes optional error fields in stderr output', () => {
    const response = {
      id: 'res-1',
      version: 1,
      type: 'response' as const,
      topic: 'tool.invoke.test',
      source: 'test-plugin',
      correlation: 'corr-1',
      timestamp: '2026-02-19T00:00:00Z',
      group: 'test',
      payload: {
        result: null,
        error: {
          code: 'RATE_LIMITED' as const,
          message: 'Too many requests',
          retriable: true,
          retry_after: 5,
        },
      },
    };

    const output = formatOutput(response);

    expect(output.exitCode).toBe(1);
    const parsed = JSON.parse(output.stderr);
    expect(parsed.retry_after).toBe(5);
    expect(parsed.retriable).toBe(true);
  });
});
