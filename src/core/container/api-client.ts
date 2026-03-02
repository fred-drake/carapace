/**
 * ContainerApiClient — HTTP client for claude-cli-api inside containers.
 *
 * Communicates over Unix domain sockets (Docker/Podman) or TCP
 * (Apple Containers) using Node.js built-in `node:http` — no extra deps.
 *
 * Provides health polling, non-streaming completion, and streaming
 * completion that yields SSE events as an async generator.
 */

import * as http from 'node:http';
import { parseSseStream, type ChatCompletionChunk } from './sse-parser.js';
import { createLogger, type Logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiClientOptions {
  /** Unix domain socket path (Docker/Podman). */
  socketPath?: string;
  /** TCP address in `host:port` format (Apple Containers). */
  tcpAddress?: string;
  /** Bearer token for API authentication. */
  apiKey: string;
  /** Optional logger. */
  logger?: Logger;
  /** Request timeout in milliseconds (default 300_000 = 5 min). */
  timeoutMs?: number;
}

export interface HealthResult {
  status: string;
  [key: string]: unknown;
}

export interface ChatRequest {
  /** The prompt text to send to Claude. */
  prompt: string;
  /** Optional session ID for resume. */
  sessionId?: string;
  /** Whether to stream the response (default: true). */
  stream?: boolean;
  /** Model identifier (default: 'sonnet'). */
  model?: string;
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// ContainerApiClient
// ---------------------------------------------------------------------------

/** Default request timeout: 5 minutes. */
const DEFAULT_TIMEOUT_MS = 300_000;

export class ContainerApiClient {
  private readonly socketPath?: string;
  private readonly tcpHost?: string;
  private readonly tcpPort?: number;
  private apiKey: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly agent: http.Agent;
  private closed = false;

  constructor(options: ApiClientOptions) {
    this.socketPath = options.socketPath;
    this.apiKey = options.apiKey;
    this.logger = options.logger ?? createLogger('api-client');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.agent = new http.Agent({ keepAlive: true });

    if (options.tcpAddress) {
      const lastColon = options.tcpAddress.lastIndexOf(':');
      if (lastColon === -1) {
        throw new Error(`Invalid tcpAddress format (expected host:port): ${options.tcpAddress}`);
      }
      const host = options.tcpAddress.slice(0, lastColon);
      if (!host) {
        throw new Error(`Invalid tcpAddress host: ${options.tcpAddress}`);
      }
      this.tcpHost = host;
      this.tcpPort = parseInt(options.tcpAddress.slice(lastColon + 1), 10);
      if (isNaN(this.tcpPort) || this.tcpPort < 1 || this.tcpPort > 65535) {
        throw new Error(`Invalid tcpAddress port: ${options.tcpAddress}`);
      }
    }

    if (!this.socketPath && !this.tcpHost) {
      throw new Error('ContainerApiClient requires either socketPath or tcpAddress');
    }
  }

  /**
   * Poll /health until the server is ready.
   *
   * Uses exponential backoff (1.5x multiplier, capped at 2s) starting from
   * `intervalMs`. The `isAlive` callback is only invoked after `graceMs`
   * have elapsed, giving the container time to transition from created to
   * running before we start checking for premature exits.
   */
  async waitForReady(
    timeoutMs = 30_000,
    intervalMs = 100,
    isAlive?: () => Promise<boolean>,
    graceMs = 3_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Cap grace period to half the total timeout so there's always time
    // for at least a few isAlive checks before the deadline.
    const effectiveGrace = Math.min(graceMs, Math.floor(timeoutMs / 2));
    const graceDeadline = Date.now() + effectiveGrace;
    const maxInterval = 2_000;
    let currentInterval = intervalMs;

    while (Date.now() < deadline) {
      try {
        await this.health();
        this.logger.info('API server ready');
        return;
      } catch {
        // Only check container liveness after the grace period to allow
        // time for the container to fully start (created→running transition).
        if (isAlive && Date.now() >= graceDeadline) {
          try {
            const alive = await isAlive();
            if (!alive) {
              throw new Error('Container exited before API server started');
            }
          } catch (aliveErr) {
            if (aliveErr instanceof Error && aliveErr.message.includes('Container exited')) {
              throw aliveErr;
            }
            // isAlive check itself failed — log and continue polling
            this.logger.debug('isAlive check error (continuing poll)', {
              error: aliveErr instanceof Error ? aliveErr.message : String(aliveErr),
            });
          }
        }

        await new Promise((r) => setTimeout(r, currentInterval));
        currentInterval = Math.min(currentInterval * 1.5, maxInterval);
      }
    }

    throw new Error(`claude-cli-api server did not become ready within ${timeoutMs}ms`);
  }

  /** Check the health endpoint. */
  async health(): Promise<HealthResult> {
    const body = await this.request('GET', '/health');
    return JSON.parse(body) as HealthResult;
  }

  /** Send a non-streaming completion request. */
  async complete(request: ChatRequest): Promise<ChatResponse> {
    const body = await this.request(
      'POST',
      '/v1/chat/completions',
      {
        model: request.model ?? 'sonnet',
        messages: this.buildMessages(request),
        stream: false,
      },
      request.sessionId ? { 'X-Claude-Session-ID': request.sessionId } : undefined,
    );

    return JSON.parse(body) as ChatResponse;
  }

  /**
   * Send a streaming completion request.
   * Returns an async generator that yields ChatCompletionChunks.
   */
  async *completeStream(request: ChatRequest): AsyncGenerator<ChatCompletionChunk> {
    // rawRequest() already rejects on 4xx/5xx, so the response is always
    // readable at this point — no need for an additional .readable guard.
    const response = await this.rawRequest(
      'POST',
      '/v1/chat/completions',
      {
        model: request.model ?? 'sonnet',
        messages: this.buildMessages(request),
        stream: true,
      },
      request.sessionId ? { 'X-Claude-Session-ID': request.sessionId } : undefined,
    );

    // setEncoding('utf-8') ensures chunks are strings, making this cast safe.
    response.setEncoding('utf-8');

    yield* parseSseStream(response as AsyncIterable<string>);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private buildMessages(request: ChatRequest): Array<{ role: string; content: string }> {
    return [{ role: 'user', content: request.prompt }];
  }

  /** Make an HTTP request and return the response body as a string. */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<string> {
    const res = await this.sendRequest(method, path, body, extraHeaders);

    return new Promise<string>((resolve, reject) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
  }

  /**
   * Make an HTTP request and return the raw IncomingMessage (for streaming).
   *
   * Adds an idle-based response timeout: Node's socket.setTimeout is
   * inherently idle-based — it resets on any socket activity (reads
   * or writes). Long-running streaming responses that actively produce
   * data will NOT trigger the timeout; it only fires when the socket
   * is truly idle for the full duration.
   */
  private async rawRequest(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<http.IncomingMessage> {
    const res = await this.sendRequest(method, path, body, extraHeaders);

    res.setTimeout(this.timeoutMs, () => {
      res.destroy(new Error(`Response stream timed out after ${this.timeoutMs}ms of inactivity`));
    });

    return res;
  }

  /**
   * Shared HTTP request plumbing. Sends the request, rejects on 4xx/5xx
   * errors, and resolves with the raw IncomingMessage on success.
   */
  private sendRequest(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<http.IncomingMessage> {
    return new Promise<http.IncomingMessage>((resolve, reject) => {
      const options = this.buildRequestOptions(method, path, extraHeaders);

      const req = http.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            reject(new Error(`API request failed: ${res.statusCode} ${data}`));
          });
          return;
        }

        resolve(res);
      });

      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${this.timeoutMs}ms`));
      });
      req.on('error', reject);

      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  private buildRequestOptions(
    method: string,
    path: string,
    extraHeaders?: Record<string, string>,
  ): http.RequestOptions {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'X-Claude-Code': 'true',
      'X-Request-ID': crypto.randomUUID(),
      ...extraHeaders,
    };

    if (this.socketPath) {
      return { socketPath: this.socketPath, path, method, headers, agent: this.agent };
    }

    return { hostname: this.tcpHost, port: this.tcpPort, path, method, headers, agent: this.agent };
  }

  /**
   * Clean up resources. Destroys the HTTP keep-alive agent and zeros the
   * API key in memory as a defense-in-depth measure.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.agent.destroy();
    this.apiKey = '';
  }
}
