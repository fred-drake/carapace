/**
 * Plugin scaffolding for Carapace.
 *
 * Generates a complete plugin skeleton from a template:
 *   - manifest.json with a placeholder tool
 *   - handler.ts implementing PluginHandler
 *   - skills/<name>.md skill file for Claude
 *   - handler.test.ts using the plugin test SDK
 *
 * Used by `carapace plugin create <name>`.
 */

import { join } from 'node:path';
import type { RiskLevel } from './types/manifest.js';

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/** Injectable dependencies for the scaffolder. */
export interface ScaffoldDeps {
  writeFile: (path: string, content: string) => void;
  mkdirp: (path: string) => void;
  exists: (path: string) => boolean;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Options and result
// ---------------------------------------------------------------------------

/** Options for scaffolding a plugin. */
export interface ScaffoldOptions {
  /** Plugin name (kebab-case, no path separators). */
  name: string;
  /** Parent directory where the plugin directory will be created. */
  outputDir: string;
  /** Tool name (defaults to `<name>.example`). */
  toolName?: string;
  /** Tool risk level (defaults to `'low'`). */
  riskLevel?: RiskLevel;
}

/** Result of scaffolding a plugin. */
export interface ScaffoldResult {
  /** Paths of files that were created. */
  files: string[];
  /** Path to the created plugin directory. */
  pluginDir: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Plugin names must be kebab-case: lowercase letters, digits, hyphens. */
const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function isValidPluginName(name: string): boolean {
  return name.length > 0 && PLUGIN_NAME_PATTERN.test(name);
}

// ---------------------------------------------------------------------------
// scaffoldPlugin
// ---------------------------------------------------------------------------

/**
 * Create a complete plugin skeleton in the output directory.
 *
 * Generates manifest.json, handler.ts, skill file, and test file.
 * Returns the list of created file paths.
 */
export function scaffoldPlugin(options: ScaffoldOptions, deps: ScaffoldDeps): ScaffoldResult {
  const { name, outputDir } = options;
  const pluginDir = join(outputDir, name);

  // Validate name
  if (!isValidPluginName(name)) {
    deps.stderr(`Invalid plugin name: "${name}". Use kebab-case (e.g. "my-plugin").`);
    return { files: [], pluginDir };
  }

  // Check for existing directory
  if (deps.exists(pluginDir)) {
    deps.stderr(`Plugin directory already exists: ${pluginDir}`);
    return { files: [], pluginDir };
  }

  const toolName = options.toolName ?? `${name}.example`;
  const riskLevel = options.riskLevel ?? 'low';

  // Create directories
  deps.mkdirp(pluginDir);
  deps.mkdirp(join(pluginDir, 'skills'));

  // Generate and write files
  const files: string[] = [];

  const manifestPath = join(pluginDir, 'manifest.json');
  deps.writeFile(manifestPath, generateManifest(name, toolName, riskLevel));
  files.push(manifestPath);

  const handlerPath = join(pluginDir, 'handler.ts');
  deps.writeFile(handlerPath, generateHandler(name, toolName));
  files.push(handlerPath);

  const skillPath = join(pluginDir, 'skills', `${name}.md`);
  deps.writeFile(skillPath, generateSkillFile(name, toolName));
  files.push(skillPath);

  const testPath = join(pluginDir, 'handler.test.ts');
  deps.writeFile(testPath, generateTestFile(name, toolName));
  files.push(testPath);

  // Report
  deps.stdout(`Created plugin "${name}" at ${pluginDir}`);
  for (const file of files) {
    deps.stdout(`  ${file}`);
  }

  return { files, pluginDir };
}

// ---------------------------------------------------------------------------
// Template generators
// ---------------------------------------------------------------------------

/**
 * Generate a manifest.json for a plugin with one placeholder tool.
 */
export function generateManifest(name: string, toolName: string, riskLevel: RiskLevel): string {
  const manifest = {
    description: `TODO: Describe the ${name} plugin`,
    version: '0.1.0',
    app_compat: '>=0.0.1',
    author: { name: 'TODO: Your Name' },
    provides: {
      channels: ['request'],
      tools: [
        {
          name: toolName,
          description: `TODO: Describe what ${toolName} does`,
          risk_level: riskLevel,
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              input: {
                type: 'string',
                description: 'TODO: Describe this argument',
              },
            },
          },
        },
      ],
    },
    subscribes: [],
  };

  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * Generate a handler.ts implementing PluginHandler.
 */
export function generateHandler(name: string, toolName: string): string {
  const className = toPascalCase(name) + 'Handler';

  return `/**
 * Handler for the ${name} plugin.
 *
 * Implements the PluginHandler interface. Each tool declared in
 * manifest.json has a corresponding case in handleToolInvocation.
 */

import type {
  PluginHandler,
  PluginContext,
  CoreServices,
  ToolInvocationResult,
} from '@carapace/core/plugin-handler.js';

export default class ${className} implements PluginHandler {
  async initialize(_services: CoreServices): Promise<void> {
    // TODO: Initialize plugin (load config, set up connections, etc.)
  }

  async handleToolInvocation(
    tool: string,
    args: Record<string, unknown>,
    _context: PluginContext,
  ): Promise<ToolInvocationResult> {
    switch (tool) {
      case '${toolName}':
        return this.handle${toPascalCase(toolName.split('.').pop() ?? 'tool')}(args);
      default:
        return {
          ok: false,
          error: { code: 'UNKNOWN_TOOL', message: \`Unknown tool: \${tool}\` },
        };
    }
  }

  async shutdown(): Promise<void> {
    // TODO: Clean up resources
  }

  // -------------------------------------------------------------------------
  // Tool implementations
  // -------------------------------------------------------------------------

  private async handle${toPascalCase(toolName.split('.').pop() ?? 'tool')}(
    args: Record<string, unknown>,
  ): Promise<ToolInvocationResult> {
    const input = (args.input as string) ?? '';
    // TODO: Implement tool logic
    return { ok: true, result: { message: \`TODO: implement ${toolName}\`, input } };
  }
}
`;
}

/**
 * Generate a skill markdown file that teaches Claude about the tool.
 */
export function generateSkillFile(name: string, toolName: string): string {
  return `# ${name}

TODO: Brief description of what this plugin does.

## Tools

### ${toolName}

TODO: Describe what this tool does and when to use it.

**Arguments:**
- \`input\` (string): TODO — describe what this argument controls.

**Example usage:**
\`\`\`
Use ${toolName} to [describe the action].
\`\`\`
`;
}

/**
 * Generate a test file using the plugin test SDK.
 */
export function generateTestFile(name: string, toolName: string): string {
  const className = toPascalCase(name) + 'Handler';

  return `import { describe, it, expect, beforeEach } from 'vitest';
import { createTestInvocation, assertSuccessResult } from '@carapace/testing/plugin-test-sdk.js';
import ${className} from './handler.js';

describe('${name}', () => {
  let handler: ${className};

  beforeEach(async () => {
    handler = new ${className}();
  });

  it('handles ${toolName}', async () => {
    const result = await createTestInvocation(
      handler,
      '${toolName}',
      { input: 'test' },
      undefined,
      { autoInit: true },
    );
    const data = assertSuccessResult(result);
    expect(data).toBeDefined();
  });

  it('returns error for unknown tools', async () => {
    const result = await createTestInvocation(
      handler,
      '${name}.nonexistent',
      {},
      undefined,
      { autoInit: true },
    );
    expect(result.ok).toBe(false);
  });
});
`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Convert a kebab-case string to PascalCase. */
function toPascalCase(str: string): string {
  return str
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
