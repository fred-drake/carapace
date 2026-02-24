# Manifest Schema Reference

## manifest.json

Every field marked (R) is required by the JSON Schema validator.

```jsonc
{
  "description": "What this plugin does",                    // (R) string
  "version": "1.0.0",                                       // (R) semver
  "app_compat": ">=0.1.0",                                  // (R) semver range
  "author": { "name": "fred-drake" },                       // (R) .name required
  "provides": {                                              // (R)
    "channels": [],                                          // (R) string[] (empty for tool-only)
    "tools": [                                               // (R)
      {
        "name": "my_tool",                                   // (R) snake_case
        "description": "What it does",                       // (R)
        "risk_level": "low",                                 // (R) "low" | "high"
        "arguments_schema": {                                // (R)
          "type": "object",                                  // (R) must be "object"
          "properties": { ... },                             // (R) JsonSchemaProperty map
          "additionalProperties": false                      // (R) MUST be false
          // "required": ["field"]                           // optional string[]
        }
      }
    ]
  },
  "subscribes": [],                                          // (R) event topics
  // Optional fields:
  // "allowed_groups": ["email"],      // restrict to specific groups
  // "session": "fresh",               // "fresh" | "resume" | "explicit"
  // "install": { "credentials": [...] }
  // "config_schema": { ... }
}
```

## Rules

- `additionalProperties: false` is enforced at every schema level.
- Tool names must be globally unique across all loaded plugins.
- Reserved intrinsic names: `get_diagnostics`, `list_tools`, `get_session_info`.
- Reserved plugin names (in `main.ts`): `installer`, `memory`, `test-input`, `hello`.
- `risk_level: "low"` auto-executes; `"high"` requires user confirmation.
- If `session: "explicit"`, the handler MUST implement `resolveSession()`.
- Schema properties support: `type`, `description`, `default`, `maxLength`,
  `format`, `maximum`, `minimum`, `enum`, `items`, `maxItems`.
