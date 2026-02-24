---
name: Carapace Plugin Development
description: >
  Build, modify, or review Carapace plugins. Use when creating new plugins,
  implementing tool handlers, writing manifest.json files, creating container-side
  skill files, or debugging plugin loading issues. Covers the full plugin
  lifecycle: scaffold, implement handler, define manifest schema, write skill
  markdown, verify, and symlink for runtime discovery.
---

# Carapace Plugin Development

## Architecture

Each plugin is a pair spanning the trust boundary:

- **Host-side handler** (`handler.ts`) — TypeScript, holds credentials, executes
  tool logic. Runs on the host with full trust.
- **Container-side skill** (`skills/{name}.md`) — Markdown teaching Claude the
  available tools. Injected into the read-only container.

Plugins live in a separate repo (`carapace-plugins/`) and are symlinked into
`$CARAPACE_HOME/plugins/` for runtime discovery. The plugin loader scans for
directories containing `manifest.json`, validates against a JSON Schema,
dynamically imports `handler.js` (preferred) or `handler.ts`, and calls
`initialize()` with a 10-second timeout.

## Plugin Directory Layout

```
{plugin-name}/
  manifest.json           # Declares tools, channels, config
  handler.ts              # Host-side PluginHandler implementation
  skills/
    {plugin-name}.md      # Teaches Claude about the tools
  package.json            # @carapace/core via link:
  tsconfig.json           # ES2022 / NodeNext / strict
```

## Workflow

1. **Scaffold** — Run `scripts/scaffold-plugin.sh <name> <output-dir>` to
   generate all boilerplate files with TODO placeholders
2. **Define manifest** — Fill in tools, schemas, risk levels.
   See [references/manifest-schema.md](references/manifest-schema.md)
3. **Implement handler** — Write tool logic using the PluginHandler interface.
   See [references/handler-api.md](references/handler-api.md)
4. **Write skill file** — Teach Claude how to invoke the tools from the container
5. **Configure project** — Set up package.json and tsconfig.json.
   See [references/project-setup.md](references/project-setup.md)
6. **Verify** — Type-check, test, symlink, and confirm loading in server logs

## Critical Rules

- `additionalProperties: false` is enforced at every manifest schema level
- Tool names must be globally unique across all loaded plugins
- MUST use `as const` on the `ok` field in `ToolInvocationResult` (discriminated union)
- Use `link:` (not `file:`) for `@carapace/core` in package.json
- Do NOT set `outDir: "."` in tsconfig (TypeScript excludes its own inputs)
- Never log or expose credential values
- Import types from `@carapace/core/plugin` subpath export

## Common Mistakes

- Using `file:` instead of `link:` in package.json (breaks type resolution)
- Forgetting `additionalProperties: false` in argument schemas (validation fails)
- Using a reserved tool name (`get_diagnostics`, `list_tools`, `get_session_info`)
  or reserved plugin name (`installer`, `memory`, `test-input`, `hello`)
- Missing `subscribes: []` in manifest (required even if empty)
- Missing `provides.channels: []` (required even for tool-only plugins)
- Returning `{ ok: true }` without `as const` — breaks discriminated union type narrowing
- Using `export default { ... } satisfies PluginHandler` without the type annotation

## Reference Plugin

`../carapace-plugins/hello-world/` demonstrates a minimal working plugin with
one low-risk tool, default export handler, argument validation, and a skill file.
