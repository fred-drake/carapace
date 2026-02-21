/**
 * ZeroMQ ROUTER/DEALER request channel for Carapace.
 *
 * The host-side ROUTER socket binds to a Unix domain socket and multiplexes
 * request/response exchanges with one or more container-side DEALER sockets.
 *
 * Wire format (DEALER → ROUTER):
 *   [connection-identity (auto-prepended by ROUTER), empty-delimiter, payload-json]
 *
 * Wire format (ROUTER → DEALER):
 *   [connection-identity, empty-delimiter, response-json]
 *
 * The RequestChannel tracks pending correlations so responses are routed back
 * to the correct DEALER. Unanswered requests time out after a configurable
 * duration (default 30 seconds).
 */

import type { WireMessage, ResponseEnvelope } from '../types/protocol.js';
import type { RouterSocket, SocketFactory } from '../types/socket.js';
import { createLogger, type Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Options for configuring the RequestChannel. */
export interface RequestChannelOptions {
  /** Timeout in milliseconds for unanswered requests. Defaults to 30000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

/** Internal record for a pending correlation. */
interface PendingRequest {
  /** Connection identity of the DEALER that sent the request. */
  connectionIdentity: string;
  /** Timer handle for the timeout. */
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Request handler type
// ---------------------------------------------------------------------------

/** Callback invoked when a request arrives from a DEALER. */
export type RequestHandler = (connectionIdentity: string, wireMessage: WireMessage) => void;

// ---------------------------------------------------------------------------
// Timeout handler type
// ---------------------------------------------------------------------------

/** Callback invoked when a pending request times out. */
export type TimeoutHandler = (correlation: string, connectionIdentity: string) => void;

// ---------------------------------------------------------------------------
// RequestChannel
// ---------------------------------------------------------------------------

/**
 * Host-side ROUTER socket that multiplexes request/response exchanges
 * with container-side DEALER sockets.
 *
 * Typical lifecycle:
 * 1. `bind(address)` — create and bind the ROUTER socket
 * 2. `onRequest(handler)` — register a handler for incoming requests
 * 3. `sendResponse(identity, response)` — route responses back to dealers
 * 4. `close()` — shut down the channel
 */
export class RequestChannel {
  private readonly factory: SocketFactory;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private socket: RouterSocket | null = null;
  private handler: RequestHandler | null = null;
  private timeoutHandler: TimeoutHandler | null = null;
  private readonly pending: Map<string, PendingRequest> = new Map();

  constructor(factory: SocketFactory, options?: RequestChannelOptions, logger?: Logger) {
    this.factory = factory;
    this.timeoutMs = options?.timeoutMs ?? 30_000;
    this.logger = logger ?? createLogger('request-channel');
  }

  /**
   * Create a ROUTER socket and bind it to the given address.
   *
   * @param address - Transport address (e.g. "ipc:///tmp/carapace-req.sock").
   * @throws If the channel is already bound.
   */
  async bind(address: string): Promise<void> {
    if (this.socket) {
      throw new Error('RequestChannel is already bound');
    }

    this.socket = this.factory.createRouter();
    await this.socket.bind(address);
    this.logger.info('ROUTER socket bound', { address });

    this.socket.on('message', (identity: Buffer, delimiter: Buffer, payload: Buffer) => {
      this.handleIncoming(identity, delimiter, payload);
    });
  }

  /**
   * Register a handler for incoming requests from DEALERs.
   *
   * Only one handler may be registered at a time; subsequent calls replace
   * the previous handler.
   */
  onRequest(handler: RequestHandler): void {
    this.handler = handler;
  }

  /**
   * Register a handler invoked when a pending request times out.
   *
   * Only one handler may be registered at a time; subsequent calls replace
   * the previous handler.
   */
  onTimeout(handler: TimeoutHandler): void {
    this.timeoutHandler = handler;
  }

  /**
   * Send a response back to the correct DEALER identified by connection
   * identity.
   *
   * The correlation ID in the response must match a pending request. After
   * sending, the pending entry is cleaned up.
   *
   * @param connectionIdentity - The DEALER's connection identity (hex string).
   * @param response - The response envelope to send.
   * @throws If the channel is not bound.
   * @throws If the correlation ID is not found in pending requests.
   * @throws If the correlation maps to a different connection identity.
   */
  async sendResponse(connectionIdentity: string, response: ResponseEnvelope): Promise<void> {
    if (!this.socket) {
      throw new Error('RequestChannel is not bound');
    }

    const correlation = response.correlation;
    const pendingEntry = this.pending.get(correlation);

    if (!pendingEntry) {
      throw new Error(`No pending request for correlation: ${correlation}`);
    }

    if (pendingEntry.connectionIdentity !== connectionIdentity) {
      throw new Error(
        `Correlation ${correlation} belongs to identity ${pendingEntry.connectionIdentity}, ` +
          `not ${connectionIdentity}`,
      );
    }

    // Clear timeout and remove from pending map
    clearTimeout(pendingEntry.timer);
    this.pending.delete(correlation);

    // Send [identity, delimiter, payload] back to the DEALER
    const identityBuffer = Buffer.from(connectionIdentity, 'hex');
    const delimiter = Buffer.alloc(0);
    const payloadBuffer = Buffer.from(JSON.stringify(response));

    await this.socket.send(identityBuffer, delimiter, payloadBuffer);
    this.logger.debug('response sent', { correlation, topic: response.topic });
  }

  /**
   * Close the ROUTER socket, cancel all pending timeouts, and release
   * tracked state.
   */
  async close(): Promise<void> {
    // Cancel all pending timeouts
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();

    // Close the socket
    if (this.socket) {
      await this.socket.close();
      this.socket = null;
    }

    this.handler = null;
    this.timeoutHandler = null;
    this.logger.info('request channel closed');
  }

  /** Number of in-flight (pending) correlations. Useful for diagnostics. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Process an incoming multi-frame message from a DEALER.
   *
   * Parses the JSON payload into a WireMessage, registers the correlation
   * for response routing, and invokes the registered handler.
   */
  private handleIncoming(identity: Buffer, _delimiter: Buffer, payload: Buffer): void {
    const connectionIdentity = identity.toString('hex');

    let wireMessage: WireMessage;
    try {
      wireMessage = JSON.parse(payload.toString()) as WireMessage;
    } catch {
      // Malformed JSON — nothing to route back to
      this.logger.warn('malformed JSON dropped', { connectionIdentity });
      return;
    }

    const correlation = wireMessage.correlation;
    this.logger.debug('frame received', { correlation, topic: wireMessage.topic });

    // Register pending correlation with timeout
    const timer = setTimeout(() => {
      this.pending.delete(correlation);
      this.logger.warn('request timed out', { correlation, connectionIdentity });
      if (this.timeoutHandler) {
        this.timeoutHandler(correlation, connectionIdentity);
      }
    }, this.timeoutMs);

    this.pending.set(correlation, {
      connectionIdentity,
      timer,
    });

    // Invoke the registered handler
    if (this.handler) {
      this.handler(connectionIdentity, wireMessage);
    }
  }
}
