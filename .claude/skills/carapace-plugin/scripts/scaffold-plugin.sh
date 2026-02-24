#!/usr/bin/env bash
# Scaffold a new Carapace plugin directory with all required files.
# Usage: scaffold-plugin.sh <plugin-name> <output-dir>
#
# Example: scaffold-plugin.sh weather ../carapace-plugins/weather

set -euo pipefail

PLUGIN_NAME="${1:?Usage: scaffold-plugin.sh <plugin-name> <output-dir>}"
OUTPUT_DIR="${2:?Usage: scaffold-plugin.sh <plugin-name> <output-dir>}"

if [[ -d "$OUTPUT_DIR" ]]; then
  echo "Error: Directory '$OUTPUT_DIR' already exists." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR/skills"

# manifest.json
cat > "$OUTPUT_DIR/manifest.json" << MANIFEST
{
  "description": "TODO: describe what this plugin does",
  "version": "1.0.0",
  "app_compat": ">=0.1.0",
  "author": { "name": "fred-drake" },
  "provides": {
    "channels": [],
    "tools": [
      {
        "name": "${PLUGIN_NAME//-/_}_example",
        "description": "TODO: describe this tool",
        "risk_level": "low",
        "arguments_schema": {
          "type": "object",
          "properties": {
            "input": {
              "type": "string",
              "description": "TODO: describe this argument"
            }
          },
          "required": ["input"],
          "additionalProperties": false
        }
      }
    ]
  },
  "subscribes": []
}
MANIFEST

# handler.ts
cat > "$OUTPUT_DIR/handler.ts" << 'HANDLER'
import type {
  PluginHandler,
  CoreServices,
  PluginContext,
  ToolInvocationResult,
} from '@carapace/core/plugin';

let _services: CoreServices;

const handler: PluginHandler = {
  async initialize(services: CoreServices): Promise<void> {
    _services = services;
  },

  async handleToolInvocation(
    tool: string,
    args: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ToolInvocationResult> {
    switch (tool) {
      // TODO: implement tool cases
      default:
        return {
          ok: false,
          error: {
            code: 'HANDLER_ERROR',
            message: `Unknown tool: ${tool}`,
            retriable: false,
          },
        };
    }
  },

  async shutdown(): Promise<void> {},
};

export default handler;
HANDLER

# skills/{name}.md
cat > "$OUTPUT_DIR/skills/${PLUGIN_NAME}.md" << SKILL
# ${PLUGIN_NAME^}

TODO: Brief description of what this plugin provides.

## ${PLUGIN_NAME//-/_}_example

TODO: What this tool does and when to use it.

### Arguments

| Argument | Type   | Required | Description                  |
| -------- | ------ | -------- | ---------------------------- |
| \`input\`  | string | Yes      | TODO: describe this argument |

### Examples

\`\`\`bash
ipc tool.invoke.${PLUGIN_NAME//-/_}_example '{"input": "test"}'
\`\`\`
SKILL

# package.json
cat > "$OUTPUT_DIR/package.json" << PACKAGE
{
  "name": "carapace-plugin-${PLUGIN_NAME}",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "devDependencies": {
    "@carapace/core": "link:../../carapace",
    "typescript": "^5.7.0"
  }
}
PACKAGE

# tsconfig.json
cat > "$OUTPUT_DIR/tsconfig.json" << TSCONFIG
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
TSCONFIG

echo "Plugin scaffolded at: $OUTPUT_DIR"
echo "Files created:"
find "$OUTPUT_DIR" -type f | sort | sed 's|^|  |'
echo ""
echo "Next steps:"
echo "  1. Edit manifest.json — fill in description, tools, schemas"
echo "  2. Edit handler.ts — implement tool logic"
echo "  3. Edit skills/${PLUGIN_NAME}.md — teach Claude how to use the tools"
echo "  4. cd $OUTPUT_DIR && npx tsc --noEmit  (type-check)"
echo "  5. ln -s \$(pwd)/$OUTPUT_DIR ~/.carapace/plugins/${PLUGIN_NAME}"
