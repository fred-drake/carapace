import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateManifest,
  type ValidateManifestDeps,
  type ValidationResult,
  type ValidationMessage,
} from './validate-manifest.js';
import type { PluginManifest } from './types/manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeps(overrides?: Partial<ValidateManifestDeps>): ValidateManifestDeps {
  return {
    readFile: vi.fn().mockReturnValue(JSON.stringify(validManifest())),
    fileExists: vi.fn().mockReturnValue(true),
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  };
}

function validManifest(): PluginManifest {
  return {
    description: 'Weather plugin',
    version: '1.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Test Author' },
    provides: {
      channels: [],
      tools: [
        {
          name: 'weather.lookup',
          description: 'Look up weather for a city',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            required: ['city'],
            additionalProperties: false,
            properties: {
              city: { type: 'string' },
            },
          },
        },
      ],
    },
    subscribes: [],
  };
}

// ---------------------------------------------------------------------------
// JSON syntax validation
// ---------------------------------------------------------------------------

describe('validateManifest — JSON syntax', () => {
  it('reports invalid JSON', () => {
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue('{ not valid json }'),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('JSON');
  });

  it('reports missing manifest.json', () => {
    const deps = createDeps({
      readFile: vi.fn().mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      }),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('manifest.json');
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('validateManifest — schema validation', () => {
  it('passes a valid manifest', () => {
    const deps = createDeps();

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports missing required fields', () => {
    const manifest = validManifest();
    delete (manifest as unknown as Record<string, unknown>).description;
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(manifest)),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('description'))).toBe(true);
  });

  it('reports extra properties at root level', () => {
    const manifest = { ...validManifest(), badField: true };
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(manifest)),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('badField'))).toBe(true);
  });

  it('reports invalid risk_level', () => {
    const manifest = validManifest();
    (manifest.provides.tools[0] as unknown as Record<string, unknown>).risk_level = 'medium';
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(manifest)),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool name uniqueness
// ---------------------------------------------------------------------------

describe('validateManifest — tool name uniqueness', () => {
  it('reports duplicate tool names', () => {
    const manifest = validManifest();
    manifest.provides.tools.push({
      name: 'weather.lookup',
      description: 'Duplicate tool',
      risk_level: 'low',
      arguments_schema: {
        type: 'object',
        required: [],
        additionalProperties: false,
        properties: {},
      },
    });
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(manifest)),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('Duplicate tool name'))).toBe(true);
    expect(result.errors.some((e) => e.message.includes('weather.lookup'))).toBe(true);
  });

  it('passes with unique tool names', () => {
    const manifest = validManifest();
    manifest.provides.tools.push({
      name: 'weather.forecast',
      description: 'Another tool',
      risk_level: 'low',
      arguments_schema: {
        type: 'object',
        required: [],
        additionalProperties: false,
        properties: {},
      },
    });
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(manifest)),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// additionalProperties: false enforcement
// ---------------------------------------------------------------------------

describe('validateManifest — additionalProperties enforcement', () => {
  it('reports tools missing additionalProperties: false', () => {
    const manifest = validManifest();
    const schema = manifest.provides.tools[0].arguments_schema as unknown as Record<
      string,
      unknown
    >;
    delete schema.additionalProperties;
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(manifest)),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(false);
  });

  it('reports tools with additionalProperties: true', () => {
    const manifest = validManifest();
    (
      manifest.provides.tools[0].arguments_schema as unknown as Record<string, unknown>
    ).additionalProperties = true;
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(manifest)),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Skill file existence
// ---------------------------------------------------------------------------

describe('validateManifest — skill file existence', () => {
  it('reports missing skill file', () => {
    const deps = createDeps({
      fileExists: vi.fn().mockImplementation((path: string) => {
        if (path.includes('skills/')) return false;
        return true;
      }),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('skill'))).toBe(true);
  });

  it('passes when skill file exists', () => {
    const deps = createDeps();

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(true);
  });

  it('checks skill file path based on plugin directory name', () => {
    const deps = createDeps();

    validateManifest('/plugins/weather', deps);

    expect(deps.fileExists).toHaveBeenCalledWith('/plugins/weather/skills/weather.md');
  });
});

// ---------------------------------------------------------------------------
// Risk level warnings
// ---------------------------------------------------------------------------

describe('validateManifest — risk level warnings', () => {
  it('warns on high risk level tools', () => {
    const manifest = validManifest();
    manifest.provides.tools[0].risk_level = 'high';
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(manifest)),
    });

    const result = validateManifest('/plugins/weather', deps);

    // Warnings don't fail validation
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.message.includes('high'))).toBe(true);
  });

  it('does not warn on low risk level tools', () => {
    const deps = createDeps();

    const result = validateManifest('/plugins/weather', deps);

    expect(result.warnings.filter((w) => w.message.includes('risk'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

describe('validateManifest — output', () => {
  it('writes PASS to stdout on valid manifest', () => {
    const deps = createDeps();

    validateManifest('/plugins/weather', deps);

    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('PASS'));
  });

  it('writes FAIL to stderr on invalid manifest', () => {
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue('invalid json!!!'),
    });

    validateManifest('/plugins/weather', deps);

    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('FAIL'));
  });

  it('writes individual errors to stderr', () => {
    const manifest = validManifest();
    delete (manifest as unknown as Record<string, unknown>).description;
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(manifest)),
    });

    validateManifest('/plugins/weather', deps);

    // At least one error line written
    expect((deps.stderr as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it('writes warnings to stdout even when valid', () => {
    const manifest = validManifest();
    manifest.provides.tools[0].risk_level = 'high';
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(manifest)),
    });

    validateManifest('/plugins/weather', deps);

    const allOutput = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('\n');
    expect(allOutput).toContain('WARN');
  });
});

// ---------------------------------------------------------------------------
// Return value structure
// ---------------------------------------------------------------------------

describe('validateManifest — result structure', () => {
  it('returns valid: true with empty errors for a valid manifest', () => {
    const deps = createDeps();

    const result = validateManifest('/plugins/weather', deps);

    expect(result).toEqual(
      expect.objectContaining({
        valid: true,
        errors: [],
      }),
    );
    expect(result.warnings).toBeDefined();
  });

  it('returns valid: false with error messages for an invalid manifest', () => {
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue('bad json'),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toHaveProperty('message');
    expect(result.errors[0]).toHaveProperty('field');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('validateManifest — edge cases', () => {
  it('handles manifest with empty tools array', () => {
    const manifest = validManifest();
    manifest.provides.tools = [];
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(manifest)),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(true);
  });

  it('handles manifest with multiple tools', () => {
    const manifest = validManifest();
    manifest.provides.tools.push({
      name: 'weather.forecast',
      description: 'Get forecast',
      risk_level: 'high',
      arguments_schema: {
        type: 'object',
        required: ['city', 'days'],
        additionalProperties: false,
        properties: {
          city: { type: 'string' },
          days: { type: 'number' },
        },
      },
    });
    const deps = createDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(manifest)),
    });

    const result = validateManifest('/plugins/weather', deps);

    expect(result.valid).toBe(true);
    // Should warn about high-risk tool
    expect(result.warnings.some((w) => w.message.includes('weather.forecast'))).toBe(true);
  });

  it('extracts plugin name from path correctly', () => {
    const deps = createDeps();

    validateManifest('/long/path/to/plugins/my-custom-plugin', deps);

    expect(deps.fileExists).toHaveBeenCalledWith(
      '/long/path/to/plugins/my-custom-plugin/skills/my-custom-plugin.md',
    );
  });

  it('reads manifest.json from the plugin directory', () => {
    const deps = createDeps();

    validateManifest('/plugins/weather', deps);

    expect(deps.readFile).toHaveBeenCalledWith('/plugins/weather/manifest.json');
  });
});
