import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { IpcTestHarness } from './ipc-test-harness.js';
import { createResponseEnvelope, createWireMessage } from './factories.js';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('IpcTestHarness', () => {
  let harness: IpcTestHarness;

  beforeEach(async () => {
    harness = await IpcTestHarness.create();
  });

  afterEach(async () => {
    await harness.close();
  });

  // -------------------------------------------------------------------------
  // programResponse
  // -------------------------------------------------------------------------

  describe('programResponse', () => {
    it('stores a response for a given correlation ID', () => {
      const response = createResponseEnvelope({ correlation: 'corr-100' });
      harness.programResponse('corr-100', response);

      expect(harness.hasProgrammedOutcome('corr-100')).toBe(true);
    });

    it('overwrites a previous response for the same correlation ID', () => {
      const response1 = createResponseEnvelope({
        correlation: 'corr-200',
        payload: { result: { first: true }, error: null },
      });
      const response2 = createResponseEnvelope({
        correlation: 'corr-200',
        payload: { result: { second: true }, error: null },
      });

      harness.programResponse('corr-200', response1);
      harness.programResponse('corr-200', response2);

      // Only the second should remain (one entry per correlation ID).
      expect(harness.hasProgrammedOutcome('corr-200')).toBe(true);
    });

    it('sends the programmed response when a matching wire message arrives', async () => {
      const response = createResponseEnvelope({ correlation: 'corr-300' });
      harness.programResponse('corr-300', response);

      const dealer = harness.getDealer();
      const receivedPayloads: string[] = [];
      dealer.on('message', (payload) => {
        receivedPayloads.push(payload.toString());
      });

      // Simulate the IPC binary sending a wire message through the dealer.
      const wireMsg = createWireMessage({ correlation: 'corr-300' });
      await dealer.send(Buffer.from(JSON.stringify(wireMsg)));

      expect(receivedPayloads).toHaveLength(1);
      const parsed = JSON.parse(receivedPayloads[0]);
      expect(parsed.correlation).toBe('corr-300');
      expect(parsed.type).toBe('response');
    });

    it('consumes the programmed response after delivery', async () => {
      const response = createResponseEnvelope({ correlation: 'corr-400' });
      harness.programResponse('corr-400', response);

      const dealer = harness.getDealer();
      const wireMsg = createWireMessage({ correlation: 'corr-400' });
      await dealer.send(Buffer.from(JSON.stringify(wireMsg)));

      // The programmed outcome should be consumed.
      expect(harness.hasProgrammedOutcome('corr-400')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // programTimeout
  // -------------------------------------------------------------------------

  describe('programTimeout', () => {
    it('marks a correlation ID as a timeout', () => {
      harness.programTimeout('corr-timeout');

      expect(harness.hasProgrammedOutcome('corr-timeout')).toBe(true);
    });

    it('does not send a response when a matching wire message arrives', async () => {
      harness.programTimeout('corr-timeout-2');

      const dealer = harness.getDealer();
      const receivedPayloads: string[] = [];
      dealer.on('message', (payload) => {
        receivedPayloads.push(payload.toString());
      });

      const wireMsg = createWireMessage({ correlation: 'corr-timeout-2' });
      await dealer.send(Buffer.from(JSON.stringify(wireMsg)));

      // No response should be sent back.
      expect(receivedPayloads).toHaveLength(0);
    });

    it('consumes the programmed timeout after the wire message arrives', async () => {
      harness.programTimeout('corr-timeout-3');

      const dealer = harness.getDealer();
      const wireMsg = createWireMessage({ correlation: 'corr-timeout-3' });
      await dealer.send(Buffer.from(JSON.stringify(wireMsg)));

      expect(harness.hasProgrammedOutcome('corr-timeout-3')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getSentMessages
  // -------------------------------------------------------------------------

  describe('getSentMessages', () => {
    it('returns an empty array initially', () => {
      expect(harness.getSentMessages()).toEqual([]);
    });

    it('records wire messages sent through the dealer', async () => {
      const dealer = harness.getDealer();
      const wireMsg = createWireMessage({
        topic: 'tool.invoke.my_tool',
        correlation: 'corr-sent-1',
        arguments: { key: 'value' },
      });
      await dealer.send(Buffer.from(JSON.stringify(wireMsg)));

      const sent = harness.getSentMessages();
      expect(sent).toHaveLength(1);
      expect(sent[0].topic).toBe('tool.invoke.my_tool');
      expect(sent[0].correlation).toBe('corr-sent-1');
      // deepMerge merges overrides into defaults, so 'input' from the
      // default factory is preserved alongside the override 'key'.
      expect(sent[0].arguments).toEqual({ input: 'test', key: 'value' });
    });

    it('records multiple wire messages in order', async () => {
      const dealer = harness.getDealer();
      const msg1 = createWireMessage({ correlation: 'first' });
      const msg2 = createWireMessage({ correlation: 'second' });
      const msg3 = createWireMessage({ correlation: 'third' });

      await dealer.send(Buffer.from(JSON.stringify(msg1)));
      await dealer.send(Buffer.from(JSON.stringify(msg2)));
      await dealer.send(Buffer.from(JSON.stringify(msg3)));

      const sent = harness.getSentMessages();
      expect(sent).toHaveLength(3);
      expect(sent[0].correlation).toBe('first');
      expect(sent[1].correlation).toBe('second');
      expect(sent[2].correlation).toBe('third');
    });

    it('returns a copy that does not affect internal state', async () => {
      const dealer = harness.getDealer();
      const wireMsg = createWireMessage({ correlation: 'copy-test' });
      await dealer.send(Buffer.from(JSON.stringify(wireMsg)));

      const sent = harness.getSentMessages();
      sent.length = 0; // Mutate the returned array.

      // Internal state should be unaffected.
      expect(harness.getSentMessages()).toHaveLength(1);
    });

    it('does not record invalid JSON payloads', async () => {
      const dealer = harness.getDealer();
      await dealer.send(Buffer.from('this is not JSON'));

      expect(harness.getSentMessages()).toHaveLength(0);
    });

    it('does not record payloads that are not valid wire messages', async () => {
      const dealer = harness.getDealer();
      // Valid JSON but has envelope identity fields.
      const invalidMsg = {
        topic: 'tool.invoke.test',
        correlation: 'corr-1',
        arguments: {},
        id: 'should-not-be-here',
        version: 1,
        type: 'request',
        source: 'container',
        group: 'test',
        timestamp: new Date().toISOString(),
      };
      await dealer.send(Buffer.from(JSON.stringify(invalidMsg)));

      expect(harness.getSentMessages()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // validateWireMessage (static)
  // -------------------------------------------------------------------------

  describe('validateWireMessage', () => {
    it('accepts a valid wire message', () => {
      const msg = createWireMessage();
      expect(IpcTestHarness.validateWireMessage(msg)).toBe(true);
    });

    it('accepts a wire message with empty arguments', () => {
      const msg = createWireMessage({ arguments: {} });
      expect(IpcTestHarness.validateWireMessage(msg)).toBe(true);
    });

    it('accepts a wire message with nested arguments', () => {
      const msg = createWireMessage({
        arguments: { nested: { deep: true } },
      });
      expect(IpcTestHarness.validateWireMessage(msg)).toBe(true);
    });

    describe('rejects messages with envelope identity fields', () => {
      it('rejects message with "id" field', () => {
        const msg = { ...createWireMessage(), id: 'evt-001' };
        expect(IpcTestHarness.validateWireMessage(msg)).toBe(false);
      });

      it('rejects message with "version" field', () => {
        const msg = { ...createWireMessage(), version: 1 };
        expect(IpcTestHarness.validateWireMessage(msg)).toBe(false);
      });

      it('rejects message with "type" field', () => {
        const msg = { ...createWireMessage(), type: 'request' };
        expect(IpcTestHarness.validateWireMessage(msg)).toBe(false);
      });

      it('rejects message with "source" field', () => {
        const msg = { ...createWireMessage(), source: 'container' };
        expect(IpcTestHarness.validateWireMessage(msg)).toBe(false);
      });

      it('rejects message with "group" field', () => {
        const msg = { ...createWireMessage(), group: 'test-group' };
        expect(IpcTestHarness.validateWireMessage(msg)).toBe(false);
      });

      it('rejects message with "timestamp" field', () => {
        const msg = { ...createWireMessage(), timestamp: new Date().toISOString() };
        expect(IpcTestHarness.validateWireMessage(msg)).toBe(false);
      });

      it('rejects message with multiple envelope identity fields', () => {
        const msg = {
          ...createWireMessage(),
          id: 'evt-001',
          version: 1,
          type: 'request',
          source: 'container',
          group: 'test-group',
          timestamp: new Date().toISOString(),
        };
        expect(IpcTestHarness.validateWireMessage(msg)).toBe(false);
      });
    });

    describe('rejects messages missing required wire fields', () => {
      it('rejects message missing "topic"', () => {
        const { topic: _, ...rest } = createWireMessage();
        expect(IpcTestHarness.validateWireMessage(rest)).toBe(false);
      });

      it('rejects message missing "correlation"', () => {
        const { correlation: _, ...rest } = createWireMessage();
        expect(IpcTestHarness.validateWireMessage(rest)).toBe(false);
      });

      it('rejects message missing "arguments"', () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { arguments: _, ...rest } = createWireMessage();
        expect(IpcTestHarness.validateWireMessage(rest)).toBe(false);
      });

      it('rejects an empty object', () => {
        expect(IpcTestHarness.validateWireMessage({})).toBe(false);
      });
    });

    describe('rejects non-object values', () => {
      it('rejects null', () => {
        expect(IpcTestHarness.validateWireMessage(null)).toBe(false);
      });

      it('rejects undefined', () => {
        expect(IpcTestHarness.validateWireMessage(undefined)).toBe(false);
      });

      it('rejects a string', () => {
        expect(IpcTestHarness.validateWireMessage('not an object')).toBe(false);
      });

      it('rejects a number', () => {
        expect(IpcTestHarness.validateWireMessage(42)).toBe(false);
      });

      it('rejects an array', () => {
        expect(IpcTestHarness.validateWireMessage([1, 2, 3])).toBe(false);
      });

      it('rejects a boolean', () => {
        expect(IpcTestHarness.validateWireMessage(true)).toBe(false);
      });
    });

    describe('rejects messages with wrong field types', () => {
      it('rejects non-string topic', () => {
        const msg = { topic: 123, correlation: 'corr-1', arguments: {} };
        expect(IpcTestHarness.validateWireMessage(msg)).toBe(false);
      });

      it('rejects non-string correlation', () => {
        const msg = { topic: 'tool.invoke.test', correlation: 123, arguments: {} };
        expect(IpcTestHarness.validateWireMessage(msg)).toBe(false);
      });

      it('rejects null arguments', () => {
        const msg = { topic: 'tool.invoke.test', correlation: 'corr-1', arguments: null };
        expect(IpcTestHarness.validateWireMessage(msg)).toBe(false);
      });

      it('rejects array arguments', () => {
        const msg = { topic: 'tool.invoke.test', correlation: 'corr-1', arguments: [1, 2] };
        expect(IpcTestHarness.validateWireMessage(msg)).toBe(false);
      });

      it('rejects string arguments', () => {
        const msg = { topic: 'tool.invoke.test', correlation: 'corr-1', arguments: 'nope' };
        expect(IpcTestHarness.validateWireMessage(msg)).toBe(false);
      });
    });
  });

  // -------------------------------------------------------------------------
  // invoke
  // -------------------------------------------------------------------------

  describe('invoke', () => {
    it('throws "not yet implemented" error', async () => {
      await expect(harness.invoke('tool.invoke.test', { input: 'hello' })).rejects.toThrow(
        'IPC binary invoke is not yet implemented (waiting for ENG-05)',
      );
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('cleans up without error', async () => {
      // close() is already called in afterEach; here we test it explicitly.
      const h = await IpcTestHarness.create();
      await expect(h.close()).resolves.toBeUndefined();
    });

    it('closes the router socket', async () => {
      const h = await IpcTestHarness.create();
      const router = h.getRouter();

      await h.close();
      expect(router.closed).toBe(true);
    });

    it('closes the dealer socket', async () => {
      const h = await IpcTestHarness.create();
      const dealer = h.getDealer();

      await h.close();
      expect(dealer.closed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // create (static factory)
  // -------------------------------------------------------------------------

  describe('create', () => {
    it('returns an IpcTestHarness instance', async () => {
      const h = await IpcTestHarness.create();
      expect(h).toBeInstanceOf(IpcTestHarness);
      await h.close();
    });

    it('wires a connected router/dealer pair', async () => {
      const h = await IpcTestHarness.create();
      const router = h.getRouter();
      const dealer = h.getDealer();

      expect(router.boundAddress).toBeTruthy();
      expect(dealer.connectedTo).toBe(router);
      await h.close();
    });
  });
});
