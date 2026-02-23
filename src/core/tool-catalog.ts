/**
 * Tool catalog for Carapace.
 *
 * Maintains a registry of tool declarations and their handler functions.
 * The router uses the catalog during pipeline stage 2 (topic validation)
 * and stage 6 (handler dispatch).
 */

import type { ToolDeclaration } from '../types/manifest.js';
import type { RequestEnvelope } from '../types/protocol.js';
import { createLogger, type Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

/**
 * A handler function that executes tool logic on the host side.
 * Receives the fully validated RequestEnvelope and returns the result payload.
 */
export type ToolHandler = (envelope: RequestEnvelope) => Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Catalog entry
// ---------------------------------------------------------------------------

interface CatalogEntry {
  tool: ToolDeclaration;
  handler: ToolHandler;
}

// ---------------------------------------------------------------------------
// ToolCatalog
// ---------------------------------------------------------------------------

export class ToolCatalog {
  private readonly entries: Map<string, CatalogEntry> = new Map();
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger('tool-catalog');
  }

  /**
   * Register a tool with its handler.
   *
   * @param tool - The tool declaration from the plugin manifest.
   * @param handler - The handler function that executes the tool.
   * @throws If a tool with the same name is already registered.
   */
  register(tool: ToolDeclaration, handler: ToolHandler): void {
    if (this.entries.has(tool.name)) {
      throw new Error(`Tool already registered: "${tool.name}"`);
    }
    this.entries.set(tool.name, { tool, handler });
    this.logger.debug('tool registered', { toolName: tool.name });
  }

  /**
   * Remove a tool from the catalog.
   *
   * @param toolName - The name of the tool to unregister.
   * @returns `true` if the tool existed and was removed, `false` otherwise.
   */
  unregister(toolName: string): boolean {
    const existed = this.entries.delete(toolName);
    if (existed) this.logger.debug('tool unregistered', { toolName });
    return existed;
  }

  /**
   * Check whether a tool with the given name is registered.
   */
  has(toolName: string): boolean {
    return this.entries.has(toolName);
  }

  /**
   * Retrieve the tool declaration and handler for the given name.
   * Returns undefined if the tool is not registered.
   */
  get(toolName: string): { tool: ToolDeclaration; handler: ToolHandler } | undefined {
    return this.entries.get(toolName);
  }

  /**
   * List all registered tool declarations.
   */
  list(): ToolDeclaration[] {
    return [...this.entries.values()].map((entry) => entry.tool);
  }
}
