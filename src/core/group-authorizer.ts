/**
 * Group-level authorization for Carapace.
 *
 * Reads `allowed_groups` from loaded plugin manifests and builds
 * the per-tool group restriction map consumed by pipeline stage 4.
 *
 * Plugins without `allowed_groups` are unrestricted — their tools
 * are available to all groups. Plugins with an explicit (possibly empty)
 * `allowed_groups` array restrict their tools to only those groups.
 */

import type { PluginLoadResult } from './plugin-handler.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for an unauthorized access attempt (for audit logging). */
export interface UnauthorizedContext {
  tool: string;
  plugin: string;
  requestedGroup: string;
  allowedGroups: string[];
}

// ---------------------------------------------------------------------------
// buildToolGroupRestrictions
// ---------------------------------------------------------------------------

/**
 * Build a tool name → allowed groups map from loaded plugin results.
 *
 * Only includes tools from plugins that have an explicit `allowed_groups`
 * field. Plugins without `allowed_groups` are unrestricted and their
 * tools are not added to the map (stage 4 treats missing entries as
 * unrestricted).
 */
export function buildToolGroupRestrictions(results: PluginLoadResult[]): Map<string, Set<string>> {
  const restrictions = new Map<string, Set<string>>();

  for (const result of results) {
    if (!result.ok) continue;

    const { manifest } = result;
    if (!manifest.allowed_groups) continue;

    const allowedSet = new Set(manifest.allowed_groups);

    for (const tool of manifest.provides.tools) {
      restrictions.set(tool.name, allowedSet);
    }
  }

  return restrictions;
}

// ---------------------------------------------------------------------------
// GroupAuthorizer
// ---------------------------------------------------------------------------

export class GroupAuthorizer {
  private readonly restrictions: Map<string, Set<string>>;
  private readonly pluginGroupMap: Map<string, string[] | null>;
  private readonly toolPluginMap: Map<string, string>;

  constructor(results: PluginLoadResult[]) {
    this.restrictions = buildToolGroupRestrictions(results);
    this.pluginGroupMap = new Map();
    this.toolPluginMap = new Map();

    for (const result of results) {
      if (!result.ok) continue;

      const groups = result.manifest.allowed_groups ?? null;
      this.pluginGroupMap.set(result.pluginName, groups);

      for (const tool of result.manifest.provides.tools) {
        this.toolPluginMap.set(tool.name, result.pluginName);
      }
    }
  }

  /**
   * Check whether a group is authorized to invoke a tool.
   *
   * Returns true if:
   * - The tool is not in the restriction map (unrestricted or unknown)
   * - The group is in the tool's allowed set
   */
  isAuthorized(toolName: string, group: string): boolean {
    const allowedGroups = this.restrictions.get(toolName);
    if (!allowedGroups) return true;
    return allowedGroups.has(group);
  }

  /**
   * Get the tool group restrictions map for pipeline stage 4.
   *
   * Returns undefined when no plugins have group restrictions,
   * so that stage 4 can skip authorization entirely.
   */
  getToolGroupRestrictions(): Map<string, Set<string>> {
    return this.restrictions;
  }

  /**
   * Get the allowed groups for a plugin.
   *
   * Returns:
   * - string[] when the plugin has explicit allowed_groups
   * - null when the plugin is unrestricted
   * - undefined when the plugin is not known
   */
  getPluginGroups(pluginName: string): string[] | null | undefined {
    if (!this.pluginGroupMap.has(pluginName)) return undefined;
    return this.pluginGroupMap.get(pluginName)!;
  }

  /**
   * Describe an unauthorized access attempt with full context.
   *
   * Returns undefined if the access is actually authorized or the
   * tool is unrestricted. Otherwise returns context suitable for
   * audit logging.
   */
  describeUnauthorized(toolName: string, group: string): UnauthorizedContext | undefined {
    if (this.isAuthorized(toolName, group)) return undefined;

    const allowedGroups = this.restrictions.get(toolName);
    const plugin = this.toolPluginMap.get(toolName) ?? 'unknown';

    return {
      tool: toolName,
      plugin,
      requestedGroup: group,
      allowedGroups: allowedGroups ? [...allowedGroups] : [],
    };
  }
}
