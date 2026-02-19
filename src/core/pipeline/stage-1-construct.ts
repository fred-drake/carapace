/**
 * Pipeline Stage 1: Construct envelope.
 *
 * Creates a full RequestEnvelope from the container's WireMessage and the
 * host's trusted SessionContext. The core owns every identity field — the
 * container only contributes topic, correlation, and arguments.
 */

import { PROTOCOL_VERSION } from '../../types/protocol.js';
import type { RequestEnvelope } from '../../types/protocol.js';
import type { PipelineStage, PipelineContext, PipelineResult } from './types.js';

// ---------------------------------------------------------------------------
// Stage 1
// ---------------------------------------------------------------------------

export const stage1Construct: PipelineStage = {
  name: 'construct',

  execute(ctx: PipelineContext): PipelineResult | PipelineContext {
    const { wire, session } = ctx;

    const envelope: RequestEnvelope = {
      id: crypto.randomUUID(),
      version: PROTOCOL_VERSION,
      type: 'request',
      topic: wire.topic,
      source: session.source,
      correlation: wire.correlation,
      timestamp: new Date().toISOString(),
      group: session.group,
      payload: { arguments: { ...wire.arguments } },
    };

    return { ...ctx, envelope };
  },
};
