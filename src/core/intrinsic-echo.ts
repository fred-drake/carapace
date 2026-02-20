/**
 * Intrinsic echo tool — always available, built into the core.
 *
 * Echoes the `text` argument back as `{ echoed: text }`. Used for E2E
 * testing the full IPC round-trip: container → ZMQ → pipeline → handler
 * → sanitizer → ZMQ → container.
 */

import type { ToolDeclaration } from '../types/manifest.js';
import type { RequestEnvelope } from '../types/protocol.js';
import type { ToolHandler } from './tool-catalog.js';

// ---------------------------------------------------------------------------
// Tool declaration
// ---------------------------------------------------------------------------

export const ECHO_TOOL_DECLARATION: ToolDeclaration = {
  name: 'echo',
  description: 'Echoes input text back to the caller',
  risk_level: 'low',
  arguments_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', description: 'The text to echo back' },
    },
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const echoToolHandler: ToolHandler = async (envelope: RequestEnvelope) => {
  const args = envelope.payload.arguments;
  const text = (args['text'] as string) ?? '';
  return { echoed: text };
};
