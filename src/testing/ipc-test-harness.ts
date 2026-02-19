/**
 * IPC test harness for testing the IPC binary (ENG-05).
 *
 * Uses fake sockets from QA-03 to simulate the ROUTER/DEALER channel
 * that the IPC binary will use. The harness acts as the host side:
 *   - ROUTER socket receives wire messages from the container (dealer)
 *   - Pre-programmed responses are sent back through the ROUTER
 *
 * This harness is designed to be wired to the future IPC binary once
 * ENG-05 is implemented. Until then, `invoke()` throws a "not yet
 * implemented" error.
 */

import type { WireMessage, ResponseEnvelope } from '../types/index.js';
import { WIRE_FIELDS, ENVELOPE_IDENTITY_FIELDS } from '../types/index.js';
import { FakeSocketFactory } from './fake-socket-factory.js';
import { FakeRouterSocket, FakeDealerSocket, wireFakeRouterDealer } from './fake-sockets.js';

// ---------------------------------------------------------------------------
// Programmed outcome types
// ---------------------------------------------------------------------------

interface ProgrammedResponse {
  kind: 'response';
  envelope: ResponseEnvelope;
}

interface ProgrammedTimeout {
  kind: 'timeout';
}

type ProgrammedOutcome = ProgrammedResponse | ProgrammedTimeout;

// ---------------------------------------------------------------------------
// IpcTestHarness
// ---------------------------------------------------------------------------

/**
 * Test harness for the IPC binary.
 *
 * Wires a fake ROUTER/DEALER pair so that:
 *   - When the IPC binary (future) sends a wire message through the DEALER,
 *     the harness's ROUTER receives it.
 *   - The harness can send pre-programmed responses back through the ROUTER.
 *
 * Usage:
 *
 * ```ts
 * const harness = await IpcTestHarness.create();
 * harness.programResponse('corr-1', someResponseEnvelope);
 *
 * // ... future: invoke IPC binary which sends through the dealer ...
 *
 * expect(harness.getSentMessages()).toHaveLength(1);
 * await harness.close();
 * ```
 */
export class IpcTestHarness {
  private readonly factory: FakeSocketFactory;
  private readonly router: FakeRouterSocket;
  private readonly dealer: FakeDealerSocket;
  private readonly programmedOutcomes: Map<string, ProgrammedOutcome> = new Map();
  private readonly sentMessages: WireMessage[] = [];

  private constructor(
    factory: FakeSocketFactory,
    router: FakeRouterSocket,
    dealer: FakeDealerSocket,
  ) {
    this.factory = factory;
    this.router = router;
    this.dealer = dealer;

    // Listen for messages arriving on the ROUTER from the DEALER.
    // When a wire message arrives, record it and check for programmed outcomes.
    this.router.on('message', (identity, _delimiter, payload) => {
      try {
        const parsed: unknown = JSON.parse(payload.toString());
        if (IpcTestHarness.validateWireMessage(parsed)) {
          this.sentMessages.push(parsed);

          // Check for a programmed outcome.
          const outcome = this.programmedOutcomes.get(parsed.correlation);
          if (outcome) {
            this.programmedOutcomes.delete(parsed.correlation);

            if (outcome.kind === 'response') {
              const responsePayload = Buffer.from(JSON.stringify(outcome.envelope));
              void this.router.send(identity, Buffer.alloc(0), responsePayload);
            }
            // For 'timeout', we intentionally do nothing (simulate no response).
          }
        }
      } catch {
        // If the payload isn't valid JSON, ignore it — the harness only
        // processes well-formed wire messages.
      }
    });
  }

  /**
   * Create a new IpcTestHarness with a wired ROUTER/DEALER pair.
   *
   * Uses `wireFakeRouterDealer()` to set up the fake socket pair and
   * a `FakeSocketFactory` for resource tracking.
   */
  static async create(): Promise<IpcTestHarness> {
    const factory = new FakeSocketFactory();
    const { router, dealer } = await wireFakeRouterDealer();
    return new IpcTestHarness(factory, router, dealer);
  }

  /**
   * Pre-program a response for a given correlation ID.
   *
   * When a wire message with the matching correlation ID arrives on the
   * ROUTER, the harness will immediately send this response back.
   */
  programResponse(correlationId: string, response: ResponseEnvelope): void {
    this.programmedOutcomes.set(correlationId, {
      kind: 'response',
      envelope: response,
    });
  }

  /**
   * Pre-program a timeout for a given correlation ID.
   *
   * When a wire message with the matching correlation ID arrives on the
   * ROUTER, the harness will intentionally not send any response,
   * simulating a timeout.
   */
  programTimeout(correlationId: string): void {
    this.programmedOutcomes.set(correlationId, { kind: 'timeout' });
  }

  /**
   * Get all wire messages that have been sent through the harness.
   *
   * Returns a shallow copy of the internal array so callers cannot
   * mutate the harness state.
   */
  getSentMessages(): WireMessage[] {
    return [...this.sentMessages];
  }

  /**
   * Static type guard that validates a value is a well-formed WireMessage.
   *
   * A valid wire message:
   *   - Is a non-null object (not an array)
   *   - Has all three WIRE_FIELDS: topic, correlation, arguments
   *   - Has no ENVELOPE_IDENTITY_FIELDS (id, version, type, source, group, timestamp)
   *   - `topic` is a string
   *   - `correlation` is a string
   *   - `arguments` is a non-null object
   */
  static validateWireMessage(msg: unknown): msg is WireMessage {
    if (msg === null || msg === undefined || typeof msg !== 'object' || Array.isArray(msg)) {
      return false;
    }

    const record = msg as Record<string, unknown>;

    // Check all required wire fields are present with correct types.
    for (const field of WIRE_FIELDS) {
      if (!(field in record)) {
        return false;
      }
    }

    if (typeof record['topic'] !== 'string') {
      return false;
    }

    if (typeof record['correlation'] !== 'string') {
      return false;
    }

    if (
      record['arguments'] === null ||
      record['arguments'] === undefined ||
      typeof record['arguments'] !== 'object' ||
      Array.isArray(record['arguments'])
    ) {
      return false;
    }

    // Reject messages that contain envelope identity fields.
    for (const field of ENVELOPE_IDENTITY_FIELDS) {
      if (field in record) {
        return false;
      }
    }

    return true;
  }

  /**
   * Invoke a tool through the IPC binary.
   *
   * This method will be wired to the ENG-05 IPC binary in P1.
   * Until then, it throws a "not yet implemented" error.
   */
  async invoke(_topic: string, _args: Record<string, unknown>): Promise<ResponseEnvelope> {
    throw new Error('IPC binary invoke is not yet implemented (waiting for ENG-05)');
  }

  /**
   * Clean up all resources held by the harness.
   *
   * Closes the ROUTER and DEALER sockets and the underlying factory.
   */
  async close(): Promise<void> {
    await this.router.close();
    await this.dealer.close();
    await this.factory.cleanup();
  }

  /**
   * Get the ROUTER socket for advanced test scenarios.
   * @internal Exposed for testing only.
   */
  getRouter(): FakeRouterSocket {
    return this.router;
  }

  /**
   * Get the DEALER socket for advanced test scenarios.
   * @internal Exposed for testing only.
   */
  getDealer(): FakeDealerSocket {
    return this.dealer;
  }

  /**
   * Check whether a specific correlation ID has a programmed outcome.
   * @internal Exposed for testing only.
   */
  hasProgrammedOutcome(correlationId: string): boolean {
    return this.programmedOutcomes.has(correlationId);
  }
}
