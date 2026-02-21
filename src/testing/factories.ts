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
import type { LogEntry, LogLevel } from '../core/logger.js';

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

// ---------------------------------------------------------------------------
// Log entry assertion helper
// ---------------------------------------------------------------------------

const VALID_LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Assert that a log entry has the correct structure and optionally matches
 * expected field values.
 *
 * @param entry - The log entry to validate.
 * @param expected - Optional expected values for specific fields.
 * @throws If the entry is missing required fields or has invalid values.
 */
export function assertValidLogEntry(
  entry: LogEntry,
  expected?: {
    component?: string;
    level?: LogLevel;
    msg?: string;
    correlation?: string;
    topic?: string;
    group?: string;
  },
): void {
  // Required fields
  if (!entry.level || !VALID_LOG_LEVELS.includes(entry.level)) {
    throw new Error(`Invalid log level: ${entry.level}`);
  }
  if (!entry.ts) {
    throw new Error('Missing ts field');
  }
  // Validate ISO 8601
  const parsed = new Date(entry.ts);
  if (isNaN(parsed.getTime()) || parsed.toISOString() !== entry.ts) {
    throw new Error(`Invalid ISO 8601 timestamp: ${entry.ts}`);
  }
  if (!entry.component) {
    throw new Error('Missing component field');
  }
  if (!entry.msg && entry.msg !== '') {
    throw new Error('Missing msg field');
  }

  // Optional expected matches
  if (expected) {
    if (expected.component !== undefined && entry.component !== expected.component) {
      throw new Error(`Expected component "${expected.component}", got "${entry.component}"`);
    }
    if (expected.level !== undefined && entry.level !== expected.level) {
      throw new Error(`Expected level "${expected.level}", got "${entry.level}"`);
    }
    if (expected.msg !== undefined && entry.msg !== expected.msg) {
      throw new Error(`Expected msg "${expected.msg}", got "${entry.msg}"`);
    }
    if (expected.correlation !== undefined && entry.correlation !== expected.correlation) {
      throw new Error(`Expected correlation "${expected.correlation}", got "${entry.correlation}"`);
    }
    if (expected.topic !== undefined && entry.topic !== expected.topic) {
      throw new Error(`Expected topic "${expected.topic}", got "${entry.topic}"`);
    }
    if (expected.group !== undefined && entry.group !== expected.group) {
      throw new Error(`Expected group "${expected.group}", got "${entry.group}"`);
    }
  }
}
