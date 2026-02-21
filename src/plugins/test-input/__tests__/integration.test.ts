/**
 * Integration tests for the test-input plugin through the full 6-stage pipeline.
 *
 * Uses IntegrationHarness with FakeSocketFactory — no Docker, no real ZeroMQ.
 * Validates that test_respond flows correctly through topic resolution,
 * schema validation, authorization, confirmation, and dispatch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IntegrationHarness } from '../../../testing/integration-harness.js';
import { ErrorCode } from '../../../types/errors.js';

describe('test-input integration (pipeline)', () => {
  let harness: IntegrationHarness;

  beforeEach(async () => {
    harness = await IntegrationHarness.create();
    harness.registerTestInput();
  });

  afterEach(async () => {
    await harness.close();
  });

  // -------------------------------------------------------------------------
  // 1. test_respond passes stage 2 topic resolution
  // -------------------------------------------------------------------------

  it('test_respond passes stage 2 topic resolution', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'test_respond', {
      body: 'hello',
    });

    // If stage 2 failed, we'd get UNKNOWN_TOOL — success or stage 3+ error means stage 2 passed
    expect(response.payload.error?.code).not.toBe(ErrorCode.UNKNOWN_TOOL);
  });

  // -------------------------------------------------------------------------
  // 2. test_respond with valid args passes stage 3 schema validation
  // -------------------------------------------------------------------------

  it('test_respond with valid args passes stage 3 schema validation', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'test_respond', {
      body: 'valid text',
    });

    // If stage 3 failed, we'd get VALIDATION_FAILED
    expect(response.payload.error?.code).not.toBe(ErrorCode.VALIDATION_FAILED);
  });

  // -------------------------------------------------------------------------
  // 3. test_respond returns success through full pipeline (all 6 stages)
  // -------------------------------------------------------------------------

  it('test_respond returns success through full pipeline', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'test_respond', {
      body: 'full pipeline test',
    });

    expect(response.type).toBe('response');
    expect(response.payload.error).toBeNull();
    expect(response.payload.result).toEqual(expect.objectContaining({ captured: true }));
  });

  // -------------------------------------------------------------------------
  // 4. test_respond preserves correlation ID
  // -------------------------------------------------------------------------

  it('test_respond preserves correlation ID', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(
      session,
      'test_respond',
      { body: 'corr test' },
      { correlationId: 'my-corr-456' },
    );

    expect(response.correlation).toBe('my-corr-456');
  });

  // -------------------------------------------------------------------------
  // 5. Response has correct envelope fields
  // -------------------------------------------------------------------------

  it('response has correct envelope fields (group, source, version, type)', async () => {
    const session = harness.createSession({ group: 'email' });
    const response = await harness.sendRequest(session, 'test_respond', {
      body: 'envelope test',
    });

    expect(response.group).toBe('email');
    expect(response.version).toBe(1);
    expect(response.type).toBe('response');
    expect(response.topic).toBe('tool.invoke.test_respond');
  });

  // -------------------------------------------------------------------------
  // 6. Missing body field → VALIDATION_FAILED at stage 3
  // -------------------------------------------------------------------------

  it('missing body field produces VALIDATION_FAILED', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'test_respond', {});

    expect(response.payload.error).not.toBeNull();
    expect(response.payload.error!.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  // -------------------------------------------------------------------------
  // 7. Extra fields → VALIDATION_FAILED (additionalProperties: false)
  // -------------------------------------------------------------------------

  it('extra fields produce VALIDATION_FAILED', async () => {
    const session = harness.createSession({ group: 'test' });
    const response = await harness.sendRequest(session, 'test_respond', {
      body: 'hello',
      extra: 'not-allowed',
    });

    expect(response.payload.error).not.toBeNull();
    expect(response.payload.error!.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  // -------------------------------------------------------------------------
  // 8. Multiple sequential submissions recorded independently
  // -------------------------------------------------------------------------

  it('multiple sequential submissions are recorded independently', async () => {
    const session = harness.createSession({ group: 'test' });

    const r1 = await harness.sendRequest(session, 'test_respond', {
      body: 'first',
    });
    const r2 = await harness.sendRequest(session, 'test_respond', {
      body: 'second',
    });
    const r3 = await harness.sendRequest(session, 'test_respond', {
      body: 'third',
    });

    expect(r1.payload.error).toBeNull();
    expect(r2.payload.error).toBeNull();
    expect(r3.payload.error).toBeNull();

    // Each has a distinct correlation ID
    expect(r1.correlation).not.toBe(r2.correlation);
    expect(r2.correlation).not.toBe(r3.correlation);

    // All returned captured: true
    expect(r1.payload.result).toEqual(expect.objectContaining({ captured: true }));
    expect(r2.payload.result).toEqual(expect.objectContaining({ captured: true }));
    expect(r3.payload.result).toEqual(expect.objectContaining({ captured: true }));
  });

  // -------------------------------------------------------------------------
  // 9. Concurrent sessions with different prompts stay isolated
  // -------------------------------------------------------------------------

  it('concurrent sessions with different groups stay isolated', async () => {
    const s1 = harness.createSession({ group: 'email' });
    const s2 = harness.createSession({ group: 'slack' });

    const r1 = await harness.sendRequest(s1, 'test_respond', {
      body: 'email response',
    });
    const r2 = await harness.sendRequest(s2, 'test_respond', {
      body: 'slack response',
    });

    expect(r1.payload.error).toBeNull();
    expect(r2.payload.error).toBeNull();

    // Envelope group is scoped per session
    expect(r1.group).toBe('email');
    expect(r2.group).toBe('slack');
  });
});
