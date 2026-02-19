/**
 * Plugin handler interfaces and types for Carapace.
 *
 * Defines the contract that every plugin handler must satisfy, plus
 * the result types used by PluginLoader during discovery and
 * initialization.
 *
 * This is the public API for plugin authors. TypeScript provides full
 * autocomplete for all types exported here.
 */

import type {
  EventEnvelope,
  PluginManifest,
  ToolDeclaration,
  ErrorPayload,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// SessionInfo
// ---------------------------------------------------------------------------

/**
 * Read-only session metadata returned by `CoreServices.getSessionInfo()`.
 * Automatically scoped to the current request's group by the core.
 */
export interface SessionInfo {
  group: string;
  sessionId: string;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// AuditLogFilter
// ---------------------------------------------------------------------------

/**
 * Filters for querying the audit log via `CoreServices.getAuditLog()`.
 * The `group` is always hard-coded by the core — handlers cannot query
 * other groups.
 */
export interface AuditLogFilter {
  correlation?: string;
  topic?: string;
  outcome?: 'success' | 'error';
  last_n?: number;
  since?: string;
  until?: string;
}

// ---------------------------------------------------------------------------
// AuditLogEntry
// ---------------------------------------------------------------------------

/**
 * A single entry from the audit log, returned by `CoreServices.getAuditLog()`.
 */
export interface AuditLogEntry {
  id: string;
  timestamp: string;
  topic: string;
  correlation: string;
  outcome: 'success' | 'error';
  detail: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CoreServices
// ---------------------------------------------------------------------------

/**
 * Services provided by the core to plugins during initialization.
 * All methods are automatically scoped to the current request's group
 * by the core — handlers never pass group or session identifiers.
 */
export interface CoreServices {
  getAuditLog(filters: AuditLogFilter): Promise<AuditLogEntry[]>;
  getToolCatalog(): ToolDeclaration[];
  getSessionInfo(): SessionInfo;
}

// ---------------------------------------------------------------------------
// PluginContext
// ---------------------------------------------------------------------------

/**
 * Per-invocation context passed to `handleToolInvocation`. Extracted
 * from the request envelope by the core so plugin authors don't need
 * to parse envelopes directly.
 */
export interface PluginContext {
  group: string;
  sessionId: string;
  correlationId: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// ToolInvocationResult
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by `handleToolInvocation`.
 * Either a successful result or a structured error.
 */
export type ToolInvocationResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: ErrorPayload };

// ---------------------------------------------------------------------------
// PluginHandler
// ---------------------------------------------------------------------------

/**
 * The host-side handler interface that every plugin must implement.
 *
 * Lifecycle: `initialize` → `handleToolInvocation` (many) → `shutdown`
 *
 * - `initialize` is called once during plugin loading with core services.
 * - `handleToolInvocation` processes tool calls from the container.
 * - `handleEvent` (optional) reacts to PUB/SUB events.
 * - `shutdown` is called during graceful teardown.
 */
export interface PluginHandler {
  initialize(services: CoreServices): Promise<void>;
  handleToolInvocation(
    tool: string,
    args: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ToolInvocationResult>;
  handleEvent?(envelope: EventEnvelope): Promise<void>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error message template
// ---------------------------------------------------------------------------

/**
 * Standard error message format for actionable developer errors.
 * Template: `[COMPONENT] Error: {what}. Fix: {how}. Docs: {link}`
 */
export interface ErrorMessageParts {
  component: string;
  what: string;
  how: string;
  docs?: string;
}

/**
 * Format an actionable error message following Carapace conventions.
 * Produces: `[COMPONENT] Error: {what}. Fix: {how}. Docs: {link}`
 * When `docs` is omitted, the Docs clause is excluded.
 */
export function formatErrorMessage(parts: ErrorMessageParts): string {
  const base = `[${parts.component}] Error: ${parts.what}. Fix: ${parts.how}.`;
  if (parts.docs) {
    return `${base} Docs: ${parts.docs}`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Init failure categories
// ---------------------------------------------------------------------------

/**
 * Categories of plugin initialization failure. Used by PluginLoadResult
 * to classify why a plugin could not be loaded.
 */
export type InitFailureCategory = 'invalid_manifest' | 'init_error' | 'timeout' | 'missing_handler';

// ---------------------------------------------------------------------------
// PluginLoadResult
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by PluginLoader for each plugin load attempt.
 */
export type PluginLoadResult =
  | { ok: true; pluginName: string; manifest: PluginManifest; handler: PluginHandler }
  | { ok: false; pluginName: string; error: string; category: InitFailureCategory };
