/**
 * Pipeline Stage 2: Validate topic against the tool catalog.
 *
 * Extracts the tool name from the topic string (format:
 * "tool.invoke.{tool_name}") and verifies the tool exists in the catalog.
 * Returns UNKNOWN_TOOL error if the topic is malformed or unregistered.
 */

import { ErrorCode, ERROR_RETRIABLE_DEFAULTS } from '../../types/errors.js';
import type { ToolCatalog } from '../tool-catalog.js';
import type { PipelineStage, PipelineContext, PipelineResult } from './types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('pipeline:topic');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_INVOKE_PREFIX = 'tool.invoke.';

// ---------------------------------------------------------------------------
// Stage 2
// ---------------------------------------------------------------------------

export function createStage2Topic(catalog: ToolCatalog): PipelineStage {
  return {
    name: 'topic',

    execute(ctx: PipelineContext): PipelineResult | PipelineContext {
      const { wire } = ctx;

      // Extract tool name from topic
      if (!wire.topic.startsWith(TOOL_INVOKE_PREFIX)) {
        return {
          ok: false,
          error: {
            code: ErrorCode.UNKNOWN_TOOL,
            message: `Malformed topic: "${wire.topic}" (expected "tool.invoke.<name>")`,
            retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.UNKNOWN_TOOL],
            stage: 2,
          },
        };
      }

      const toolName = wire.topic.slice(TOOL_INVOKE_PREFIX.length);

      if (!toolName) {
        return {
          ok: false,
          error: {
            code: ErrorCode.UNKNOWN_TOOL,
            message: `Malformed topic: "${wire.topic}" (tool name is empty)`,
            retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.UNKNOWN_TOOL],
            stage: 2,
          },
        };
      }

      const entry = catalog.get(toolName);

      if (!entry) {
        return {
          ok: false,
          error: {
            code: ErrorCode.UNKNOWN_TOOL,
            message: `Unknown tool: "${toolName}"`,
            retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.UNKNOWN_TOOL],
            stage: 2,
          },
        };
      }

      logger.debug('tool resolved', { topic: wire.topic, toolName });
      return { ...ctx, tool: entry.tool };
    },
  };
}
