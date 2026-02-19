/**
 * Runtime JSON Schema that validates a PluginManifest using ajv.
 *
 * Kept as a plain object (not a TypeScript type) so it can be fed
 * directly to `new Ajv().compile(MANIFEST_JSON_SCHEMA)`.
 */

const jsonSchemaPropertySchema = {
  type: 'object' as const,
  properties: {
    type: { type: 'string' },
    description: { type: 'string' },
    default: {},
    maxLength: { type: 'number' },
    format: { type: 'string' },
    maximum: { type: 'number' },
    minimum: { type: 'number' },
    maxItems: { type: 'number' },
    enum: { type: 'array' },
    items: { $ref: '#/$defs/jsonSchemaProperty' },
  },
  required: ['type'] as string[],
  additionalProperties: false,
};

export const MANIFEST_JSON_SCHEMA = {
  $id: 'https://carapace.dev/schemas/manifest.json',
  type: 'object' as const,
  required: ['description', 'version', 'app_compat', 'author', 'provides', 'subscribes'],
  additionalProperties: false,

  $defs: {
    jsonSchemaProperty: jsonSchemaPropertySchema,

    jsonSchema: {
      type: 'object' as const,
      required: ['type', 'additionalProperties', 'properties'],
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'object' },
        required: {
          type: 'array',
          items: { type: 'string' },
        },
        additionalProperties: { type: 'boolean', const: false },
        properties: {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/jsonSchemaProperty' },
        },
      },
    },

    toolDeclaration: {
      type: 'object' as const,
      required: ['name', 'description', 'risk_level', 'arguments_schema'],
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        risk_level: { type: 'string', enum: ['low', 'high'] },
        arguments_schema: { $ref: '#/$defs/jsonSchema' },
      },
    },

    author: {
      type: 'object' as const,
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        url: { type: 'string' },
      },
    },

    configSchema: {
      type: 'object' as const,
      required: ['type', 'properties'],
      additionalProperties: false,
      properties: {
        type: { type: 'string' },
        required: {
          type: 'array',
          items: { type: 'string' },
        },
        properties: {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/jsonSchemaProperty' },
        },
      },
    },
  },

  properties: {
    description: { type: 'string' },
    version: { type: 'string' },
    app_compat: { type: 'string' },
    author: { $ref: '#/$defs/author' },
    provides: {
      type: 'object',
      required: ['channels', 'tools'],
      additionalProperties: false,
      properties: {
        channels: {
          type: 'array',
          items: { type: 'string' },
        },
        tools: {
          type: 'array',
          items: { $ref: '#/$defs/toolDeclaration' },
        },
      },
    },
    subscribes: {
      type: 'array',
      items: { type: 'string' },
    },
    config_schema: { $ref: '#/$defs/configSchema' },
  },
} as const;
