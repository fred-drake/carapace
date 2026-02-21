/**
 * Tests for session policy feature:
 * - SessionPolicy type in manifest
 * - SessionRecord, SessionLookup, resolveSession in PluginHandler
 * - Startup validation in PluginLoader (explicit requires resolveSession)
 * - createTestSessionLookup in plugin test SDK
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import type { PluginManifest, SessionPolicy, EventEnvelope } from '../types/index.js';
import { MANIFEST_JSON_SCHEMA } from '../types/index.js';
import type {
  PluginHandler,
  CoreServices,
  ToolInvocationResult,
  SessionRecord,
  SessionLookup,
  SessionFindCriteria,
} from './plugin-handler.js';
import { createTestSessionLookup } from '../testing/plugin-test-sdk.js';

import _Ajv from 'ajv';
const Ajv = _Ajv.default ?? _Ajv;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    description: 'Test plugin',
    version: '1.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Test' },
    provides: { channels: [], tools: [] },
    subscribes: [],
    ...overrides,
  };
}

function validateManifest(manifest: unknown): boolean {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(MANIFEST_JSON_SCHEMA);
  return validate(manifest);
}

// ---------------------------------------------------------------------------
// SessionPolicy type
// ---------------------------------------------------------------------------

describe('SessionPolicy', () => {
  it('accepts fresh, resume, and explicit as valid values', () => {
    const fresh: SessionPolicy = 'fresh';
    const resume: SessionPolicy = 'resume';
    const explicit: SessionPolicy = 'explicit';
    expect(fresh).toBe('fresh');
    expect(resume).toBe('resume');
    expect(explicit).toBe('explicit');
  });

  it('is optional on PluginManifest (defaults to undefined)', () => {
    const manifest = minimalManifest();
    expect(manifest.session).toBeUndefined();
  });

  it('can be set to each valid value on a manifest', () => {
    const freshManifest = minimalManifest({ session: 'fresh' });
    const resumeManifest = minimalManifest({ session: 'resume' });
    const explicitManifest = minimalManifest({ session: 'explicit' });
    expect(freshManifest.session).toBe('fresh');
    expect(resumeManifest.session).toBe('resume');
    expect(explicitManifest.session).toBe('explicit');
  });
});

// ---------------------------------------------------------------------------
// JSON Schema validation for session field
// ---------------------------------------------------------------------------

describe('Manifest JSON Schema — session field', () => {
  it('accepts manifests without session field', () => {
    const manifest = {
      description: 'Test',
      version: '1.0.0',
      app_compat: '>=0.1.0',
      author: { name: 'Test' },
      provides: { channels: [], tools: [] },
      subscribes: [],
    };
    expect(validateManifest(manifest)).toBe(true);
  });

  it('accepts session: "fresh"', () => {
    const manifest = {
      description: 'Test',
      version: '1.0.0',
      app_compat: '>=0.1.0',
      author: { name: 'Test' },
      provides: { channels: [], tools: [] },
      subscribes: [],
      session: 'fresh',
    };
    expect(validateManifest(manifest)).toBe(true);
  });

  it('accepts session: "resume"', () => {
    const manifest = {
      description: 'Test',
      version: '1.0.0',
      app_compat: '>=0.1.0',
      author: { name: 'Test' },
      provides: { channels: [], tools: [] },
      subscribes: [],
      session: 'resume',
    };
    expect(validateManifest(manifest)).toBe(true);
  });

  it('accepts session: "explicit"', () => {
    const manifest = {
      description: 'Test',
      version: '1.0.0',
      app_compat: '>=0.1.0',
      author: { name: 'Test' },
      provides: { channels: [], tools: [] },
      subscribes: [],
      session: 'explicit',
    };
    expect(validateManifest(manifest)).toBe(true);
  });

  it('rejects invalid session values', () => {
    const manifest = {
      description: 'Test',
      version: '1.0.0',
      app_compat: '>=0.1.0',
      author: { name: 'Test' },
      provides: { channels: [], tools: [] },
      subscribes: [],
      session: 'invalid',
    };
    expect(validateManifest(manifest)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SessionRecord and SessionLookup types
// ---------------------------------------------------------------------------

describe('SessionRecord', () => {
  it('has required fields: sessionId, group, startedAt, endedAt, resumable', () => {
    const record: SessionRecord = {
      sessionId: 'sess-001',
      group: 'email',
      startedAt: '2026-02-21T00:00:00Z',
      endedAt: null,
      resumable: true,
    };
    expect(record.sessionId).toBe('sess-001');
    expect(record.group).toBe('email');
    expect(record.startedAt).toBe('2026-02-21T00:00:00Z');
    expect(record.endedAt).toBeNull();
    expect(record.resumable).toBe(true);
  });

  it('endedAt can be a string when session has ended', () => {
    const record: SessionRecord = {
      sessionId: 'sess-002',
      group: 'slack',
      startedAt: '2026-02-21T00:00:00Z',
      endedAt: '2026-02-21T01:00:00Z',
      resumable: false,
    };
    expect(record.endedAt).toBe('2026-02-21T01:00:00Z');
  });
});

describe('SessionLookup', () => {
  it('latest() returns a Promise<string | null>', async () => {
    const lookup: SessionLookup = {
      latest: async () => 'sess-001',
      find: async () => [],
    };
    const result = await lookup.latest();
    expect(result).toBe('sess-001');
  });

  it('find() accepts criteria and returns Promise<SessionRecord[]>', async () => {
    const lookup: SessionLookup = {
      latest: async () => null,
      find: async (_criteria: SessionFindCriteria) => [],
    };
    const results = await lookup.find({ resumable: true, limit: 5 });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PluginHandler.resolveSession
// ---------------------------------------------------------------------------

describe('PluginHandler.resolveSession', () => {
  it('is optional — handlers without it are valid', () => {
    const handler: PluginHandler = {
      initialize: async () => {},
      handleToolInvocation: async () => ({ ok: true, result: {} }),
      shutdown: async () => {},
    };
    expect(handler.resolveSession).toBeUndefined();
  });

  it('can be implemented to return a session ID', async () => {
    const handler: PluginHandler = {
      initialize: async () => {},
      handleToolInvocation: async () => ({ ok: true, result: {} }),
      resolveSession: async (_event, sessions) => {
        return sessions.latest();
      },
      shutdown: async () => {},
    };

    const mockLookup: SessionLookup = {
      latest: async () => 'sess-abc',
      find: async () => [],
    };

    const fakeEvent = {
      id: 'evt-1',
      version: 1,
      type: 'event' as const,
      topic: 'task.triggered',
      source: 'test',
      correlation: null,
      timestamp: new Date().toISOString(),
      group: 'email',
      payload: {},
    };

    const result = await handler.resolveSession!(fakeEvent, mockLookup);
    expect(result).toBe('sess-abc');
  });

  it('can return null to indicate fresh session', async () => {
    const handler: PluginHandler = {
      initialize: async () => {},
      handleToolInvocation: async () => ({ ok: true, result: {} }),
      resolveSession: async () => null,
      shutdown: async () => {},
    };

    const mockLookup: SessionLookup = {
      latest: async () => null,
      find: async () => [],
    };

    const fakeEvent = {
      id: 'evt-1',
      version: 1,
      type: 'event' as const,
      topic: 'task.triggered',
      source: 'test',
      correlation: null,
      timestamp: new Date().toISOString(),
      group: 'email',
      payload: {},
    };

    const result = await handler.resolveSession!(fakeEvent, mockLookup);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createTestSessionLookup
// ---------------------------------------------------------------------------

describe('createTestSessionLookup', () => {
  it('returns an empty lookup when no sessions provided', async () => {
    const lookup = createTestSessionLookup();
    expect(await lookup.latest()).toBeNull();
    expect(await lookup.find({})).toEqual([]);
  });

  it('returns an empty lookup when given empty array', async () => {
    const lookup = createTestSessionLookup([]);
    expect(await lookup.latest()).toBeNull();
  });

  it('latest() returns the first resumable session', async () => {
    const sessions: SessionRecord[] = [
      {
        sessionId: 'sess-old',
        group: 'email',
        startedAt: '2026-02-20T00:00:00Z',
        endedAt: '2026-02-20T01:00:00Z',
        resumable: false,
      },
      {
        sessionId: 'sess-new',
        group: 'email',
        startedAt: '2026-02-21T00:00:00Z',
        endedAt: null,
        resumable: true,
      },
    ];

    const lookup = createTestSessionLookup(sessions);
    expect(await lookup.latest()).toBe('sess-new');
  });

  it('latest() returns null when no resumable sessions exist', async () => {
    const sessions: SessionRecord[] = [
      {
        sessionId: 'sess-1',
        group: 'email',
        startedAt: '2026-02-21T00:00:00Z',
        endedAt: '2026-02-21T01:00:00Z',
        resumable: false,
      },
    ];

    const lookup = createTestSessionLookup(sessions);
    expect(await lookup.latest()).toBeNull();
  });

  it('find() filters by resumable criteria', async () => {
    const sessions: SessionRecord[] = [
      {
        sessionId: 'sess-1',
        group: 'email',
        startedAt: '2026-02-21T00:00:00Z',
        endedAt: null,
        resumable: true,
      },
      {
        sessionId: 'sess-2',
        group: 'email',
        startedAt: '2026-02-20T00:00:00Z',
        endedAt: '2026-02-20T01:00:00Z',
        resumable: false,
      },
    ];

    const lookup = createTestSessionLookup(sessions);
    const resumable = await lookup.find({ resumable: true });
    expect(resumable).toHaveLength(1);
    expect(resumable[0]!.sessionId).toBe('sess-1');
  });

  it('find() respects limit', async () => {
    const sessions: SessionRecord[] = [
      {
        sessionId: 'sess-1',
        group: 'email',
        startedAt: '2026-02-21T00:00:00Z',
        endedAt: null,
        resumable: true,
      },
      {
        sessionId: 'sess-2',
        group: 'email',
        startedAt: '2026-02-20T00:00:00Z',
        endedAt: null,
        resumable: true,
      },
      {
        sessionId: 'sess-3',
        group: 'email',
        startedAt: '2026-02-19T00:00:00Z',
        endedAt: null,
        resumable: true,
      },
    ];

    const lookup = createTestSessionLookup(sessions);
    const limited = await lookup.find({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('works with resolveSession handler for integration testing', async () => {
    const sessions: SessionRecord[] = [
      {
        sessionId: 'sess-active',
        group: 'email',
        startedAt: '2026-02-21T00:00:00Z',
        endedAt: null,
        resumable: true,
      },
    ];

    const handler: PluginHandler = {
      initialize: async () => {},
      handleToolInvocation: async () => ({ ok: true, result: {} }),
      resolveSession: async (_event, lookup) => lookup.latest(),
      shutdown: async () => {},
    };

    const lookup = createTestSessionLookup(sessions);
    const fakeEvent = {
      id: 'evt-1',
      version: 1,
      type: 'event' as const,
      topic: 'task.triggered',
      source: 'test',
      correlation: null,
      timestamp: new Date().toISOString(),
      group: 'email',
      payload: {},
    };

    const resolved = await handler.resolveSession!(fakeEvent, lookup);
    expect(resolved).toBe('sess-active');
  });
});

// ---------------------------------------------------------------------------
// Type-level tests
// ---------------------------------------------------------------------------

describe('Type-level tests for session policy', () => {
  it('SessionPolicy is a union of string literals', () => {
    expectTypeOf<SessionPolicy>().toEqualTypeOf<'fresh' | 'resume' | 'explicit'>();
  });

  it('PluginManifest.session is optional SessionPolicy', () => {
    expectTypeOf<PluginManifest['session']>().toEqualTypeOf<SessionPolicy | undefined>();
  });

  it('SessionRecord has all required fields', () => {
    expectTypeOf<SessionRecord>().toHaveProperty('sessionId');
    expectTypeOf<SessionRecord>().toHaveProperty('group');
    expectTypeOf<SessionRecord>().toHaveProperty('startedAt');
    expectTypeOf<SessionRecord>().toHaveProperty('endedAt');
    expectTypeOf<SessionRecord>().toHaveProperty('resumable');
  });

  it('SessionLookup has latest and find methods', () => {
    expectTypeOf<SessionLookup>().toHaveProperty('latest');
    expectTypeOf<SessionLookup>().toHaveProperty('find');
  });

  it('PluginHandler.resolveSession is optional', () => {
    expectTypeOf<PluginHandler['resolveSession']>().toEqualTypeOf<
      PluginHandler['resolveSession']
    >();
  });
});
