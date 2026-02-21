/**
 * Canonical JSON Schemas for Carapace event payloads.
 *
 * Defines and pre-compiles schemas for event types that enter the system
 * via the PUB/SUB event bus. Core validates payloads against these schemas
 * before processing — defense in depth against malformed events from
 * buggy plugins.
 *
 * Currently covers:
 * - `message.inbound` — external messages entering the system
 */

import _Ajv, { type ValidateFunction } from 'ajv';
// ajv ESM interop: default export is the constructor
const Ajv = _Ajv.default ?? _Ajv;

import type { ValidationResult } from './schema-validator.js';

// ---------------------------------------------------------------------------
// message.inbound schema
// ---------------------------------------------------------------------------

export const MESSAGE_INBOUND_SCHEMA = {
  type: 'object' as const,
  required: ['channel', 'sender', 'content_type', 'body'],
  additionalProperties: false as const,
  properties: {
    channel: { type: 'string' as const, maxLength: 64 },
    sender: { type: 'string' as const, maxLength: 256 },
    content_type: {
      type: 'string' as const,
      enum: ['text', 'image', 'file', 'voice'],
    },
    body: { type: 'string' as const, maxLength: 8192 },
    metadata: { type: 'object' as const },
  },
} as const;

// ---------------------------------------------------------------------------
// Compiled validator
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
const _validateMessageInbound: ValidateFunction = ajv.compile(MESSAGE_INBOUND_SCHEMA);

/**
 * Validate a payload against the message.inbound canonical schema.
 *
 * Returns a ValidationResult compatible with SchemaValidator's interface.
 */
export function validateMessageInbound(payload: Record<string, unknown>): ValidationResult {
  const valid = _validateMessageInbound(payload) as boolean;

  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors = (_validateMessageInbound.errors ?? []).map((err) => {
    const path = err.instancePath || '';
    const msg = err.message ?? 'unknown error';
    if (err.keyword === 'additionalProperties') {
      const extra = (err.params as { additionalProperty?: string }).additionalProperty ?? '';
      return `${path}: additional property "${extra}" not allowed`;
    }
    if (err.keyword === 'required') {
      const missing = (err.params as { missingProperty?: string }).missingProperty ?? '';
      return `${path}: required property "${missing}" is missing`;
    }
    return `${path}: ${msg}`;
  });

  return { valid: false, errors };
}
