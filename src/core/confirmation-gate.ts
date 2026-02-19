/**
 * User confirmation gate for Carapace.
 *
 * Manages pending confirmation requests for high-risk tool invocations.
 * When a tool with risk_level: "high" is invoked, the core registers a
 * pending confirmation and waits for user approval, denial, or timeout.
 *
 * See docs/ARCHITECTURE.md § Pipeline Stage 5 and docs/TASKS.md ENG-15.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of a confirmation request. */
export type ConfirmationOutcome =
  | { approved: true }
  | { approved: false; reason: 'denied' | 'timeout' };

/** Details of a pending confirmation request. */
export interface ConfirmationRequest {
  confirmationId: string;
  toolName: string;
  requestedAt: string;
}

/** Internal state for a pending confirmation. */
interface PendingEntry {
  request: ConfirmationRequest;
  resolve: (outcome: ConfirmationOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Options for the ConfirmationGate. */
export interface ConfirmationGateOptions {
  /** Timeout in milliseconds before auto-rejecting. Default: 300_000 (5 minutes). */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// ConfirmationGate
// ---------------------------------------------------------------------------

/**
 * Manages pending confirmation requests for high-risk tool invocations.
 *
 * Usage:
 *   1. `requestConfirmation(id, toolName)` — returns a Promise<ConfirmationOutcome>
 *   2. User approves → call `approve(id)` → promise resolves with { approved: true }
 *   3. User denies → call `deny(id)` → promise resolves with { approved: false, reason: 'denied' }
 *   4. Timeout expires → promise resolves with { approved: false, reason: 'timeout' }
 */
export class ConfirmationGate {
  private readonly timeoutMs: number;
  private readonly pending: Map<string, PendingEntry> = new Map();

  constructor(options?: ConfirmationGateOptions) {
    this.timeoutMs = options?.timeoutMs ?? 300_000;
  }

  /**
   * Register a new confirmation request.
   *
   * Returns a promise that resolves when the request is approved, denied,
   * or times out. The caller should await this promise and act on the outcome.
   *
   * @throws If a request with the same ID is already pending.
   */
  requestConfirmation(confirmationId: string, toolName: string): Promise<ConfirmationOutcome> {
    if (this.pending.has(confirmationId)) {
      throw new Error(
        `Confirmation "${confirmationId}" is already pending. ` +
          `Each confirmation ID must be unique.`,
      );
    }

    return new Promise<ConfirmationOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.removePending(confirmationId);
        resolve({ approved: false, reason: 'timeout' });
      }, this.timeoutMs);

      const entry: PendingEntry = {
        request: {
          confirmationId,
          toolName,
          requestedAt: new Date().toISOString(),
        },
        resolve,
        timer,
      };

      this.pending.set(confirmationId, entry);
    });
  }

  /**
   * Approve a pending confirmation request.
   *
   * @returns true if the confirmation was found and approved, false otherwise.
   */
  approve(confirmationId: string): boolean {
    const entry = this.pending.get(confirmationId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(confirmationId);
    entry.resolve({ approved: true });
    return true;
  }

  /**
   * Deny a pending confirmation request.
   *
   * @returns true if the confirmation was found and denied, false otherwise.
   */
  deny(confirmationId: string): boolean {
    const entry = this.pending.get(confirmationId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(confirmationId);
    entry.resolve({ approved: false, reason: 'denied' });
    return true;
  }

  /**
   * Cancel a specific pending confirmation (treated as timeout).
   */
  cancelPending(confirmationId: string): void {
    const entry = this.pending.get(confirmationId);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(confirmationId);
    entry.resolve({ approved: false, reason: 'timeout' });
  }

  /**
   * Cancel all pending confirmations (treated as timeout).
   * Useful during shutdown or cleanup.
   */
  cancelAll(): void {
    for (const [id] of this.pending) {
      this.cancelPending(id);
    }
  }

  /**
   * Get details of a specific pending confirmation.
   */
  getPending(confirmationId: string): ConfirmationRequest | undefined {
    return this.pending.get(confirmationId)?.request;
  }

  /**
   * List all pending confirmation requests.
   */
  listPending(): ConfirmationRequest[] {
    return [...this.pending.values()].map((e) => e.request);
  }

  /**
   * Number of currently pending confirmations.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private removePending(confirmationId: string): void {
    const entry = this.pending.get(confirmationId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(confirmationId);
    }
  }
}
