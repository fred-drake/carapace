# Project Setup Reference

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

Use `link:` (not `file:`) for `@carapace/core`. `file:` copies the package and
respects `.gitignore`, excluding `dist/`. `link:` symlinks directly so the built
`.d.ts` files are visible for type-checking.

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

Do NOT set `outDir: "."` — TypeScript excludes source files that overlap with
the output directory.

## Skill File (skills/{plugin-name}.md)

Skill files teach Claude (inside the container) how to use the plugin's tools.
They are aggregated by the SkillLoader and mounted into the container.

### Recommended structure

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

## Credential Handling

Plugins read credentials via `services.readCredential(key)` during `initialize()`.
Files live at `$CARAPACE_HOME/credentials/plugins/{pluginName}/{key}`.

- Keys must be simple filenames (no `/`, `..`, or null bytes).
- Files must have `0600` permissions.
- Declare required credentials in `manifest.install.credentials[]` so the
  installer can prompt users.
- Never log or expose credential values.

## Verification Workflow

After creating or modifying a plugin:

1. Type-check the handler: `cd {plugin-dir} && npx tsc --noEmit`
2. Build carapace (if plugin-api changed): `pnpm run build`
3. Type-check carapace: `pnpm run type-check`
4. Run carapace tests: `pnpm test`
5. Symlink into CARAPACE_HOME: `ln -s /path/to/plugin ~/.carapace/plugins/{name}`
6. Start server and verify loading: check logs for `plugin loaded: {name}, tools: [...]`
