/**
 * Memory plugin tool handlers for Carapace.
 *
 * Implements the four memory tools: memory_store, memory_search,
 * memory_brief, memory_delete. Each handler validates arguments,
 * enforces per-session rate limits, and delegates to MemoryStore.
 *
 * Provenance (session_id, group) is always taken from PluginContext,
 * never from tool arguments. The behavioral flag is derived from
 * entry type, never agent-supplied.
 */

import type { PluginContext, ToolInvocationResult } from '../../core/plugin-handler.js';
import type { MemoryStore, MemoryEntryType, SearchResult } from './memory-store.js';
import { ErrorCode } from '../../types/errors.js';
import { stripAllNewlines } from './memory-security.js';

// ---------------------------------------------------------------------------
// Rate limit defaults
// ---------------------------------------------------------------------------

const MAX_STORES_PER_SESSION = 20;
const MAX_SUPERSEDES_PER_SESSION = 5;
const MAX_DELETES_PER_SESSION = 5;

// ---------------------------------------------------------------------------
// Brief config
// ---------------------------------------------------------------------------

export interface MemoryBriefConfig {
  maxBriefEntries: number;
  maxBriefChars: number;
}

const DEFAULT_BRIEF_CONFIG: MemoryBriefConfig = {
  maxBriefEntries: 50,
  maxBriefChars: 10000,
};

// ---------------------------------------------------------------------------
// Session rate limit tracker
// ---------------------------------------------------------------------------

interface SessionLimits {
  stores: number;
  supersedes: number;
  deletes: number;
}

// ---------------------------------------------------------------------------
// Newline stripping — delegated to memory-security module
// ---------------------------------------------------------------------------

// stripAllNewlines is imported from memory-security.ts and covers all
// Unicode newline variants: LF, CR, CRLF, VT, FF, NEL, LS, PS.

// ---------------------------------------------------------------------------
// MemoryHandler
// ---------------------------------------------------------------------------

export class MemoryHandler {
  private readonly store: MemoryStore;
  private readonly briefConfig: MemoryBriefConfig;
  private readonly sessionLimits: Map<string, SessionLimits> = new Map();

  constructor(store: MemoryStore, briefConfig?: Partial<MemoryBriefConfig>) {
    this.store = store;
    this.briefConfig = { ...DEFAULT_BRIEF_CONFIG, ...briefConfig };
  }

  async handleToolInvocation(
    tool: string,
    args: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ToolInvocationResult> {
    switch (tool) {
      case 'memory_store':
        return this.handleStore(args, context);
      case 'memory_search':
        return this.handleSearch(args);
      case 'memory_brief':
        return this.handleBrief(args);
      case 'memory_delete':
        return this.handleDelete(args, context);
      default:
        return {
          ok: false,
          error: {
            code: ErrorCode.HANDLER_ERROR,
            message: `Unknown tool: "${tool}"`,
            retriable: false,
          },
        };
    }
  }

  // -------------------------------------------------------------------------
  // memory_store
  // -------------------------------------------------------------------------

  private async handleStore(
    args: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ToolInvocationResult> {
    const limits = this.getLimits(context.sessionId);

    // Rate limit: max stores per session
    if (limits.stores >= MAX_STORES_PER_SESSION) {
      return {
        ok: false,
        error: {
          code: ErrorCode.RATE_LIMITED,
          message: `Maximum ${MAX_STORES_PER_SESSION} memory_store calls per session reached.`,
          retriable: false,
        },
      };
    }

    // Rate limit: max supersedes per session
    if (args['supersedes'] && limits.supersedes >= MAX_SUPERSEDES_PER_SESSION) {
      return {
        ok: false,
        error: {
          code: ErrorCode.RATE_LIMITED,
          message: `Maximum ${MAX_SUPERSEDES_PER_SESSION} supersedes per session reached.`,
          retriable: false,
        },
      };
    }

    try {
      const entry = this.store.store({
        type: args['type'] as MemoryEntryType,
        content: args['content'] as string,
        tags: (args['tags'] as string[] | undefined) ?? [],
        supersedes: args['supersedes'] as string | undefined,
        session_id: context.sessionId,
        group: context.group,
      });

      limits.stores++;
      if (args['supersedes']) {
        limits.supersedes++;
      }

      return {
        ok: true,
        result: {
          id: entry.id,
          type: entry.type,
          content: entry.content,
          behavioral: entry.behavioral,
          tags: entry.tags,
          supersedes: entry.supersedes,
          superseded_by: entry.superseded_by,
          session_id: entry.session_id,
          group: entry.group,
          created_at: entry.created_at,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: err instanceof Error ? err.message : String(err),
          retriable: false,
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // memory_search
  // -------------------------------------------------------------------------

  private async handleSearch(args: Record<string, unknown>): Promise<ToolInvocationResult> {
    const results: SearchResult[] = this.store.search({
      query: args['query'] as string | undefined,
      tags: args['tags'] as string[] | undefined,
      type: args['type'] as MemoryEntryType | undefined,
      include_superseded: args['include_superseded'] as boolean | undefined,
      limit: args['limit'] as number | undefined,
    });

    return {
      ok: true,
      result: {
        results: results.map((r) => ({
          id: r.id,
          type: r.type,
          content: r.content,
          behavioral: r.behavioral,
          tags: r.tags,
          created_at: r.created_at,
          relevance_score: r.relevance_score,
        })),
      },
    };
  }

  // -------------------------------------------------------------------------
  // memory_brief
  // -------------------------------------------------------------------------

  private async handleBrief(args: Record<string, unknown>): Promise<ToolInvocationResult> {
    const includeProvenance = args['include_provenance'] === true;
    const totalCount = this.store.count();

    // Fetch all active entries (high limit to get everything for brief)
    const allEntries = this.store.search({ limit: 1000 });

    // Sort: behavioral first, then by created_at descending (already sorted)
    const sorted = [...allEntries].sort((a, b) => {
      if (a.behavioral !== b.behavioral) {
        return a.behavioral ? -1 : 1;
      }
      return 0; // preserve existing created_at DESC order within each group
    });

    // Apply limits
    const briefEntries: Array<Record<string, unknown>> = [];
    let charCount = 0;

    for (const entry of sorted) {
      if (briefEntries.length >= this.briefConfig.maxBriefEntries) break;

      const strippedContent = stripAllNewlines(entry.content);
      if (charCount + strippedContent.length > this.briefConfig.maxBriefChars) break;

      const ageDays = Math.floor(
        (Date.now() - new Date(entry.created_at).getTime()) / (24 * 60 * 60 * 1000),
      );

      const briefEntry: Record<string, unknown> = {
        id: entry.id,
        type: entry.type,
        content: strippedContent,
        behavioral: entry.behavioral,
        tags: entry.tags,
        age_days: ageDays,
      };

      if (includeProvenance) {
        // Need to fetch full entry for session_id
        const full = this.store.getById(entry.id);
        if (full) {
          briefEntry['session_id'] = full.session_id;
          briefEntry['group'] = full.group;
        }
      }

      briefEntries.push(briefEntry);
      charCount += strippedContent.length;
    }

    return {
      ok: true,
      result: {
        entries: briefEntries,
        generated_at: new Date().toISOString(),
        entry_count: totalCount,
        brief_count: briefEntries.length,
      },
    };
  }

  // -------------------------------------------------------------------------
  // memory_delete
  // -------------------------------------------------------------------------

  private async handleDelete(
    args: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ToolInvocationResult> {
    const limits = this.getLimits(context.sessionId);

    if (limits.deletes >= MAX_DELETES_PER_SESSION) {
      return {
        ok: false,
        error: {
          code: ErrorCode.RATE_LIMITED,
          message: `Maximum ${MAX_DELETES_PER_SESSION} memory_delete calls per session reached.`,
          retriable: false,
        },
      };
    }

    const id = args['id'] as string;
    const deleted = this.store.delete(id);

    if (!deleted) {
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Memory entry "${id}" not found.`,
          retriable: false,
        },
      };
    }

    limits.deletes++;

    return {
      ok: true,
      result: { deleted: true, id },
    };
  }

  // -------------------------------------------------------------------------
  // Rate limit helpers
  // -------------------------------------------------------------------------

  private getLimits(sessionId: string): SessionLimits {
    let limits = this.sessionLimits.get(sessionId);
    if (!limits) {
      limits = { stores: 0, supersedes: 0, deletes: 0 };
      this.sessionLimits.set(sessionId, limits);
    }
    return limits;
  }
}
