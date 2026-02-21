/**
 * Plugin manifest types for Carapace.
 *
 * These types mirror the JSON structure declared in each plugin's
 * manifest.json. The canonical reference is docs/ARCHITECTURE.md §
 * "Plugin Manifest".
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Tool risk levels that control host-side confirmation gates. */
export type RiskLevel = 'low' | 'high';

/**
 * Session policy for a plugin. Controls how the event dispatcher
 * selects a Claude Code session when triggering this plugin's group.
 *
 * - `"fresh"` (default): Always start a new session.
 * - `"resume"`: Resume the most recent non-expired session, or start fresh.
 * - `"explicit"`: Plugin must provide a `resolveSession()` handler.
 */
export type SessionPolicy = 'fresh' | 'resume' | 'explicit';

// ---------------------------------------------------------------------------
// Author
// ---------------------------------------------------------------------------

export interface Author {
  name: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// JSON Schema subset used inside tool argument schemas
// ---------------------------------------------------------------------------

export interface JsonSchemaProperty {
  type: string;
  description?: string;
  default?: unknown;
  maxLength?: number;
  format?: string;
  maximum?: number;
  minimum?: number;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  maxItems?: number;
}

export interface JsonSchema {
  type: 'object';
  required?: string[];
  additionalProperties: false;
  properties: Record<string, JsonSchemaProperty>;
}

// ---------------------------------------------------------------------------
// Tool declaration
// ---------------------------------------------------------------------------

export interface ToolDeclaration {
  name: string;
  description: string;
  risk_level: RiskLevel;
  arguments_schema: JsonSchema;
}

// ---------------------------------------------------------------------------
// Plugin manifest (top-level shape of manifest.json)
// ---------------------------------------------------------------------------

export interface PluginManifest {
  description: string;
  version: string;
  app_compat: string;
  author: Author;
  provides: {
    channels: string[];
    tools: ToolDeclaration[];
  };
  subscribes: string[];
  /**
   * Optional list of groups this plugin is authorized for.
   * When present, the plugin's tools are only available to sessions
   * belonging to one of the listed groups. When absent, the plugin
   * is unrestricted (available to all groups).
   */
  allowed_groups?: string[];
  /**
   * Session policy controlling how the event dispatcher selects a
   * Claude Code session for this plugin's group.
   *
   * - `"fresh"` (default): Always start a new session.
   * - `"resume"`: Resume the most recent non-expired session, or fresh.
   * - `"explicit"`: Plugin provides a `resolveSession()` handler.
   */
  session?: SessionPolicy;
  config_schema?: {
    type: string;
    required?: string[];
    properties: Record<string, JsonSchemaProperty>;
  };
}
