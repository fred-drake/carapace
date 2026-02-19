/**
 * Pipeline Stage 6: Dispatch to handler.
 *
 * Calls the registered handler function for the resolved tool and constructs
 * a ResponseEnvelope from the result. This is the terminal stage — it always
 * returns a PipelineResult, never a PipelineContext.
 */

import { PROTOCOL_VERSION } from '../../types/protocol.js';
import type { RequestEnvelope, ResponseEnvelope } from '../../types/protocol.js';
import type { ToolHandler } from '../tool-catalog.js';

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Execute the handler and build a ResponseEnvelope.
 *
 * This is NOT a PipelineStage (which is synchronous). The router calls this
 * directly after all synchronous stages pass, because the handler is async.
 */
export async function dispatchToHandler(
  envelope: RequestEnvelope,
  handler: ToolHandler,
): Promise<ResponseEnvelope> {
  const result = await handler(envelope);

  const response: ResponseEnvelope = {
    id: crypto.randomUUID(),
    version: PROTOCOL_VERSION,
    type: 'response',
    topic: envelope.topic,
    source: envelope.source,
    correlation: envelope.correlation,
    timestamp: new Date().toISOString(),
    group: envelope.group,
    payload: {
      result,
      error: null,
    },
  };

  return response;
}
