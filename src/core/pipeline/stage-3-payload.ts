/**
 * Pipeline Stage 3: JSON Schema validation of arguments.
 *
 * Validates the wire message's arguments against the tool's declared
 * arguments_schema using ajv. Enforces additionalProperties: false to
 * prevent untrusted data leaking into plugin handlers.
 */

import _Ajv, { type ErrorObject } from 'ajv';
// ajv ESM interop: default export is the constructor
const Ajv = _Ajv.default ?? _Ajv;

import { ErrorCode, ERROR_RETRIABLE_DEFAULTS } from '../../types/errors.js';
import type { PipelineStage, PipelineContext, PipelineResult } from './types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('pipeline:payload');

// ---------------------------------------------------------------------------
// Stage 3
// ---------------------------------------------------------------------------

export const stage3Payload: PipelineStage = {
  name: 'payload',

  execute(ctx: PipelineContext): PipelineResult | PipelineContext {
    const { wire, tool } = ctx;

    if (!tool) {
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Pipeline error: tool not resolved before payload validation',
          retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.VALIDATION_FAILED],
          stage: 3,
        },
      };
    }

    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile({
      ...tool.arguments_schema,
      additionalProperties: false,
    });

    const valid = validate(wire.arguments);

    if (!valid) {
      const errors = validate.errors ?? [];
      const details = errors
        .map((e: ErrorObject) => {
          const path = e.instancePath || '/';
          return `${path}: ${e.message}`;
        })
        .join('; ');

      const firstField = errors[0]?.instancePath?.replace(/^\//, '') || undefined;

      logger.debug('validation failed', { correlation: ctx.wire?.correlation, details });
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Argument validation failed: ${details}`,
          retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.VALIDATION_FAILED],
          stage: 3,
          ...(firstField ? { field: firstField } : {}),
        },
      };
    }

    return ctx;
  },
};
