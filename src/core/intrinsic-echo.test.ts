import { describe, it, expect } from 'vitest';
import { ECHO_TOOL_DECLARATION, echoToolHandler } from './intrinsic-echo.js';
import type { RequestEnvelope } from '../types/protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvelope(args: Record<string, unknown>): RequestEnvelope {
  return {
    id: 'test-id',
    version: 1,
    type: 'request',
    topic: 'tool.invoke.echo',
    source: 'test-session',
    correlation: 'test-correlation',
    timestamp: new Date().toISOString(),
    group: 'default',
    payload: { arguments: args },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('intrinsic echo', () => {
  describe('ECHO_TOOL_DECLARATION', () => {
    it('has name "echo"', () => {
      expect(ECHO_TOOL_DECLARATION.name).toBe('echo');
    });

    it('has risk_level "low"', () => {
      expect(ECHO_TOOL_DECLARATION.risk_level).toBe('low');
    });

    it('declares a text argument', () => {
      expect(ECHO_TOOL_DECLARATION.arguments_schema.properties).toHaveProperty('text');
    });

    it('requires the text argument', () => {
      expect(ECHO_TOOL_DECLARATION.arguments_schema.required).toContain('text');
    });

    it('disallows additional properties', () => {
      expect(ECHO_TOOL_DECLARATION.arguments_schema.additionalProperties).toBe(false);
    });
  });

  describe('echoToolHandler', () => {
    it('echoes the text argument back', async () => {
      const result = await echoToolHandler(makeEnvelope({ text: 'hello' }));
      expect(result).toEqual({ echoed: 'hello' });
    });

    it('returns empty string when text is missing', async () => {
      const result = await echoToolHandler(makeEnvelope({}));
      expect(result).toEqual({ echoed: '' });
    });

    it('handles empty string text', async () => {
      const result = await echoToolHandler(makeEnvelope({ text: '' }));
      expect(result).toEqual({ echoed: '' });
    });

    it('handles text with special characters', async () => {
      const result = await echoToolHandler(makeEnvelope({ text: '<script>alert("xss")</script>' }));
      expect(result).toEqual({ echoed: '<script>alert("xss")</script>' });
    });
  });
});
