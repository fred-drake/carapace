#!/usr/bin/env node
/**
 * IPC binary entry point — the container's sole communication channel.
 *
 * Usage: ipc <topic> <arguments-json>
 *
 * Connects to the host via a ZeroMQ DEALER socket at a well-known
 * Unix socket path, sends a wire message, and prints the response.
 *
 * Exit codes:
 *   0 — success (result printed to stdout)
 *   1 — error (structured error JSON printed to stderr)
 */

import { Dealer } from 'zeromq';
import { IpcClient } from './ipc-client.js';
import { parseCliArgs, formatOutput } from './cli.js';
import type { DealerSocket, DealerMessageHandler } from '../types/socket.js';
import { createIpcLogger } from './ipc-logger.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env['CARAPACE_SOCKET'] ?? 'ipc:///run/carapace.sock';
const TIMEOUT_MS = parseInt(process.env['CARAPACE_TIMEOUT'] ?? '35000', 10);
const CONNECTION_IDENTITY = process.env['CARAPACE_CONNECTION_IDENTITY'];
const logger = createIpcLogger('ipc');

// ---------------------------------------------------------------------------
// ZeroMQ adapter
// ---------------------------------------------------------------------------

/** Wraps a real zeromq.Dealer as a DealerSocket interface. */
class ZmqDealerAdapter implements DealerSocket {
  private readonly zmqDealer: Dealer;
  private handlers: DealerMessageHandler[] = [];
  private listening = false;

  constructor(routingId?: string) {
    this.zmqDealer = new Dealer();
    if (routingId) {
      this.zmqDealer.routingId = routingId;
    }
  }

  async connect(address: string): Promise<void> {
    this.zmqDealer.connect(address);
    if (!this.listening) {
      this.listening = true;
      this.startListening();
    }
  }

  async send(payload: Buffer): Promise<void> {
    // Send [empty-delimiter, payload] so the ROUTER receives
    // [identity, delimiter, payload] — standard ZeroMQ DEALER/ROUTER convention.
    await this.zmqDealer.send([Buffer.alloc(0), payload]);
  }

  on(_event: 'message', handler: DealerMessageHandler): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    this.zmqDealer.close();
  }

  private startListening(): void {
    // Start the async receive loop in the background.
    void (async () => {
      try {
        for await (const frames of this.zmqDealer) {
          // ROUTER sends [identity, delimiter, payload]; DEALER receives
          // [delimiter, payload] (identity stripped). Take the last frame
          // as the actual payload regardless of how many frames arrive.
          const buf = Buffer.from(frames[frames.length - 1]);
          for (const handler of this.handlers) {
            handler(buf);
          }
        }
      } catch {
        // Socket closed or error — stop listening.
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv);
  if (!parsed.ok) {
    logger.error('CLI parse failed', { error: parsed.error });
    const errorJson = JSON.stringify({
      code: 'CLI_ERROR',
      message: parsed.error,
      retriable: false,
    });
    process.stderr.write(errorJson + '\n');
    process.exit(1);
  }

  const { topic, arguments: args } = parsed.value;

  logger.info('starting', {
    topic,
    arg_keys: Object.keys(args),
    socket: SOCKET_PATH,
    timeout_ms: TIMEOUT_MS,
  });

  const dealer = new ZmqDealerAdapter(CONNECTION_IDENTITY);
  await dealer.connect(SOCKET_PATH);
  logger.debug('dealer connected', { socket: SOCKET_PATH, hasRoutingId: !!CONNECTION_IDENTITY });

  const client = new IpcClient(dealer, { timeoutMs: TIMEOUT_MS });

  try {
    const response = await client.invoke(topic, args);
    const output = formatOutput(response);

    if (output.stdout) {
      process.stdout.write(output.stdout + '\n');
    }
    if (output.stderr) {
      process.stderr.write(output.stderr + '\n');
    }

    logger.info('completed', { topic, exitCode: output.exitCode });
    await client.close();
    process.exit(output.exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('invocation failed', { topic, error: message });
    const errorJson = JSON.stringify({
      code: 'IPC_ERROR',
      message,
      retriable: false,
    });
    process.stderr.write(errorJson + '\n');
    await client.close();
    process.exit(1);
  }
}

void main();
