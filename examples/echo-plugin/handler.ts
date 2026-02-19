/**
 * Echo plugin — minimal example of a Carapace plugin handler.
 *
 * Demonstrates the full PluginHandler lifecycle in under 30 lines.
 */

import type {
  PluginHandler,
  CoreServices,
  PluginContext,
  ToolInvocationResult,
} from '../../src/core/plugin-handler.js';

const handler: PluginHandler = {
  async initialize(_services: CoreServices): Promise<void> {},

  async handleToolInvocation(
    _tool: string,
    args: Record<string, unknown>,
    _context: PluginContext,
  ): Promise<ToolInvocationResult> {
    return { ok: true, result: { echoed: args['text'] ?? '' } };
  },

  async shutdown(): Promise<void> {},
};

export default handler;
