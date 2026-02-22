import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import _Ajv from 'ajv';
// ajv ESM interop: default export is the constructor
const Ajv = _Ajv.default ?? _Ajv;
import { MANIFEST_JSON_SCHEMA } from '../../types/manifest-schema.js';
import type { PluginManifest } from '../../types/manifest.js';

const MANIFEST_PATH = join(import.meta.dirname, 'manifest.json');

function loadManifest(): unknown {
  const raw = readFileSync(MANIFEST_PATH, 'utf-8');
  return JSON.parse(raw);
}

function createValidator() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  return ajv.compile(MANIFEST_JSON_SCHEMA);
}

describe('installer manifest.json', () => {
  it('is valid JSON', () => {
    expect(() => loadManifest()).not.toThrow();
  });

  it('validates against MANIFEST_JSON_SCHEMA', () => {
    const validate = createValidator();
    const manifest = loadManifest();
    const valid = validate(manifest);

    if (!valid) {
      const errors = validate.errors
        ?.map((e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message}`)
        .join('; ');
      expect.fail(`Manifest schema validation failed: ${errors}`);
    }

    expect(valid).toBe(true);
  });

  it('declares exactly 6 tools', () => {
    const manifest = loadManifest() as PluginManifest;
    expect(manifest.provides.tools).toHaveLength(6);
  });

  it('declares the expected tool names', () => {
    const manifest = loadManifest() as PluginManifest;
    const names = manifest.provides.tools.map((t) => t.name);
    expect(names).toEqual([
      'plugin_install',
      'plugin_verify',
      'plugin_list',
      'plugin_remove',
      'plugin_update',
      'plugin_configure',
    ]);
  });

  it('has unique tool names', () => {
    const manifest = loadManifest() as PluginManifest;
    const names = manifest.provides.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all tools have additionalProperties: false on their argument schemas', () => {
    const manifest = loadManifest() as PluginManifest;
    for (const tool of manifest.provides.tools) {
      expect(
        tool.arguments_schema.additionalProperties,
        `${tool.name} must have additionalProperties: false`,
      ).toBe(false);
    }
  });

  it('all tools have valid risk_level values', () => {
    const manifest = loadManifest() as PluginManifest;
    for (const tool of manifest.provides.tools) {
      expect(['low', 'high'], `${tool.name} must have a valid risk_level`).toContain(
        tool.risk_level,
      );
    }
  });

  it('high-risk tools are install, remove, and update', () => {
    const manifest = loadManifest() as PluginManifest;
    const highRisk = manifest.provides.tools
      .filter((t) => t.risk_level === 'high')
      .map((t) => t.name);
    expect(highRisk).toEqual(
      expect.arrayContaining(['plugin_install', 'plugin_remove', 'plugin_update']),
    );
    expect(highRisk).toHaveLength(3);
  });

  it('low-risk tools are verify, list, and configure', () => {
    const manifest = loadManifest() as PluginManifest;
    const lowRisk = manifest.provides.tools
      .filter((t) => t.risk_level === 'low')
      .map((t) => t.name);
    expect(lowRisk).toEqual(
      expect.arrayContaining(['plugin_verify', 'plugin_list', 'plugin_configure']),
    );
    expect(lowRisk).toHaveLength(3);
  });

  it('has no channels', () => {
    const manifest = loadManifest() as PluginManifest;
    expect(manifest.provides.channels).toEqual([]);
  });

  it('subscribes to nothing', () => {
    const manifest = loadManifest() as PluginManifest;
    expect(manifest.subscribes).toEqual([]);
  });

  it('has correct metadata', () => {
    const manifest = loadManifest() as PluginManifest;
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.app_compat).toBe('>=0.1.0');
    expect(manifest.author.name).toBe('Carapace Core');
  });
});
