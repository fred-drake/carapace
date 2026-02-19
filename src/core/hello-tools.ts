/**
 * Hello intrinsic tools for Carapace.
 *
 * Three first-run-experience tools that verify the pipeline works end-to-end:
 *   - hello.greet: returns a welcome message with group name
 *   - hello.echo: echoes back provided arguments
 *   - hello.time: returns current host time
 *
 * Registered conditionally based on HelloConfig.enabled (config.toml [hello]).
 * Uses the same ToolCatalog as plugin and core intrinsic tools.
 */

import type { ToolDeclaration } from '../types/manifest.js';
import type { RequestEnvelope } from '../types/protocol.js';
import type { ToolCatalog, ToolHandler } from './tool-catalog.js';
import type { HelloConfig } from '../types/config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Reserved hello tool names. Plugins may not use these when hello is enabled. */
export const HELLO_TOOL_NAMES = ['hello.greet', 'hello.echo', 'hello.time'] as const;

// ---------------------------------------------------------------------------
// Tool declarations
// ---------------------------------------------------------------------------

const HELLO_GREET_TOOL: ToolDeclaration = {
  name: 'hello.greet',
  description: 'Return a welcome message. Useful for verifying the pipeline works end-to-end.',
  risk_level: 'low',
  arguments_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: {
        type: 'string',
        description: 'Optional name to include in the greeting',
      },
    },
  },
};

const HELLO_ECHO_TOOL: ToolDeclaration = {
  name: 'hello.echo',
  description: 'Echo back the provided arguments. Verifies argument passing through the pipeline.',
  risk_level: 'low',
  arguments_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      message: {
        type: 'string',
        description: 'Message to echo back',
      },
    },
  },
};

const HELLO_TIME_TOOL: ToolDeclaration = {
  name: 'hello.time',
  description: 'Return the current host time. Verifies the host-side handler executes correctly.',
  risk_level: 'low',
  arguments_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
};

// ---------------------------------------------------------------------------
// Registration options
// ---------------------------------------------------------------------------

/** Dependencies needed to register hello tools. */
export interface HelloToolsDeps {
  catalog: ToolCatalog;
  config: HelloConfig;
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

function createGreetHandler(): ToolHandler {
  return async (envelope: RequestEnvelope): Promise<Record<string, unknown>> => {
    const args = envelope.payload.arguments;
    const name = (args.name as string | undefined) ?? envelope.group;
    return { message: `Welcome to Carapace, ${name}!` };
  };
}

function createEchoHandler(): ToolHandler {
  return async (envelope: RequestEnvelope): Promise<Record<string, unknown>> => {
    const args = envelope.payload.arguments;
    const message = (args.message as string | undefined) ?? '';
    return { echo: message, arguments: { ...args } };
  };
}

function createTimeHandler(): ToolHandler {
  return async (_envelope: RequestEnvelope): Promise<Record<string, unknown>> => {
    return {
      time: new Date().toISOString(),
      timezone_offset: new Date().getTimezoneOffset(),
    };
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the three hello tools in the tool catalog.
 *
 * Skips registration entirely when `config.enabled` is false.
 * Throws if any hello tool name is already registered (via ToolCatalog).
 */
export function registerHelloTools(deps: HelloToolsDeps): void {
  const { catalog, config } = deps;

  if (!config.enabled) {
    return;
  }

  catalog.register(HELLO_GREET_TOOL, createGreetHandler());
  catalog.register(HELLO_ECHO_TOOL, createEchoHandler());
  catalog.register(HELLO_TIME_TOOL, createTimeHandler());
}
