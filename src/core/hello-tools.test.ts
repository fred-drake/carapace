/**
 * Tests for hello intrinsic tools.
 *
 * Three first-run-experience tools: hello.greet, hello.echo, hello.time.
 * Registered conditionally via HelloConfig.enabled.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { ToolCatalog } from './tool-catalog.js';
import { registerHelloTools, HELLO_TOOL_NAMES } from './hello-tools.js';
import { createRequestEnvelope } from '../testing/factories.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestEnvelope(toolName: string, args: Record<string, unknown>) {
  return createRequestEnvelope({
    topic: `tool.invoke.${toolName}`,
    payload: { arguments: args },
    group: 'test-group',
    source: 'container-1',
    correlation: 'corr-test',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hello tools', () => {
  let catalog: ToolCatalog;

  beforeEach(() => {
    catalog = new ToolCatalog();
  });

  // -------------------------------------------------------------------------
  // HELLO_TOOL_NAMES constant
  // -------------------------------------------------------------------------

  describe('HELLO_TOOL_NAMES', () => {
    it('contains exactly the three hello tool names', () => {
      expect(HELLO_TOOL_NAMES).toEqual(['hello.greet', 'hello.echo', 'hello.time']);
    });
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  describe('registerHelloTools', () => {
    it('registers all three hello tools when enabled', () => {
      registerHelloTools({ catalog, config: { enabled: true } });

      expect(catalog.has('hello.greet')).toBe(true);
      expect(catalog.has('hello.echo')).toBe(true);
      expect(catalog.has('hello.time')).toBe(true);
    });

    it('does NOT register any tools when disabled', () => {
      registerHelloTools({ catalog, config: { enabled: false } });

      expect(catalog.has('hello.greet')).toBe(false);
      expect(catalog.has('hello.echo')).toBe(false);
      expect(catalog.has('hello.time')).toBe(false);
    });

    it('sets risk_level to "low" for all hello tools', () => {
      registerHelloTools({ catalog, config: { enabled: true } });

      for (const name of HELLO_TOOL_NAMES) {
        const entry = catalog.get(name);
        expect(entry!.tool.risk_level).toBe('low');
      }
    });

    it('sets additionalProperties: false on all argument schemas', () => {
      registerHelloTools({ catalog, config: { enabled: true } });

      for (const name of HELLO_TOOL_NAMES) {
        const entry = catalog.get(name);
        expect(entry!.tool.arguments_schema.additionalProperties).toBe(false);
      }
    });

    it('registers exactly the reserved hello tool names', () => {
      registerHelloTools({ catalog, config: { enabled: true } });

      for (const name of HELLO_TOOL_NAMES) {
        expect(catalog.has(name)).toBe(true);
      }
    });

    it('throws if a hello tool name is already registered', () => {
      catalog.register(
        {
          name: 'hello.greet',
          description: 'Conflict',
          risk_level: 'low',
          arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
        },
        async () => ({}),
      );

      expect(() => registerHelloTools({ catalog, config: { enabled: true } })).toThrow(
        'Tool already registered: "hello.greet"',
      );
    });
  });

  // -------------------------------------------------------------------------
  // hello.greet
  // -------------------------------------------------------------------------

  describe('hello.greet', () => {
    it('returns a welcome message', async () => {
      registerHelloTools({ catalog, config: { enabled: true } });

      const entry = catalog.get('hello.greet')!;
      const envelope = createTestEnvelope('hello.greet', {});
      const result = await entry.handler(envelope);

      expect(result.message).toBeDefined();
      expect(typeof result.message).toBe('string');
      expect((result.message as string).length).toBeGreaterThan(0);
    });

    it('includes the group name in the greeting', async () => {
      registerHelloTools({ catalog, config: { enabled: true } });

      const entry = catalog.get('hello.greet')!;
      const envelope = createTestEnvelope('hello.greet', {});
      const result = await entry.handler(envelope);

      expect(result.message).toContain('test-group');
    });

    it('uses custom name argument when provided', async () => {
      registerHelloTools({ catalog, config: { enabled: true } });

      const entry = catalog.get('hello.greet')!;
      const envelope = createTestEnvelope('hello.greet', { name: 'Alice' });
      const result = await entry.handler(envelope);

      expect(result.message).toContain('Alice');
    });
  });

  // -------------------------------------------------------------------------
  // hello.echo
  // -------------------------------------------------------------------------

  describe('hello.echo', () => {
    it('echoes back the provided message argument', async () => {
      registerHelloTools({ catalog, config: { enabled: true } });

      const entry = catalog.get('hello.echo')!;
      const envelope = createTestEnvelope('hello.echo', { message: 'Hello world' });
      const result = await entry.handler(envelope);

      expect(result.echo).toBe('Hello world');
    });

    it('returns empty echo when no message provided', async () => {
      registerHelloTools({ catalog, config: { enabled: true } });

      const entry = catalog.get('hello.echo')!;
      const envelope = createTestEnvelope('hello.echo', {});
      const result = await entry.handler(envelope);

      expect(result.echo).toBe('');
    });

    it('preserves the original arguments in the response', async () => {
      registerHelloTools({ catalog, config: { enabled: true } });

      const entry = catalog.get('hello.echo')!;
      const envelope = createTestEnvelope('hello.echo', { message: 'test' });
      const result = await entry.handler(envelope);

      const args = result.arguments as Record<string, unknown>;
      expect(args.message).toBe('test');
    });
  });

  // -------------------------------------------------------------------------
  // hello.time
  // -------------------------------------------------------------------------

  describe('hello.time', () => {
    it('returns the current host time as ISO string', async () => {
      registerHelloTools({ catalog, config: { enabled: true } });

      const entry = catalog.get('hello.time')!;
      const envelope = createTestEnvelope('hello.time', {});
      const before = new Date().toISOString();
      const result = await entry.handler(envelope);
      const after = new Date().toISOString();

      expect(result.time).toBeDefined();
      expect(typeof result.time).toBe('string');
      // The returned time should be between before and after
      expect((result.time as string) >= before).toBe(true);
      expect((result.time as string) <= after).toBe(true);
    });

    it('returns the timezone offset', async () => {
      registerHelloTools({ catalog, config: { enabled: true } });

      const entry = catalog.get('hello.time')!;
      const envelope = createTestEnvelope('hello.time', {});
      const result = await entry.handler(envelope);

      expect(result.timezone_offset).toBeDefined();
      expect(typeof result.timezone_offset).toBe('number');
    });
  });
});
