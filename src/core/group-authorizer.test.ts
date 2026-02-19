/**
 * Tests for group-level authorization.
 *
 * The GroupAuthorizer reads allowed_groups from plugin manifests and
 * builds a tool → allowed groups restriction map for pipeline stage 4.
 * Plugins without allowed_groups are unrestricted (all groups allowed).
 */

import { describe, it, expect } from 'vitest';

import { GroupAuthorizer, buildToolGroupRestrictions } from './group-authorizer.js';
import type { PluginManifest } from '../types/manifest.js';
import type { PluginLoadResult } from './plugin-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(
  overrides?: Partial<PluginManifest> & { allowed_groups?: string[] },
): PluginManifest {
  return {
    description: 'Test plugin',
    version: '1.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Test' },
    provides: {
      channels: [],
      tools: [
        {
          name: 'test_tool',
          description: 'A test tool',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
      ],
    },
    subscribes: [],
    ...overrides,
  };
}

function makeSuccessResult(pluginName: string, manifest: PluginManifest): PluginLoadResult {
  return {
    ok: true,
    pluginName,
    manifest,
    handler: {
      initialize: async () => {},
      handleToolInvocation: async () => ({ ok: true, result: {} }),
      shutdown: async () => {},
    },
    source: 'user',
  };
}

function makeFailResult(pluginName: string): PluginLoadResult {
  return {
    ok: false,
    pluginName,
    error: 'Failed to load',
    category: 'init_error',
  };
}

// ---------------------------------------------------------------------------
// buildToolGroupRestrictions
// ---------------------------------------------------------------------------

describe('buildToolGroupRestrictions', () => {
  it('returns empty map when no plugins are loaded', () => {
    const map = buildToolGroupRestrictions([]);
    expect(map.size).toBe(0);
  });

  it('returns empty map when plugins have no allowed_groups', () => {
    const manifest = makeManifest();
    const results = [makeSuccessResult('email', manifest)];
    const map = buildToolGroupRestrictions(results);
    expect(map.size).toBe(0);
  });

  it('maps tool names to allowed groups from plugin manifest', () => {
    const manifest = makeManifest({
      allowed_groups: ['email-group', 'slack-group'],
      provides: {
        channels: [],
        tools: [
          {
            name: 'send_email',
            description: 'Send email',
            risk_level: 'low',
            arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
          },
        ],
      },
    });
    const results = [makeSuccessResult('email', manifest)];
    const map = buildToolGroupRestrictions(results);

    expect(map.has('send_email')).toBe(true);
    expect(map.get('send_email')).toEqual(new Set(['email-group', 'slack-group']));
  });

  it('handles multiple tools from a single plugin', () => {
    const manifest = makeManifest({
      allowed_groups: ['work'],
      provides: {
        channels: [],
        tools: [
          {
            name: 'send_email',
            description: 'Send email',
            risk_level: 'low',
            arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
          },
          {
            name: 'read_email',
            description: 'Read email',
            risk_level: 'low',
            arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
          },
        ],
      },
    });
    const results = [makeSuccessResult('email', manifest)];
    const map = buildToolGroupRestrictions(results);

    expect(map.has('send_email')).toBe(true);
    expect(map.has('read_email')).toBe(true);
    expect(map.get('send_email')).toEqual(new Set(['work']));
    expect(map.get('read_email')).toEqual(new Set(['work']));
  });

  it('handles multiple plugins with different group restrictions', () => {
    const emailManifest = makeManifest({
      allowed_groups: ['work'],
      provides: {
        channels: [],
        tools: [
          {
            name: 'send_email',
            description: 'Send email',
            risk_level: 'low',
            arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
          },
        ],
      },
    });
    const slackManifest = makeManifest({
      allowed_groups: ['personal'],
      provides: {
        channels: [],
        tools: [
          {
            name: 'send_slack',
            description: 'Send Slack',
            risk_level: 'low',
            arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
          },
        ],
      },
    });
    const results = [
      makeSuccessResult('email', emailManifest),
      makeSuccessResult('slack', slackManifest),
    ];
    const map = buildToolGroupRestrictions(results);

    expect(map.get('send_email')).toEqual(new Set(['work']));
    expect(map.get('send_slack')).toEqual(new Set(['personal']));
  });

  it('skips failed plugin results', () => {
    const results = [makeFailResult('broken')];
    const map = buildToolGroupRestrictions(results);
    expect(map.size).toBe(0);
  });

  it('mixes restricted and unrestricted plugins', () => {
    const restrictedManifest = makeManifest({
      allowed_groups: ['work'],
      provides: {
        channels: [],
        tools: [
          {
            name: 'send_email',
            description: 'Send',
            risk_level: 'low',
            arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
          },
        ],
      },
    });
    const unrestrictedManifest = makeManifest({
      provides: {
        channels: [],
        tools: [
          {
            name: 'create_reminder',
            description: 'Create',
            risk_level: 'low',
            arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
          },
        ],
      },
    });
    const results = [
      makeSuccessResult('email', restrictedManifest),
      makeSuccessResult('reminders', unrestrictedManifest),
    ];
    const map = buildToolGroupRestrictions(results);

    expect(map.has('send_email')).toBe(true);
    expect(map.has('create_reminder')).toBe(false); // unrestricted = not in map
  });

  it('handles empty allowed_groups as fully restricted (no groups allowed)', () => {
    const manifest = makeManifest({
      allowed_groups: [],
      provides: {
        channels: [],
        tools: [
          {
            name: 'locked_tool',
            description: 'Locked',
            risk_level: 'low',
            arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
          },
        ],
      },
    });
    const results = [makeSuccessResult('locked', manifest)];
    const map = buildToolGroupRestrictions(results);

    expect(map.has('locked_tool')).toBe(true);
    expect(map.get('locked_tool')!.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GroupAuthorizer class
// ---------------------------------------------------------------------------

describe('GroupAuthorizer', () => {
  describe('isAuthorized', () => {
    it('returns true for unrestricted tools (no allowed_groups)', () => {
      const manifest = makeManifest();
      const results = [makeSuccessResult('email', manifest)];
      const auth = new GroupAuthorizer(results);

      expect(auth.isAuthorized('test_tool', 'any-group')).toBe(true);
    });

    it('returns true when group is in allowed set', () => {
      const manifest = makeManifest({
        allowed_groups: ['work', 'personal'],
        provides: {
          channels: [],
          tools: [
            {
              name: 'send_email',
              description: 'Send',
              risk_level: 'low',
              arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
            },
          ],
        },
      });
      const auth = new GroupAuthorizer([makeSuccessResult('email', manifest)]);

      expect(auth.isAuthorized('send_email', 'work')).toBe(true);
      expect(auth.isAuthorized('send_email', 'personal')).toBe(true);
    });

    it('returns false when group is not in allowed set', () => {
      const manifest = makeManifest({
        allowed_groups: ['work'],
        provides: {
          channels: [],
          tools: [
            {
              name: 'send_email',
              description: 'Send',
              risk_level: 'low',
              arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
            },
          ],
        },
      });
      const auth = new GroupAuthorizer([makeSuccessResult('email', manifest)]);

      expect(auth.isAuthorized('send_email', 'personal')).toBe(false);
    });

    it('returns true for unknown tools (not registered = no restriction)', () => {
      const auth = new GroupAuthorizer([]);
      expect(auth.isAuthorized('unknown_tool', 'any-group')).toBe(true);
    });

    it('returns false for tools with empty allowed_groups', () => {
      const manifest = makeManifest({
        allowed_groups: [],
        provides: {
          channels: [],
          tools: [
            {
              name: 'locked_tool',
              description: 'Locked',
              risk_level: 'low',
              arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
            },
          ],
        },
      });
      const auth = new GroupAuthorizer([makeSuccessResult('locked', manifest)]);

      expect(auth.isAuthorized('locked_tool', 'any-group')).toBe(false);
    });
  });

  describe('getToolGroupRestrictions', () => {
    it('returns the restriction map for stage 4', () => {
      const manifest = makeManifest({
        allowed_groups: ['work'],
        provides: {
          channels: [],
          tools: [
            {
              name: 'send_email',
              description: 'Send',
              risk_level: 'low',
              arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
            },
          ],
        },
      });
      const auth = new GroupAuthorizer([makeSuccessResult('email', manifest)]);
      const map = auth.getToolGroupRestrictions();

      expect(map).toBeInstanceOf(Map);
      expect(map.has('send_email')).toBe(true);
    });
  });

  describe('getPluginGroups', () => {
    it('returns allowed groups for a restricted plugin', () => {
      const manifest = makeManifest({ allowed_groups: ['work', 'personal'] });
      const auth = new GroupAuthorizer([makeSuccessResult('email', manifest)]);

      expect(auth.getPluginGroups('email')).toEqual(['work', 'personal']);
    });

    it('returns null for unrestricted plugins', () => {
      const manifest = makeManifest();
      const auth = new GroupAuthorizer([makeSuccessResult('email', manifest)]);

      expect(auth.getPluginGroups('email')).toBeNull();
    });

    it('returns undefined for unknown plugins', () => {
      const auth = new GroupAuthorizer([]);

      expect(auth.getPluginGroups('unknown')).toBeUndefined();
    });
  });

  describe('describeUnauthorized', () => {
    it('returns descriptive context for unauthorized access', () => {
      const manifest = makeManifest({
        allowed_groups: ['work'],
        provides: {
          channels: [],
          tools: [
            {
              name: 'send_email',
              description: 'Send',
              risk_level: 'low',
              arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
            },
          ],
        },
      });
      const auth = new GroupAuthorizer([makeSuccessResult('email', manifest)]);
      const desc = auth.describeUnauthorized('send_email', 'personal');

      expect(desc).toBeDefined();
      expect(desc!.tool).toBe('send_email');
      expect(desc!.requestedGroup).toBe('personal');
      expect(desc!.allowedGroups).toEqual(['work']);
      expect(desc!.plugin).toBe('email');
    });

    it('returns undefined when access is authorized', () => {
      const manifest = makeManifest({
        allowed_groups: ['work'],
        provides: {
          channels: [],
          tools: [
            {
              name: 'send_email',
              description: 'Send',
              risk_level: 'low',
              arguments_schema: { type: 'object', additionalProperties: false, properties: {} },
            },
          ],
        },
      });
      const auth = new GroupAuthorizer([makeSuccessResult('email', manifest)]);
      const desc = auth.describeUnauthorized('send_email', 'work');

      expect(desc).toBeUndefined();
    });

    it('returns undefined for unrestricted tools', () => {
      const manifest = makeManifest();
      const auth = new GroupAuthorizer([makeSuccessResult('email', manifest)]);
      const desc = auth.describeUnauthorized('test_tool', 'any-group');

      expect(desc).toBeUndefined();
    });
  });
});
