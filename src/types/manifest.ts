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
  config_schema?: {
    type: string;
    required?: string[];
    properties: Record<string, JsonSchemaProperty>;
  };
}
