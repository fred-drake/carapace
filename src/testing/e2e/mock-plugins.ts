/**
 * Deterministic mock plugins for e2e scenarios (QA-08).
 *
 * Each mock plugin has known behavior and well-defined tool declarations
 * for use in e2e test scenarios. Plugins are registered on an
 * IntegrationHarness via registerTool().
 */

import type { ToolDeclaration } from '../../types/manifest.js';
import type { RequestEnvelope } from '../../types/protocol.js';
import type { IntegrationHarness } from '../integration-harness.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockPlugin {
  /** Tool declaration. */
  tool: ToolDeclaration;
  /** Tool handler that returns a deterministic result. */
  handler: (envelope: RequestEnvelope) => Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Echo plugin — returns whatever is sent
// ---------------------------------------------------------------------------

export const echoTool: MockPlugin = {
  tool: {
    name: 'echo',
    description: 'Echo back the input text',
    risk_level: 'low',
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Text to echo' },
      },
      required: ['text'],
    },
  },
  handler: async (envelope) => {
    const args = envelope.payload.arguments as Record<string, unknown>;
    return { echoed: args['text'], timestamp: new Date().toISOString() };
  },
};

// ---------------------------------------------------------------------------
// Read email plugin — returns a deterministic email
// ---------------------------------------------------------------------------

export const readEmailTool: MockPlugin = {
  tool: {
    name: 'read_email',
    description: 'Read an email by ID',
    risk_level: 'low',
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Email ID' },
      },
      required: ['id'],
    },
  },
  handler: async (envelope) => {
    const args = envelope.payload.arguments as Record<string, unknown>;
    return {
      id: args['id'],
      from: 'alice@example.com',
      subject: 'Test email',
      body: 'This is a test email body.',
    };
  },
};

// ---------------------------------------------------------------------------
// Send email plugin — returns success with sent ID
// ---------------------------------------------------------------------------

export const sendEmailTool: MockPlugin = {
  tool: {
    name: 'send_email',
    description: 'Send an email',
    risk_level: 'low',
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', description: 'Recipient email' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  handler: async (envelope) => {
    const args = envelope.payload.arguments as Record<string, unknown>;
    return {
      sent: true,
      messageId: `msg-${Date.now()}`,
      to: args['to'],
    };
  },
};

// ---------------------------------------------------------------------------
// Calculator plugin — deterministic math
// ---------------------------------------------------------------------------

export const calculatorTool: MockPlugin = {
  tool: {
    name: 'calculator',
    description: 'Perform basic arithmetic',
    risk_level: 'low',
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation: { type: 'string', description: 'add, subtract, multiply, divide' },
        a: { type: 'number', description: 'First operand' },
        b: { type: 'number', description: 'Second operand' },
      },
      required: ['operation', 'a', 'b'],
    },
  },
  handler: async (envelope) => {
    const args = envelope.payload.arguments as Record<string, unknown>;
    const a = args['a'] as number;
    const b = args['b'] as number;
    const op = args['operation'] as string;
    let result: number;
    switch (op) {
      case 'add':
        result = a + b;
        break;
      case 'subtract':
        result = a - b;
        break;
      case 'multiply':
        result = a * b;
        break;
      case 'divide':
        result = b !== 0 ? a / b : NaN;
        break;
      default:
        result = NaN;
    }
    return { result, operation: op, a, b };
  },
};

// ---------------------------------------------------------------------------
// Get session info plugin — returns session metadata
// ---------------------------------------------------------------------------

export const getSessionInfoTool: MockPlugin = {
  tool: {
    name: 'get_session_info',
    description: 'Get current session information',
    risk_level: 'low',
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  handler: async (envelope) => {
    return {
      group: envelope.group,
      sessionId: envelope.source,
      topic: envelope.topic,
    };
  },
};

// ---------------------------------------------------------------------------
// High-risk tool — requires confirmation
// ---------------------------------------------------------------------------

export const deleteAllDataTool: MockPlugin = {
  tool: {
    name: 'delete_all_data',
    description: 'Delete all data (requires confirmation)',
    risk_level: 'high',
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        confirm: { type: 'string', description: 'Type "yes" to confirm' },
      },
      required: ['confirm'],
    },
  },
  handler: async () => {
    return { deleted: true, message: 'All data deleted' };
  },
};

// ---------------------------------------------------------------------------
// Failing plugin — always throws
// ---------------------------------------------------------------------------

export const failingTool: MockPlugin = {
  tool: {
    name: 'unstable_service',
    description: 'A service that always fails',
    risk_level: 'low',
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string' },
      },
    },
  },
  handler: async () => {
    throw new Error('Service unavailable: connection refused');
  },
};

// ---------------------------------------------------------------------------
// Memory plugin mock — returns stored memories
// ---------------------------------------------------------------------------

export const memorySearchTool: MockPlugin = {
  tool: {
    name: 'memory_search',
    description: 'Search stored memories',
    risk_level: 'low',
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  handler: async (envelope) => {
    const args = envelope.payload.arguments as Record<string, unknown>;
    return {
      results: [
        {
          content: `Memory matching "${args['query']}": User prefers TypeScript`,
          type: 'preference',
          score: 0.95,
        },
      ],
      total: 1,
    };
  },
};

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/** Register a mock plugin on an IntegrationHarness. */
export function registerMockPlugin(harness: IntegrationHarness, plugin: MockPlugin): void {
  harness.registerTool(plugin.tool, plugin.handler);
}

/** Register multiple mock plugins on an IntegrationHarness. */
export function registerMockPlugins(harness: IntegrationHarness, plugins: MockPlugin[]): void {
  for (const plugin of plugins) {
    registerMockPlugin(harness, plugin);
  }
}
