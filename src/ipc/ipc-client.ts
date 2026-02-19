/**
 * IPC client — the container-side communication layer.
 *
 * Wraps a ZeroMQ DEALER socket and provides a simple request/response
 * interface for invoking tools on the host. The `ipc` CLI binary
 * delegates to this class.
 *
 * Responsibilities:
 *   - Construct wire messages (topic, correlation, arguments)
 *   - Send via DEALER socket to the host ROUTER
 *   - Wait for a correlated response with configurable timeout
 *   - Enforce client-side payload size limits
 */

import { randomUUID } from 'node:crypto';
import type { DealerSocket, DealerMessageHandler } from '../types/socket.js';
import type { WireMessage, ResponseEnvelope } from '../types/protocol.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Options for configuring the IPC client. */
export interface IpcClientOptions {
  /** Timeout in milliseconds waiting for a response. Default 35000. */
  timeoutMs?: number;
  /** Maximum payload size in bytes. Default 1MB. */
  maxPayloadBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576; // 1 MB

// ---------------------------------------------------------------------------
// IpcClient
// ---------------------------------------------------------------------------

/**
 * Container-side IPC client that sends tool invocations to the host
 * and waits for responses.
 *
 * Usage:
 * ```ts
 * const client = new IpcClient(dealerSocket);
 * const response = await client.invoke('tool.invoke.create_reminder', { title: 'test' });
 * console.log(response.payload.result);
 * await client.close();
 * ```
 */
export class IpcClient {
  private readonly socket: DealerSocket;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private closed = false;

  /** Pending invocations waiting for a correlated response. */
  private readonly pending: Map<
    string,
    {
      resolve: (response: ResponseEnvelope) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  > = new Map();

  constructor(socket: DealerSocket, options?: IpcClientOptions) {
    this.socket = socket;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;

    // Listen for responses from the host.
    const handler: DealerMessageHandler = (payload: Buffer) => {
      this.handleResponse(payload);
    };
    this.socket.on('message', handler);
  }

  /**
   * Invoke a tool on the host.
   *
   * Constructs a wire message, sends it via the DEALER socket, and
   * waits for a response matched by correlation ID.
   *
   * @param topic - The tool topic (e.g. "tool.invoke.create_reminder").
   * @param args - The tool arguments.
   * @returns The response envelope from the host.
   * @throws If the client is closed, payload exceeds limits, socket
   *   errors, or the request times out.
   */
  async invoke(topic: string, args: Record<string, unknown>): Promise<ResponseEnvelope> {
    if (this.closed) {
      throw new Error('IPC client is closed');
    }

    const correlation = randomUUID();

    const wireMessage: WireMessage = {
      topic,
      correlation,
      arguments: args,
    };

    const serialized = JSON.stringify(wireMessage);

    // Check payload size before sending.
    const byteLength = Buffer.byteLength(serialized, 'utf-8');
    if (byteLength > this.maxPayloadBytes) {
      throw new Error(
        `Message exceeds payload size limit: ${byteLength} bytes > ${this.maxPayloadBytes} byte limit`,
      );
    }

    // Register the pending entry BEFORE sending so that synchronous
    // response delivery (e.g. from fake sockets in tests) can find it.
    const responsePromise = new Promise<ResponseEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlation);
        reject(
          new Error(`IPC request timeout after ${this.timeoutMs}ms (correlation: ${correlation})`),
        );
      }, this.timeoutMs);

      this.pending.set(correlation, { resolve, reject, timer });
    });

    // Send the wire message. If send fails, clean up the pending entry
    // so close() doesn't reject an orphaned promise.
    try {
      await this.socket.send(Buffer.from(serialized));
    } catch (sendError) {
      const entry = this.pending.get(correlation);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(correlation);
      }
      throw sendError;
    }

    return responsePromise;
  }

  /**
   * Close the client and the underlying DEALER socket.
   * Rejects all pending invocations.
   */
  async close(): Promise<void> {
    this.closed = true;

    // Reject all pending invocations.
    for (const [correlation, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('IPC client closed while waiting for response'));
      this.pending.delete(correlation);
    }

    await this.socket.close();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Process a response payload from the DEALER socket. */
  private handleResponse(payload: Buffer): void {
    let response: ResponseEnvelope;
    try {
      response = JSON.parse(payload.toString()) as ResponseEnvelope;
    } catch {
      // Malformed JSON — drop it.
      return;
    }

    const correlation = response.correlation;
    if (!correlation) return;

    const entry = this.pending.get(correlation);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(correlation);
    entry.resolve(response);
  }
}
