/**
 * Plugin test SDK for Carapace.
 *
 * Lightweight utilities for plugin authors to unit test their handlers
 * in isolation — no ZeroMQ, no running core, no containers.
 *
 * Usage:
 *   import { createTestContext, createTestInvocation } from '@carapace/testing';
 */

import type {
  PluginContext,
  PluginHandler,
  CoreServices,
  ToolInvocationResult,
} from '../core/plugin-handler.js';
import type { ErrorCodeValue, ErrorPayload } from '../types/errors.js';

// ---------------------------------------------------------------------------
// createTestContext()
// ---------------------------------------------------------------------------

/**
 * Create a mock `PluginContext` for testing handler invocations.
 * All fields have sensible defaults that can be overridden.
 */
export function createTestContext(overrides?: Partial<PluginContext>): PluginContext {
  return {
    group: 'test-group',
    sessionId: 'test-session',
    correlationId: 'test-correlation',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createTestInvocation()
// ---------------------------------------------------------------------------

/** Options for `createTestInvocation`. */
export interface TestInvocationOptions {
  /** If true, calls handler.initialize() before the invocation. */
  autoInit?: boolean;
}

/**
 * Simulate a tool invocation against a handler.
 *
 * Calls `handler.handleToolInvocation(tool, args, context)` directly
 * with a test context. Optionally initializes the handler first.
 */
export async function createTestInvocation(
  handler: PluginHandler,
  tool: string,
  args: Record<string, unknown>,
  contextOverrides?: Partial<PluginContext>,
  options?: TestInvocationOptions,
): Promise<ToolInvocationResult> {
  if (options?.autoInit) {
    const services = createStubCoreServices();
    await handler.initialize(services);
  }

  const context = createTestContext(contextOverrides);
  return handler.handleToolInvocation(tool, args, context);
}

// ---------------------------------------------------------------------------
// Stub CoreServices
// ---------------------------------------------------------------------------

/**
 * Create a minimal stub `CoreServices` for handler initialization.
 * Returns empty data for all methods.
 */
function createStubCoreServices(): CoreServices {
  return {
    getAuditLog: async () => [],
    getToolCatalog: () => [],
    getSessionInfo: () => ({
      group: 'test-group',
      sessionId: 'test-session',
      startedAt: new Date().toISOString(),
    }),
  };
}

// ---------------------------------------------------------------------------
// FakeCredentialStore
// ---------------------------------------------------------------------------

/**
 * In-memory credential store for testing plugins that need secrets.
 * No real credential storage — just a Map with a clean API.
 */
export class FakeCredentialStore {
  private readonly store: Map<string, string>;

  constructor(initial?: Record<string, string>) {
    this.store = new Map(initial ? Object.entries(initial) : []);
  }

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  keys(): string[] {
    return [...this.store.keys()];
  }

  clear(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Response assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a tool invocation returned a success result.
 * Returns the result data for further assertions.
 *
 * @throws If the result is an error.
 */
export function assertSuccessResult(result: ToolInvocationResult): Record<string, unknown> {
  if (!result.ok) {
    throw new Error(
      `Expected success result but got error: ${result.error.code} — ${result.error.message}`,
    );
  }
  return result.result;
}

/**
 * Assert that a tool invocation returned an error result.
 * Optionally checks the error code.
 *
 * @throws If the result is a success, or if the error code doesn't match.
 */
export function assertErrorResult(
  result: ToolInvocationResult,
  expectedCode?: ErrorCodeValue,
): ErrorPayload {
  if (result.ok) {
    throw new Error(`Expected error result but got success: ${JSON.stringify(result.result)}`);
  }
  if (expectedCode && result.error.code !== expectedCode) {
    throw new Error(`Expected error code ${expectedCode} but got ${result.error.code}`);
  }
  return result.error;
}

// ---------------------------------------------------------------------------
// Credential leak detection
// ---------------------------------------------------------------------------

/** Patterns that indicate credential leakage. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  /\bsk-[A-Za-z0-9\-]{10,}/,
  /X-API-Key:\s*\S+/i,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bxox[bpas]-[A-Za-z0-9\-]+/,
];

/**
 * Assert that a tool invocation result does not contain credential patterns.
 *
 * Recursively inspects all string values in the result (including nested
 * objects and error messages). Throws if any credential pattern is found.
 */
export function assertNoCredentialLeak(result: ToolInvocationResult): void {
  const strings = collectStrings(result);
  for (const str of strings) {
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(str)) {
        throw new Error(
          `Potential credential leak detected: value matches pattern ${pattern}. ` +
            `Value (truncated): "${str.slice(0, 60)}..."`,
        );
      }
    }
  }
}

/**
 * Recursively collect all string values from a nested object.
 */
function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}
