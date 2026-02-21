import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CoreServicesImpl, ChannelServicesImpl, requestStorage } from './core-services.js';
import { AuditLog } from './audit-log.js';
import { ToolCatalog } from './tool-catalog.js';
import { EventBus } from './event-bus.js';
import type { ChannelServices } from './plugin-handler.js';
import type { EventEnvelope } from '../types/protocol.js';
import { PROTOCOL_VERSION } from '../types/protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carapace-channel-services-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelServicesImpl', () => {
  let tmpDir: string;
  let auditLog: AuditLog;
  let toolCatalog: ToolCatalog;
  let eventBus: EventBus;
  let services: ChannelServicesImpl;
  let publishSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = createTempDir();
    auditLog = new AuditLog(tmpDir);
    toolCatalog = new ToolCatalog();

    // Create a mock EventBus with a spy on publish
    publishSpy = vi.fn(async () => {});
    eventBus = {
      publish: publishSpy,
    } as unknown as EventBus;

    services = new ChannelServicesImpl(auditLog, toolCatalog, eventBus);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Type compatibility
  // -----------------------------------------------------------------------

  it('implements the ChannelServices interface', () => {
    const _svc: ChannelServices = services;
    expect(_svc).toBeDefined();
  });

  it('ChannelServices extends CoreServices (has all CoreServices methods)', () => {
    expect(typeof services.getAuditLog).toBe('function');
    expect(typeof services.getToolCatalog).toBe('function');
    expect(typeof services.getSessionInfo).toBe('function');
    expect(typeof services.publishEvent).toBe('function');
  });

  // -----------------------------------------------------------------------
  // publishEvent constructs valid EventEnvelope
  // -----------------------------------------------------------------------

  describe('publishEvent', () => {
    it('constructs a valid EventEnvelope from partial input', async () => {
      await services.publishEvent({
        topic: 'message.inbound',
        source: 'test-input',
        group: 'test-group',
        payload: { channel: 'test', body: 'hello' },
      });

      expect(publishSpy).toHaveBeenCalledTimes(1);
      const envelope: EventEnvelope = publishSpy.mock.calls[0][0];

      expect(envelope.topic).toBe('message.inbound');
      expect(envelope.source).toBe('test-input');
      expect(envelope.group).toBe('test-group');
      expect(envelope.payload).toEqual({ channel: 'test', body: 'hello' });
      expect(envelope.type).toBe('event');
    });

    it('fills in id as a UUID', async () => {
      await services.publishEvent({
        topic: 'message.inbound',
        source: 'test-input',
        group: 'test-group',
        payload: {},
      });

      const envelope: EventEnvelope = publishSpy.mock.calls[0][0];
      // UUID v4 pattern
      expect(envelope.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('fills in version from PROTOCOL_VERSION', async () => {
      await services.publishEvent({
        topic: 'message.inbound',
        source: 'test-input',
        group: 'test-group',
        payload: {},
      });

      const envelope: EventEnvelope = publishSpy.mock.calls[0][0];
      expect(envelope.version).toBe(PROTOCOL_VERSION);
    });

    it('fills in timestamp as ISO 8601 string', async () => {
      const before = new Date().toISOString();
      await services.publishEvent({
        topic: 'message.inbound',
        source: 'test-input',
        group: 'test-group',
        payload: {},
      });
      const after = new Date().toISOString();

      const envelope: EventEnvelope = publishSpy.mock.calls[0][0];
      expect(envelope.timestamp).toBeDefined();
      expect(envelope.timestamp >= before).toBe(true);
      expect(envelope.timestamp <= after).toBe(true);
    });

    it('sets correlation to null', async () => {
      await services.publishEvent({
        topic: 'message.inbound',
        source: 'test-input',
        group: 'test-group',
        payload: {},
      });

      const envelope: EventEnvelope = publishSpy.mock.calls[0][0];
      expect(envelope.correlation).toBeNull();
    });

    it('generates unique ids for each call', async () => {
      await services.publishEvent({
        topic: 'message.inbound',
        source: 'test-input',
        group: 'test-group',
        payload: {},
      });
      await services.publishEvent({
        topic: 'message.inbound',
        source: 'test-input',
        group: 'test-group',
        payload: {},
      });

      const id1 = publishSpy.mock.calls[0][0].id;
      const id2 = publishSpy.mock.calls[1][0].id;
      expect(id1).not.toBe(id2);
    });
  });
});
