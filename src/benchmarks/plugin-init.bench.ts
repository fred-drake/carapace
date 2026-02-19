/**
 * Plugin initialization time benchmark (QA-11).
 *
 * Measures plugin loading latency: manifest parsing, schema validation,
 * handler import, and initialization. Uses temporary plugin directories
 * with minimal valid manifests and handlers.
 *
 * Target: Plugin init in reasonable time (<500ms per plugin).
 */

import { bench, describe } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginLoader } from '../core/plugin-loader.js';
import { ToolCatalog } from '../core/tool-catalog.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLUGIN_COUNT = 5;

async function createFakePlugin(dir: string, name: string, toolCount: number): Promise<void> {
  const pluginDir = join(dir, name);
  await mkdir(pluginDir, { recursive: true });

  const tools = Array.from({ length: toolCount }, (_, i) => ({
    name: `${name}_tool_${i}`,
    description: `Tool ${i} for ${name}`,
    risk_level: 'low',
    arguments_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string' },
      },
    },
  }));

  const manifest = {
    name,
    version: '1.0.0',
    description: `Benchmark plugin ${name}`,
    app_compat: '>=0.0.1',
    author: { name: 'Benchmark' },
    provides: {
      channels: ['request'],
      tools,
    },
    subscribes: [],
  };

  await writeFile(join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Create a minimal handler module
  const handlerCode = `
export default {
  async initialize() {},
  async handleToolInvocation(tool, args) {
    return { success: true, result: { tool, args } };
  },
  async shutdown() {},
};
`;
  await writeFile(join(pluginDir, 'handler.js'), handlerCode);
}

// ---------------------------------------------------------------------------
// Module-level setup (top-level await — beforeAll doesn't work with bench())
// ---------------------------------------------------------------------------

const pluginsDir = await mkdtemp(join(tmpdir(), 'carapace-bench-plugins-'));
for (let i = 0; i < PLUGIN_COUNT; i++) {
  await createFakePlugin(pluginsDir, `bench_plugin_${i}`, 3);
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('plugin initialization', () => {
  bench(
    'load single plugin (manifest + handler)',
    async () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({
        toolCatalog: catalog,
        userPluginsDir: pluginsDir,
      });
      await loader.loadPlugin(join(pluginsDir, 'bench_plugin_0'));
      await loader.shutdownAll();
    },
    { iterations: 50, time: 5000 },
  );

  bench(
    `load all ${PLUGIN_COUNT} plugins (loadAll)`,
    async () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({
        toolCatalog: catalog,
        userPluginsDir: pluginsDir,
      });
      await loader.loadAll();
      await loader.shutdownAll();
    },
    { iterations: 20, time: 5000 },
  );

  bench(
    'discover plugins (scan directories)',
    async () => {
      const catalog = new ToolCatalog();
      const loader = new PluginLoader({
        toolCatalog: catalog,
        userPluginsDir: pluginsDir,
      });
      await loader.discoverPlugins();
    },
    { iterations: 100, time: 3000 },
  );
});
