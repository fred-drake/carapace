import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ConfirmationGate,
  type ConfirmationOutcome,
  type ConfirmationRequest,
} from './confirmation-gate.js';

describe('ConfirmationGate', () => {
  let gate: ConfirmationGate;

  beforeEach(() => {
    vi.useFakeTimers();
    gate = new ConfirmationGate({ timeoutMs: 5_000 });
  });

  afterEach(() => {
    gate.cancelAll();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Basic flow
  // -------------------------------------------------------------------------

  describe('requestConfirmation', () => {
    it('returns a promise that resolves when approved', async () => {
      const promise = gate.requestConfirmation('conf-1', 'delete_reminder');
      gate.approve('conf-1');
      const outcome = await promise;
      expect(outcome.approved).toBe(true);
    });

    it('returns a promise that resolves with denied when denied', async () => {
      const promise = gate.requestConfirmation('conf-1', 'delete_reminder');
      gate.deny('conf-1');
      const outcome = await promise;
      expect(outcome.approved).toBe(false);
      if (!outcome.approved) {
        expect(outcome.reason).toBe('denied');
      }
    });

    it('returns a promise that resolves with timeout when timed out', async () => {
      const promise = gate.requestConfirmation('conf-1', 'delete_reminder');
      vi.advanceTimersByTime(5_001);
      const outcome = await promise;
      expect(outcome.approved).toBe(false);
      if (!outcome.approved) {
        expect(outcome.reason).toBe('timeout');
      }
    });

    it('uses configurable timeout', async () => {
      const shortGate = new ConfirmationGate({ timeoutMs: 1_000 });
      const promise = shortGate.requestConfirmation('conf-1', 'test');
      vi.advanceTimersByTime(1_001);
      const outcome = await promise;
      expect(outcome.approved).toBe(false);
      if (!outcome.approved) {
        expect(outcome.reason).toBe('timeout');
      }
      shortGate.cancelAll();
    });

    it('uses default 5-minute timeout', async () => {
      const defaultGate = new ConfirmationGate();
      const promise = defaultGate.requestConfirmation('conf-1', 'test');

      // Should not have timed out at 4 minutes 59 seconds
      vi.advanceTimersByTime(299_000);
      expect(defaultGate.pendingCount).toBe(1);

      // Should time out at 5 minutes
      vi.advanceTimersByTime(2_000);
      const outcome = await promise;
      expect(outcome.approved).toBe(false);
      defaultGate.cancelAll();
    });
  });

  // -------------------------------------------------------------------------
  // approve()
  // -------------------------------------------------------------------------

  describe('approve', () => {
    it('returns true when confirmation exists', () => {
      gate.requestConfirmation('conf-1', 'test');
      expect(gate.approve('conf-1')).toBe(true);
    });

    it('returns false for unknown confirmation ID', () => {
      expect(gate.approve('nonexistent')).toBe(false);
    });

    it('cleans up pending state after approval', async () => {
      const promise = gate.requestConfirmation('conf-1', 'test');
      gate.approve('conf-1');
      await promise;
      expect(gate.pendingCount).toBe(0);
    });

    it('cannot approve the same ID twice', async () => {
      const promise = gate.requestConfirmation('conf-1', 'test');
      expect(gate.approve('conf-1')).toBe(true);
      expect(gate.approve('conf-1')).toBe(false);
      await promise;
    });
  });

  // -------------------------------------------------------------------------
  // deny()
  // -------------------------------------------------------------------------

  describe('deny', () => {
    it('returns true when confirmation exists', () => {
      gate.requestConfirmation('conf-1', 'test');
      expect(gate.deny('conf-1')).toBe(true);
    });

    it('returns false for unknown confirmation ID', () => {
      expect(gate.deny('nonexistent')).toBe(false);
    });

    it('cleans up pending state after denial', async () => {
      const promise = gate.requestConfirmation('conf-1', 'test');
      gate.deny('conf-1');
      await promise;
      expect(gate.pendingCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Pending state management
  // -------------------------------------------------------------------------

  describe('pending state', () => {
    it('tracks pending count', () => {
      expect(gate.pendingCount).toBe(0);
      gate.requestConfirmation('conf-1', 'tool-a');
      expect(gate.pendingCount).toBe(1);
      gate.requestConfirmation('conf-2', 'tool-b');
      expect(gate.pendingCount).toBe(2);
    });

    it('decrements pending count on approval', async () => {
      const p = gate.requestConfirmation('conf-1', 'test');
      gate.approve('conf-1');
      await p;
      expect(gate.pendingCount).toBe(0);
    });

    it('decrements pending count on denial', async () => {
      const p = gate.requestConfirmation('conf-1', 'test');
      gate.deny('conf-1');
      await p;
      expect(gate.pendingCount).toBe(0);
    });

    it('decrements pending count on timeout', async () => {
      const p = gate.requestConfirmation('conf-1', 'test');
      vi.advanceTimersByTime(5_001);
      await p;
      expect(gate.pendingCount).toBe(0);
    });

    it('getPending returns request details', () => {
      gate.requestConfirmation('conf-1', 'delete_reminder');
      const pending = gate.getPending('conf-1');
      expect(pending).toBeDefined();
      expect(pending!.toolName).toBe('delete_reminder');
      expect(pending!.confirmationId).toBe('conf-1');
      expect(typeof pending!.requestedAt).toBe('string');
    });

    it('getPending returns undefined for unknown ID', () => {
      expect(gate.getPending('nonexistent')).toBeUndefined();
    });

    it('listPending returns all pending requests', () => {
      gate.requestConfirmation('conf-1', 'tool-a');
      gate.requestConfirmation('conf-2', 'tool-b');
      const pending = gate.listPending();
      expect(pending).toHaveLength(2);
      const ids = pending.map((p) => p.confirmationId).sort();
      expect(ids).toEqual(['conf-1', 'conf-2']);
    });
  });

  // -------------------------------------------------------------------------
  // cancelPending / cancelAll
  // -------------------------------------------------------------------------

  describe('cancelPending', () => {
    it('cancels a specific pending confirmation', async () => {
      const p = gate.requestConfirmation('conf-1', 'test');
      gate.cancelPending('conf-1');
      const outcome = await p;
      expect(outcome.approved).toBe(false);
      if (!outcome.approved) {
        expect(outcome.reason).toBe('timeout');
      }
      expect(gate.pendingCount).toBe(0);
    });

    it('does nothing for unknown ID', () => {
      expect(() => gate.cancelPending('nonexistent')).not.toThrow();
    });
  });

  describe('cancelAll', () => {
    it('cancels all pending confirmations', async () => {
      const p1 = gate.requestConfirmation('conf-1', 'tool-a');
      const p2 = gate.requestConfirmation('conf-2', 'tool-b');
      gate.cancelAll();
      const [o1, o2] = await Promise.all([p1, p2]);
      expect(o1.approved).toBe(false);
      expect(o2.approved).toBe(false);
      expect(gate.pendingCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent confirmations
  // -------------------------------------------------------------------------

  describe('concurrent confirmations', () => {
    it('handles multiple independent confirmations', async () => {
      const p1 = gate.requestConfirmation('conf-1', 'tool-a');
      const p2 = gate.requestConfirmation('conf-2', 'tool-b');

      gate.approve('conf-1');
      gate.deny('conf-2');

      const [o1, o2] = await Promise.all([p1, p2]);
      expect(o1.approved).toBe(true);
      expect(o2.approved).toBe(false);
      if (!o2.approved) {
        expect(o2.reason).toBe('denied');
      }
    });

    it('timeout of one does not affect another', async () => {
      const p1 = gate.requestConfirmation('conf-1', 'tool-a');
      const p2 = gate.requestConfirmation('conf-2', 'tool-b');

      // Advance past timeout
      vi.advanceTimersByTime(5_001);
      const o1 = await p1;
      expect(o1.approved).toBe(false);

      // conf-2 also timed out (same timeout)
      const o2 = await p2;
      expect(o2.approved).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate request IDs
  // -------------------------------------------------------------------------

  describe('duplicate request IDs', () => {
    it('rejects duplicate confirmation IDs', () => {
      gate.requestConfirmation('conf-1', 'test');
      expect(() => gate.requestConfirmation('conf-1', 'test')).toThrow(/already.*pending/i);
    });
  });
});
