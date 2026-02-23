# Carapace Plugin Development

Use this skill when building, modifying, or reviewing Carapace plugins.

## Architecture

Plugins live in a separate repo (`carapace-plugins/`) and are symlinked into
`$CARAPACE_HOME/plugins/` for runtime discovery. Each plugin is a pair:

- **Host-side handler** (`handler.ts`) — TypeScript, holds credentials, executes
  tool logic. Runs on the host with full trust.
- **Container-side skill** (`skills/{name}.md`) — Markdown teaching Claude the
  available tools. Injected into the read-only container.

The plugin loader scans `$CARAPACE_HOME/plugins/` for directories containing
`manifest.json`, validates the manifest against a JSON Schema, dynamically
imports `handler.js` (preferred) or `handler.ts`, and calls `initialize()` with
a 10-second timeout.

## Plugin Directory Layout

```
{plugin-name}/
  manifest.json           # Required: declares tools, channels, config
  handler.ts              # Required: host-side PluginHandler implementation
  skills/
    {plugin-name}.md      # Recommended: teaches Claude about the tools
  package.json            # devDependencies: @carapace/core via link:
  tsconfig.json           # ES2022 / NodeNext / strict
```

## manifest.json

Every field below marked (R) is required by the JSON Schema validator.

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

### Manifest Rules

- `additionalProperties: false` is enforced at every schema level.
- Tool names must be globally unique across all loaded plugins.
- Reserved intrinsic names that cannot be used: `get_diagnostics`,
  `list_tools`, `get_session_info`.
- Reserved plugin names (in `main.ts`): `installer`, `memory`,
  `test-input`, `hello`.
- `risk_level: "low"` auto-executes; `"high"` requires user confirmation.
- If `session: "explicit"`, the handler MUST implement `resolveSession()`.
- Schema properties support: `type`, `description`, `default`, `maxLength`,
  `format`, `maximum`, `minimum`, `enum`, `items`, `maxItems`.

## handler.ts

Import types from the `@carapace/core/plugin` subpath export:

```typescript
import type {
  PluginHandler,
  CoreServices,
  PluginContext,
  ToolInvocationResult,
} from '@carapace/core/plugin';
```

### Required Interface

```typescript
interface PluginHandler {
  initialize(services: CoreServices): Promise<void>;
  handleToolInvocation(
    tool: string,
    args: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ToolInvocationResult>;
  shutdown(): Promise<void>;

  // Optional:
  handleEvent?(envelope: EventEnvelope): Promise<void>;
  resolveSession?(event: EventEnvelope, sessions: SessionLookup): Promise<string | null>;
  verify?(): Promise<PluginVerifyResult>; // max 10 seconds, non-destructive
}
```

### Export Pattern

Use default export (preferred):

```typescript
const handler: PluginHandler = { ... };
export default handler;
```

Named export also accepted: `export { handler };`

### ToolInvocationResult

Discriminated union — must use `as const` on the `ok` field:

```typescript
// Success
return { ok: true as const, result: { greeting: `Hello, ${name}!` } };

// Error
return {
  ok: false,
  error: {
    code: 'HANDLER_ERROR', // or ErrorCode.HANDLER_ERROR
    message: 'What went wrong',
    retriable: false,
    // field?: 'argName',       // which argument caused the error
    // retry_after?: 30,        // seconds to wait
  },
};
```

### CoreServices Available in initialize()

```typescript
interface CoreServices {
  getAuditLog(filters: AuditLogFilter): Promise<AuditLogEntry[]>;
  getToolCatalog(): ToolDeclaration[];
  getSessionInfo(): SessionInfo; // scoped to current group
  readCredential(key: string): string; // reads $CARAPACE_HOME/credentials/plugins/{pluginName}/{key}
}
```

Channel plugins (those with `provides.channels.length > 0`) receive
`ChannelServices` which adds `publishEvent()`.

### PluginContext (per-invocation)

```typescript
interface PluginContext {
  group: string;
  sessionId: string;
  correlationId: string;
  timestamp: string; // ISO 8601
}
```

### Structured Errors (ToolError)

For richer error handling, throw `ToolError` instead of returning error objects:

```typescript
import { ToolError, ErrorCode } from '@carapace/core/plugin';

throw new ToolError({
  code: ErrorCode.HANDLER_ERROR,
  message: 'API rate limit exceeded',
  retriable: true,
  retry_after: 60,
});
```

The core catches `ToolError` and converts it to a structured response. Any
other thrown error becomes a generic `PLUGIN_ERROR` with no internals leaked.

Reserved pipeline codes (`UNKNOWN_TOOL`, `VALIDATION_FAILED`, `UNAUTHORIZED`,
`RATE_LIMITED`, `CONFIRMATION_TIMEOUT`, `CONFIRMATION_DENIED`) are normalized
to `HANDLER_ERROR` if thrown by a handler.

### Handler Pattern for Multi-Tool Plugins

```typescript
async handleToolInvocation(tool, args, context) {
  switch (tool) {
    case 'my_search': return this.handleSearch(args, context);
    case 'my_create': return this.handleCreate(args, context);
    default:
      return {
        ok: false,
        error: { code: 'HANDLER_ERROR', message: `Unknown tool: ${tool}`, retriable: false },
      };
  }
}
```

## skills/{plugin-name}.md

Skill files teach Claude (inside the container) how to use the plugin's tools.
They are aggregated by the SkillLoader and mounted into the container.

### Recommended Structure

```markdown
# {Plugin Name}

Brief description. Security warnings if applicable.

## {tool_name}

What this tool does and when to use it.

### Arguments

| Argument | Type   | Required | Description           |
| -------- | ------ | -------- | --------------------- |
| `arg1`   | string | Yes      | What this argument is |

### Examples

\`\`\`bash
ipc tool.invoke.{tool_name} '{"arg1": "value"}'
\`\`\`

### Notes

- Risk level, edge cases, security considerations
```

Tools are invoked from the container via the `ipc` binary over ZeroMQ.

## package.json

```json
{
  "name": "carapace-plugin-{name}",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "devDependencies": {
    "@carapace/core": "link:../../carapace",
    "typescript": "^5.7.0"
  }
}
```

Use `link:` (not `file:`) for the `@carapace/core` dependency. `file:` copies
the package and respects `.gitignore`, excluding `dist/`. `link:` symlinks
directly so the built `.d.ts` files are visible for type-checking.

## tsconfig.json

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["handler.ts"]
}
```

Do NOT set `outDir: "."` — TypeScript excludes source files that overlap
with the output directory.

## Credential Handling

Plugins read credentials via `services.readCredential(key)` during
`initialize()`. Files live at `$CARAPACE_HOME/credentials/plugins/{pluginName}/{key}`.

- Keys must be simple filenames (no `/`, `..`, or null bytes).
- Files must have `0600` permissions.
- Declare required credentials in `manifest.install.credentials[]` so the
  installer can prompt users.
- Never log or expose credential values.

## Verification Workflow

After creating or modifying a plugin:

1. **Type-check the handler**: `cd {plugin-dir} && npx tsc --noEmit`
2. **Build carapace** (if plugin-api changed): `pnpm run build`
3. **Type-check carapace**: `pnpm run type-check`
4. **Run carapace tests**: `pnpm test`
5. **Test handler directly** (bypasses container/auth):

```typescript
node --input-type=module -e '
import handler from "./{plugin-dir}/handler.ts";
await handler.initialize({ /* mock CoreServices */ });
const result = await handler.handleToolInvocation("tool_name", { arg: "val" }, {
  group: "test", sessionId: "test", correlationId: "test",
  timestamp: new Date().toISOString(),
});
console.log(JSON.stringify(result, null, 2));
await handler.shutdown();
'
```

6. **Symlink into CARAPACE_HOME**: `ln -s /path/to/plugin ~/.carapace/plugins/{name}`
7. **Start server and verify loading**: Check logs for
   `plugin loaded: {name}, tools: [...]`

## Common Mistakes

- Using `file:` instead of `link:` in package.json (breaks type resolution).
- Setting `outDir: "."` in tsconfig (TypeScript excludes its own inputs).
- Forgetting `additionalProperties: false` in argument schemas (validation fails).
- Using a reserved tool or plugin name.
- Missing `subscribes: []` in manifest (required even if empty).
- Missing `provides.channels: []` (required even for tool-only plugins).
- Returning `{ ok: true }` without `as const` — breaks discriminated union
  type narrowing.
- Using `export default { ... } satisfies PluginHandler` without the type
  annotation — inferred types may not match.

## Reference Plugin: hello-world

Located at `../carapace-plugins/hello-world/`. Demonstrates:

- Minimal manifest with one low-risk tool
- Default export handler pattern
- Argument validation with fallback defaults
- Proper error response for unknown tools
- Skill file with argument table and examples
