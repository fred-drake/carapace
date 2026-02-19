/**
 * Core intrinsic tools for Carapace.
 *
 * Three built-in tools that require access to core internals:
 *   - get_diagnostics: query session-scoped audit log
 *   - list_tools: enumerate all registered tools
 *   - get_session_info: return session metadata + plugin health
 *
 * Registered in the same ToolCatalog as plugin tools and invoked
 * through the same 6-stage validation pipeline. No exemptions.
 */

import type { ToolDeclaration } from '../types/manifest.js';
import type { RequestEnvelope } from '../types/protocol.js';
import type { ToolCatalog, ToolHandler } from './tool-catalog.js';
import type { SessionManager } from './session-manager.js';
import type { AuditLog } from './audit-log.js';
import type { InitFailureCategory, PluginLoadResult } from './plugin-handler.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Reserved intrinsic tool names. Plugins may not use these. */
export const INTRINSIC_TOOL_NAMES = ['get_diagnostics', 'list_tools', 'get_session_info'] as const;

// ---------------------------------------------------------------------------
// Plugin health category mapping
// ---------------------------------------------------------------------------

/**
 * Map internal init failure categories to the closed enum exposed to agents.
 * Raw exception messages are never exposed — only these categories.
 */
const HEALTH_CATEGORY_MAP: Record<InitFailureCategory, string> = {
  invalid_manifest: 'CONFIG_ERROR',
  init_error: 'INTERNAL_ERROR',
  timeout: 'INTERNAL_ERROR',
  missing_handler: 'CONFIG_ERROR',
};

// ---------------------------------------------------------------------------
// Tool declarations
// ---------------------------------------------------------------------------

const GET_DIAGNOSTICS_TOOL: ToolDeclaration = {
  name: 'get_diagnostics',
  description:
    'Query session-scoped audit log entries. ' +
    'Trace mode: pass "correlation" to get the full lifecycle of a request. ' +
    'Recent errors: pass "last_n" and "filter_outcome" to find recent failures.',
  risk_level: 'low',
  arguments_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      correlation: {
        type: 'string',
        description: 'Correlation ID to trace a specific request lifecycle',
      },
      last_n: {
        type: 'number',
        description: 'Return the last N matching entries',
        maximum: 100,
        minimum: 1,
      },
      filter_outcome: {
        type: 'string',
        description: 'Filter by outcome: "error" or "routed"',
        enum: ['error', 'routed', 'rejected', 'sanitized'],
      },
    },
  },
};

const LIST_TOOLS_TOOL: ToolDeclaration = {
  name: 'list_tools',
  description: 'Enumerate all available tools with their descriptions and risk levels.',
  risk_level: 'low',
  arguments_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
};

const GET_SESSION_INFO_TOOL: ToolDeclaration = {
  name: 'get_session_info',
  description:
    'Return current session metadata: group, session start time, and plugin health status.',
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

/** Dependencies needed to register intrinsic tools. */
export interface IntrinsicToolsDeps {
  catalog: ToolCatalog;
  sessionManager: SessionManager;
  auditLog: AuditLog;
  pluginResults: PluginLoadResult[];
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

function createGetDiagnosticsHandler(
  sessionManager: SessionManager,
  auditLog: AuditLog,
): ToolHandler {
  return async (envelope: RequestEnvelope): Promise<Record<string, unknown>> => {
    // Resolve session from the envelope source (container ID).
    const session = sessionManager.getByContainerId(envelope.source);
    if (!session) {
      return { error: 'Session not found for this container' };
    }

    const group = session.group;
    const args = envelope.payload.arguments;
    const correlation = args.correlation as string | undefined;
    const lastN = args.last_n as number | undefined;
    const filterOutcome = args.filter_outcome as string | undefined;

    if (correlation) {
      // Trace mode: query by correlation ID, scoped to group.
      const entries = auditLog.queryByCorrelation(correlation, group);
      return { entries, mode: 'trace', correlation };
    }

    // Recent entries mode.
    let entries = filterOutcome
      ? auditLog.queryByOutcome(
          filterOutcome as 'routed' | 'rejected' | 'sanitized' | 'error',
          group,
        )
      : auditLog.queryByOutcome('error', group);

    // Limit to last_n (most recent entries).
    if (lastN && entries.length > lastN) {
      entries = entries.slice(-lastN);
    }

    return { entries, mode: 'recent', count: entries.length };
  };
}

function createListToolsHandler(catalog: ToolCatalog): ToolHandler {
  return async (_envelope: RequestEnvelope): Promise<Record<string, unknown>> => {
    const tools = catalog.list().map((t) => ({
      name: t.name,
      description: t.description,
      risk_level: t.risk_level,
    }));

    return { tools };
  };
}

function createGetSessionInfoHandler(
  sessionManager: SessionManager,
  pluginResults: PluginLoadResult[],
): ToolHandler {
  return async (envelope: RequestEnvelope): Promise<Record<string, unknown>> => {
    const session = sessionManager.getByContainerId(envelope.source);
    if (!session) {
      return { error: 'Session not found for this container' };
    }

    const healthy: string[] = [];
    const failed: Array<{ name: string; category: string }> = [];

    for (const result of pluginResults) {
      if (result.ok) {
        healthy.push(result.pluginName);
      } else {
        failed.push({
          name: result.pluginName,
          category: HEALTH_CATEGORY_MAP[result.category] ?? 'INTERNAL_ERROR',
        });
      }
    }

    return {
      group: session.group,
      session_start: session.startedAt,
      plugins: { healthy, failed },
    };
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the three core intrinsic tools in the tool catalog.
 *
 * Call this after plugins are loaded so that `list_tools` can enumerate
 * both plugin and intrinsic tools.
 */
export function registerIntrinsicTools(deps: IntrinsicToolsDeps): void {
  const { catalog, sessionManager, auditLog, pluginResults } = deps;

  catalog.register(GET_DIAGNOSTICS_TOOL, createGetDiagnosticsHandler(sessionManager, auditLog));
  catalog.register(LIST_TOOLS_TOOL, createListToolsHandler(catalog));
  catalog.register(
    GET_SESSION_INFO_TOOL,
    createGetSessionInfoHandler(sessionManager, pluginResults),
  );
}
