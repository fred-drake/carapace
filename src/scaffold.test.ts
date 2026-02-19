import { describe, it, expect, vi } from 'vitest';
import {
  scaffoldPlugin,
  generateManifest,
  generateHandler,
  generateSkillFile,
  generateTestFile,
} from './scaffold.js';
import type { ScaffoldDeps } from './scaffold.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDeps(overrides?: Partial<ScaffoldDeps>): ScaffoldDeps {
  return {
    writeFile: vi.fn(),
    mkdirp: vi.fn(),
    exists: vi.fn().mockReturnValue(false),
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateManifest
// ---------------------------------------------------------------------------

describe('generateManifest', () => {
  it('produces valid JSON', () => {
    const json = generateManifest('my-plugin', 'my-plugin.example', 'low');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('includes the plugin description placeholder', () => {
    const parsed = JSON.parse(generateManifest('my-plugin', 'my-plugin.example', 'low'));
    expect(parsed.description).toContain('my-plugin');
  });

  it('declares the tool with correct name and risk level', () => {
    const parsed = JSON.parse(generateManifest('weather', 'weather.lookup', 'high'));
    const tool = parsed.provides.tools[0];
    expect(tool.name).toBe('weather.lookup');
    expect(tool.risk_level).toBe('high');
  });

  it('sets additionalProperties false on argument schema', () => {
    const parsed = JSON.parse(generateManifest('x', 'x.do', 'low'));
    expect(parsed.provides.tools[0].arguments_schema.additionalProperties).toBe(false);
  });

  it('includes version and app_compat', () => {
    const parsed = JSON.parse(generateManifest('x', 'x.do', 'low'));
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.app_compat).toBeDefined();
  });

  it('includes author placeholder', () => {
    const parsed = JSON.parse(generateManifest('x', 'x.do', 'low'));
    expect(parsed.author.name).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// generateHandler
// ---------------------------------------------------------------------------

describe('generateHandler', () => {
  it('implements PluginHandler interface', () => {
    const code = generateHandler('my-plugin', 'my-plugin.example');
    expect(code).toContain('PluginHandler');
    expect(code).toContain('initialize');
    expect(code).toContain('handleToolInvocation');
    expect(code).toContain('shutdown');
  });

  it('includes a switch case for the tool name', () => {
    const code = generateHandler('weather', 'weather.lookup');
    expect(code).toContain("'weather.lookup'");
  });

  it('handles unknown tools with error response', () => {
    const code = generateHandler('x', 'x.do');
    expect(code).toContain('UNKNOWN_TOOL');
  });

  it('uses class default export', () => {
    const code = generateHandler('my-plugin', 'my-plugin.do');
    expect(code).toContain('export default class');
  });
});

// ---------------------------------------------------------------------------
// generateSkillFile
// ---------------------------------------------------------------------------

describe('generateSkillFile', () => {
  it('includes the plugin name as heading', () => {
    const md = generateSkillFile('weather', 'weather.lookup');
    expect(md).toContain('# weather');
  });

  it('documents the tool', () => {
    const md = generateSkillFile('weather', 'weather.lookup');
    expect(md).toContain('weather.lookup');
  });

  it('includes argument documentation placeholder', () => {
    const md = generateSkillFile('x', 'x.do');
    expect(md).toContain('Arguments');
  });
});

// ---------------------------------------------------------------------------
// generateTestFile
// ---------------------------------------------------------------------------

describe('generateTestFile', () => {
  it('imports from the plugin test SDK', () => {
    const code = generateTestFile('my-plugin', 'my-plugin.example');
    expect(code).toContain('createTestInvocation');
  });

  it('imports the handler', () => {
    const code = generateTestFile('my-plugin', 'my-plugin.example');
    expect(code).toContain('./handler.js');
  });

  it('includes a test for the tool', () => {
    const code = generateTestFile('weather', 'weather.lookup');
    expect(code).toContain('weather.lookup');
  });

  it('uses describe/it/expect from vitest', () => {
    const code = generateTestFile('x', 'x.do');
    expect(code).toContain('describe');
    expect(code).toContain('expect');
  });
});

// ---------------------------------------------------------------------------
// scaffoldPlugin — full flow
// ---------------------------------------------------------------------------

describe('scaffoldPlugin', () => {
  it('creates the plugin directory', () => {
    const deps = createTestDeps();
    scaffoldPlugin({ name: 'my-plugin', outputDir: '/plugins' }, deps);

    expect(deps.mkdirp).toHaveBeenCalledWith('/plugins/my-plugin');
  });

  it('creates the skills subdirectory', () => {
    const deps = createTestDeps();
    scaffoldPlugin({ name: 'my-plugin', outputDir: '/plugins' }, deps);

    expect(deps.mkdirp).toHaveBeenCalledWith('/plugins/my-plugin/skills');
  });

  it('writes manifest.json', () => {
    const deps = createTestDeps();
    scaffoldPlugin({ name: 'my-plugin', outputDir: '/plugins' }, deps);

    expect(deps.writeFile).toHaveBeenCalledWith(
      '/plugins/my-plugin/manifest.json',
      expect.stringContaining('"my-plugin.example"'),
    );
  });

  it('writes handler.ts', () => {
    const deps = createTestDeps();
    scaffoldPlugin({ name: 'my-plugin', outputDir: '/plugins' }, deps);

    expect(deps.writeFile).toHaveBeenCalledWith(
      '/plugins/my-plugin/handler.ts',
      expect.stringContaining('PluginHandler'),
    );
  });

  it('writes skill file', () => {
    const deps = createTestDeps();
    scaffoldPlugin({ name: 'my-plugin', outputDir: '/plugins' }, deps);

    expect(deps.writeFile).toHaveBeenCalledWith(
      '/plugins/my-plugin/skills/my-plugin.md',
      expect.stringContaining('# my-plugin'),
    );
  });

  it('writes test file', () => {
    const deps = createTestDeps();
    scaffoldPlugin({ name: 'my-plugin', outputDir: '/plugins' }, deps);

    expect(deps.writeFile).toHaveBeenCalledWith(
      '/plugins/my-plugin/handler.test.ts',
      expect.stringContaining('createTestInvocation'),
    );
  });

  it('returns the list of created files', () => {
    const deps = createTestDeps();
    const result = scaffoldPlugin({ name: 'weather', outputDir: '/p' }, deps);

    expect(result.files).toHaveLength(4);
    expect(result.pluginDir).toBe('/p/weather');
  });

  it('reports created files to stdout', () => {
    const deps = createTestDeps();
    scaffoldPlugin({ name: 'my-plugin', outputDir: '/plugins' }, deps);

    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('manifest.json'));
  });

  it('uses custom tool name when provided', () => {
    const deps = createTestDeps();
    scaffoldPlugin({ name: 'weather', outputDir: '/p', toolName: 'weather.forecast' }, deps);

    expect(deps.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('manifest.json'),
      expect.stringContaining('weather.forecast'),
    );
  });

  it('uses custom risk level when provided', () => {
    const deps = createTestDeps();
    scaffoldPlugin({ name: 'bank', outputDir: '/p', riskLevel: 'high' }, deps);

    expect(deps.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('manifest.json'),
      expect.stringContaining('"high"'),
    );
  });

  // -----------------------------------------------------------------------
  // Error paths
  // -----------------------------------------------------------------------

  it('fails when plugin directory already exists', () => {
    const deps = createTestDeps({ exists: vi.fn().mockReturnValue(true) });
    const result = scaffoldPlugin({ name: 'my-plugin', outputDir: '/plugins' }, deps);

    expect(result.files).toHaveLength(0);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('already exists'));
  });

  it('validates plugin name has no path separators', () => {
    const deps = createTestDeps();
    const result = scaffoldPlugin({ name: '../evil', outputDir: '/plugins' }, deps);

    expect(result.files).toHaveLength(0);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Invalid plugin name'));
  });

  it('validates plugin name is not empty', () => {
    const deps = createTestDeps();
    const result = scaffoldPlugin({ name: '', outputDir: '/plugins' }, deps);

    expect(result.files).toHaveLength(0);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Invalid plugin name'));
  });

  it('validates plugin name matches allowed pattern', () => {
    const deps = createTestDeps();
    const result = scaffoldPlugin({ name: 'My Plugin!', outputDir: '/p' }, deps);

    expect(result.files).toHaveLength(0);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Invalid plugin name'));
  });
});
