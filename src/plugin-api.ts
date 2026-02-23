// Plugin-author public API. External plugins import from '@carapace/core/plugin'.

// Handler contract
export type {
  PluginHandler,
  CoreServices,
  ChannelServices,
  PluginContext,
  ToolInvocationResult,
  PluginVerifyResult,
  SessionInfo,
  SessionLookup,
  SessionRecord,
  SessionFindCriteria,
  AuditLogFilter,
  AuditLogEntry,
  ErrorMessageParts,
} from './core/plugin-handler.js';

export { formatErrorMessage } from './core/plugin-handler.js';

// Structured errors
export { ToolError, isToolError } from './core/tool-error.js';
export type { ToolErrorOptions } from './core/tool-error.js';

// Protocol types needed by handleEvent
export type { EventEnvelope } from './types/index.js';

// Manifest + tool types for reference
export type { ToolDeclaration, PluginManifest, ErrorPayload } from './types/index.js';

// Error codes (runtime value)
export { ErrorCode } from './types/index.js';
export type { ErrorCodeValue } from './types/index.js';
