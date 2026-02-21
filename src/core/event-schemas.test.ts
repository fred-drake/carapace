import { describe, it, expect } from 'vitest';
import { MESSAGE_INBOUND_SCHEMA, validateMessageInbound } from './event-schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    channel: 'email',
    sender: 'user@example.com',
    content_type: 'text',
    body: 'Hello, world!',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('event-schemas', () => {
  describe('MESSAGE_INBOUND_SCHEMA', () => {
    it('exports a schema object with required fields', () => {
      expect(MESSAGE_INBOUND_SCHEMA).toBeDefined();
      expect(MESSAGE_INBOUND_SCHEMA.type).toBe('object');
      expect(MESSAGE_INBOUND_SCHEMA.required).toContain('channel');
      expect(MESSAGE_INBOUND_SCHEMA.required).toContain('sender');
      expect(MESSAGE_INBOUND_SCHEMA.required).toContain('content_type');
      expect(MESSAGE_INBOUND_SCHEMA.required).toContain('body');
      expect(MESSAGE_INBOUND_SCHEMA.additionalProperties).toBe(false);
    });
  });

  describe('validateMessageInbound', () => {
    // -------------------------------------------------------------------
    // Valid payloads
    // -------------------------------------------------------------------

    it('accepts a valid message.inbound payload', () => {
      const result = validateMessageInbound(validPayload());
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('accepts payload with optional metadata object', () => {
      const result = validateMessageInbound(validPayload({ metadata: { priority: 'high' } }));
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('accepts payload without metadata (optional field)', () => {
      const payload = validPayload();
      delete payload['metadata'];
      const result = validateMessageInbound(payload);
      expect(result.valid).toBe(true);
    });

    // -------------------------------------------------------------------
    // Valid content_type values
    // -------------------------------------------------------------------

    it.each(['text', 'image', 'file', 'voice'])('accepts content_type "%s"', (contentType) => {
      const result = validateMessageInbound(validPayload({ content_type: contentType }));
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    // -------------------------------------------------------------------
    // Missing required fields
    // -------------------------------------------------------------------

    it('rejects payload missing channel', () => {
      const payload = validPayload();
      delete payload['channel'];
      const result = validateMessageInbound(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('channel');
    });

    it('rejects payload missing sender', () => {
      const payload = validPayload();
      delete payload['sender'];
      const result = validateMessageInbound(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('sender');
    });

    it('rejects payload missing content_type', () => {
      const payload = validPayload();
      delete payload['content_type'];
      const result = validateMessageInbound(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('content_type');
    });

    it('rejects payload missing body', () => {
      const payload = validPayload();
      delete payload['body'];
      const result = validateMessageInbound(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('body');
    });

    // -------------------------------------------------------------------
    // Extra fields (additionalProperties: false)
    // -------------------------------------------------------------------

    it('rejects payload with extra fields', () => {
      const result = validateMessageInbound(validPayload({ extra_field: 'not allowed' }));
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('extra_field');
    });

    // -------------------------------------------------------------------
    // Invalid content_type
    // -------------------------------------------------------------------

    it('rejects invalid content_type value', () => {
      const result = validateMessageInbound(validPayload({ content_type: 'video' }));
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    // -------------------------------------------------------------------
    // Oversized fields
    // -------------------------------------------------------------------

    it('rejects body exceeding 8192 characters', () => {
      const oversizedBody = 'x'.repeat(8193);
      const result = validateMessageInbound(validPayload({ body: oversizedBody }));
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('accepts body at exactly 8192 characters', () => {
      const maxBody = 'x'.repeat(8192);
      const result = validateMessageInbound(validPayload({ body: maxBody }));
      expect(result.valid).toBe(true);
    });

    it('rejects channel exceeding 64 characters', () => {
      const oversizedChannel = 'c'.repeat(65);
      const result = validateMessageInbound(validPayload({ channel: oversizedChannel }));
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects sender exceeding 256 characters', () => {
      const oversizedSender = 's'.repeat(257);
      const result = validateMessageInbound(validPayload({ sender: oversizedSender }));
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    // -------------------------------------------------------------------
    // Type mismatches
    // -------------------------------------------------------------------

    it('rejects non-string body', () => {
      const result = validateMessageInbound(validPayload({ body: 12345 }));
      expect(result.valid).toBe(false);
    });

    it('rejects non-string channel', () => {
      const result = validateMessageInbound(validPayload({ channel: 42 }));
      expect(result.valid).toBe(false);
    });

    it('rejects non-object metadata', () => {
      const result = validateMessageInbound(validPayload({ metadata: 'not-an-object' }));
      expect(result.valid).toBe(false);
    });
  });
});
