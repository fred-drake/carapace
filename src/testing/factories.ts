/**
 * Test factories for Carapace protocol types.
 *
 * Each factory returns a valid default object. Pass a DeepPartial override
 * to customise any nested field. Every call returns a fresh object — no
 * shared references between invocations.
 */

import type {
  WireMessage,
  EventEnvelope,
  RequestEnvelope,
  ResponseEnvelope,
  ToolDeclaration,
  PluginManifest,
  ErrorPayload,
} from '../types/index.js';
import { ErrorCode } from '../types/index.js';

// ---------------------------------------------------------------------------
// DeepPartial helper
// ---------------------------------------------------------------------------

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// ---------------------------------------------------------------------------
// Deep merge
// ---------------------------------------------------------------------------

/**
 * Recursively merge `source` into a clone of `target`.
 *
 * - Plain objects are merged key-by-key.
 * - Arrays and primitives in `source` replace the corresponding value in
 *   `target` outright (no element-level merging).
 * - `target` is never mutated; a fresh object is returned.
 */
export function deepMerge<T extends object>(target: T, source: DeepPartial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as Array<keyof T & string>) {
    const srcVal = source[key as keyof DeepPartial<T>];
    const tgtVal = target[key];

    if (
      srcVal !== null &&
      srcVal !== undefined &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      tgtVal !== undefined &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as DeepPartial<Record<string, unknown>>,
      ) as T[keyof T & string];
    } else {
      result[key] = srcVal as T[keyof T & string];
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createWireMessage(overrides?: DeepPartial<WireMessage>): WireMessage {
  const defaults: WireMessage = {
    topic: 'tool.invoke.test_tool',
    correlation: 'corr-001',
    arguments: { input: 'test' },
  };
  return overrides
    ? deepMerge(defaults, overrides)
    : { ...defaults, arguments: { ...defaults.arguments } };
}

export function createEventEnvelope(overrides?: DeepPartial<EventEnvelope>): EventEnvelope {
  const defaults: EventEnvelope = {
    id: 'evt-001',
    version: 1,
    type: 'event',
    topic: 'message.inbound',
    source: 'test',
    correlation: null,
    timestamp: new Date().toISOString(),
    group: 'test-group',
    payload: { channel: 'test', body: 'hello' },
  };
  return overrides
    ? deepMerge(defaults, overrides)
    : {
        ...defaults,
        payload: { ...defaults.payload },
      };
}

export function createRequestEnvelope(overrides?: DeepPartial<RequestEnvelope>): RequestEnvelope {
  const defaults: RequestEnvelope = {
    id: 'req-001',
    version: 1,
    type: 'request',
    topic: 'tool.invoke.test_tool',
    source: 'agent-test',
    correlation: 'corr-001',
    timestamp: new Date().toISOString(),
    group: 'test-group',
    payload: { arguments: { input: 'test' } },
  };
  return overrides
    ? deepMerge(defaults, overrides)
    : {
        ...defaults,
        payload: { arguments: { ...defaults.payload.arguments } },
      };
}

export function createResponseEnvelope(
  overrides?: DeepPartial<ResponseEnvelope>,
): ResponseEnvelope {
  const defaults: ResponseEnvelope = {
    id: 'res-001',
    version: 1,
    type: 'response',
    topic: 'tool.invoke.test_tool',
    source: 'test-plugin',
    correlation: 'corr-001',
    timestamp: new Date().toISOString(),
    group: 'test-group',
    payload: { result: { ok: true }, error: null },
  };
  return overrides
    ? deepMerge(defaults, overrides)
    : {
        ...defaults,
        payload: {
          ...defaults.payload,
          result: { ...(defaults.payload.result as Record<string, unknown>) },
        },
      };
}

export function createToolDeclaration(overrides?: DeepPartial<ToolDeclaration>): ToolDeclaration {
  const defaults: ToolDeclaration = {
    name: 'test_tool',
    description: 'A test tool',
    risk_level: 'low',
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string' },
      },
    },
  };
  return overrides
    ? deepMerge(defaults, overrides)
    : {
        ...defaults,
        arguments_schema: {
          ...defaults.arguments_schema,
          properties: { ...defaults.arguments_schema.properties },
        },
      };
}

export function createManifest(overrides?: DeepPartial<PluginManifest>): PluginManifest {
  const defaults: PluginManifest = {
    description: 'Test plugin',
    version: '1.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Test' },
    provides: {
      channels: [],
      tools: [createToolDeclaration()],
    },
    subscribes: [],
  };
  return overrides
    ? deepMerge(defaults, overrides)
    : {
        ...defaults,
        author: { ...defaults.author },
        provides: {
          channels: [...defaults.provides.channels],
          tools: defaults.provides.tools.map((t) => createToolDeclaration(t)),
        },
        subscribes: [...defaults.subscribes],
      };
}

export function createErrorPayload(overrides?: DeepPartial<ErrorPayload>): ErrorPayload {
  const defaults: ErrorPayload = {
    code: ErrorCode.PLUGIN_ERROR,
    message: 'An error occurred',
    retriable: false,
  };
  return overrides ? deepMerge(defaults, overrides) : { ...defaults };
}
