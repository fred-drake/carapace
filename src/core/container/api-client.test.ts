import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { ContainerApiClient } from './api-client.js';
import type { ApiClientOptions } from './api-client.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContainerApiClient', () => {
  describe('constructor', () => {
    it('requires either socketPath or tcpAddress', () => {
      expect(() => new ContainerApiClient({ apiKey: 'test' })).toThrow(
        'ContainerApiClient requires either socketPath or tcpAddress',
      );
    });

    it('accepts socketPath', () => {
      const client = new ContainerApiClient({
        socketPath: '/tmp/test.sock',
        apiKey: 'test',
      });
      expect(client).toBeDefined();
    });

    it('accepts tcpAddress', () => {
      const client = new ContainerApiClient({
        tcpAddress: '127.0.0.1:3456',
        apiKey: 'test',
      });
      expect(client).toBeDefined();
    });

    it('rejects tcpAddress with port 0', () => {
      expect(() => new ContainerApiClient({ tcpAddress: '127.0.0.1:0', apiKey: 'test' })).toThrow(
        'Invalid tcpAddress port',
      );
    });

    it('rejects tcpAddress with negative port', () => {
      expect(() => new ContainerApiClient({ tcpAddress: '127.0.0.1:-1', apiKey: 'test' })).toThrow(
        'Invalid tcpAddress port',
      );
    });

    it('rejects tcpAddress with port above 65535', () => {
      expect(
        () => new ContainerApiClient({ tcpAddress: '127.0.0.1:70000', apiKey: 'test' }),
      ).toThrow('Invalid tcpAddress port');
    });

    it('rejects tcpAddress with non-numeric port', () => {
      expect(() => new ContainerApiClient({ tcpAddress: '127.0.0.1:abc', apiKey: 'test' })).toThrow(
        'Invalid tcpAddress port',
      );
    });

    it('rejects tcpAddress without colon separator', () => {
      expect(() => new ContainerApiClient({ tcpAddress: 'localhost', apiKey: 'test' })).toThrow(
        'Invalid tcpAddress format',
      );
    });

    it('rejects tcpAddress with empty host', () => {
      expect(() => new ContainerApiClient({ tcpAddress: ':3456', apiKey: 'test' })).toThrow(
        'Invalid tcpAddress host',
      );
    });

    it('parses IPv6 tcpAddress correctly using last colon', () => {
      const client = new ContainerApiClient({
        tcpAddress: '[::1]:3456',
        apiKey: 'test',
      });
      expect(client).toBeDefined();
    });
  });

  describe('health', () => {
    let server: http.Server;
    let port: number;
    let client: ContainerApiClient;

    afterEach(async () => {
      if (client) client.close();
      if (server) await closeServer(server);
    });

    it('returns health status from the server', async () => {
      ({ server, port } = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      }));

      client = new ContainerApiClient({
        tcpAddress: `127.0.0.1:${port}`,
        apiKey: 'test-key',
      });

      const result = await client.health();
      expect(result.status).toBe('ok');
    });

    it('rejects on HTTP error', async () => {
      ({ server, port } = await createMockServer((_req, res) => {
        res.writeHead(500);
        res.end('Internal Server Error');
      }));

      client = new ContainerApiClient({
        tcpAddress: `127.0.0.1:${port}`,
        apiKey: 'test-key',
      });

      await expect(client.health()).rejects.toThrow('API request failed: 500');
    });
  });

  describe('waitForReady', () => {
    let server: http.Server;
    let port: number;
    let client: ContainerApiClient;

    afterEach(async () => {
      if (client) client.close();
      if (server) await closeServer(server);
    });

    it('resolves when health check succeeds', async () => {
      ({ server, port } = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      }));

      client = new ContainerApiClient({
        tcpAddress: `127.0.0.1:${port}`,
        apiKey: 'test-key',
      });

      await expect(client.waitForReady(5000, 50)).resolves.toBeUndefined();
    });

    it('rejects on timeout', async () => {
      // Server that always returns 503
      ({ server, port } = await createMockServer((_req, res) => {
        res.writeHead(503);
        res.end('Not ready');
      }));

      client = new ContainerApiClient({
        tcpAddress: `127.0.0.1:${port}`,
        apiKey: 'test-key',
      });

      await expect(client.waitForReady(200, 50)).rejects.toThrow(
        'claude-cli-api server did not become ready within 200ms',
      );
    });

    it('rejects immediately when container is dead (no grace period)', async () => {
      // Allocate a port then close it — guarantees nothing is listening
      const freePort = await new Promise<number>((resolve) => {
        const srv = createNetServer();
        srv.listen(0, '127.0.0.1', () => {
          const p = (srv.address() as { port: number }).port;
          srv.close(() => resolve(p));
        });
      });

      client = new ContainerApiClient({
        tcpAddress: `127.0.0.1:${freePort}`,
        apiKey: 'test-key',
      });

      const isAlive = vi.fn().mockResolvedValue(false);

      // graceMs=0 disables the startup grace period for fast failure
      await expect(client.waitForReady(5000, 50, isAlive, 0)).rejects.toThrow(
        'Container exited before API server started',
      );
    });

    it('waits for server to become ready (initially failing)', async () => {
      let requestCount = 0;
      ({ server, port } = await createMockServer((_req, res) => {
        requestCount++;
        if (requestCount < 3) {
          res.writeHead(503);
          res.end('Not ready');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        }
      }));

      client = new ContainerApiClient({
        tcpAddress: `127.0.0.1:${port}`,
        apiKey: 'test-key',
      });

      await expect(client.waitForReady(5000, 50)).resolves.toBeUndefined();
      expect(requestCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe('complete', () => {
    let server: http.Server;
    let port: number;
    let client: ContainerApiClient;

    afterEach(async () => {
      if (client) client.close();
      if (server) await closeServer(server);
    });

    it('sends a non-streaming completion request', async () => {
      let receivedBody = '';
      let receivedHeaders: http.IncomingHttpHeaders = {};

      ({ server, port } = await createMockServer((req, res) => {
        receivedHeaders = req.headers;
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          receivedBody = body;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'resp-1',
              object: 'chat.completion',
              created: 1700000000,
              model: 'sonnet',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Hello!' },
                  finish_reason: 'stop',
                },
              ],
            }),
          );
        });
      }));

      client = new ContainerApiClient({
        tcpAddress: `127.0.0.1:${port}`,
        apiKey: 'my-key',
      });

      const result = await client.complete({ prompt: 'Say hello' });

      expect(result.choices[0]!.message.content).toBe('Hello!');
      expect(receivedHeaders['authorization']).toBe('Bearer my-key');
      expect(receivedHeaders['x-claude-code']).toBe('true');

      const parsed = JSON.parse(receivedBody);
      expect(parsed.stream).toBe(false);
      expect(parsed.messages[0].content).toBe('Say hello');
    });

    it('sends custom model when specified in request', async () => {
      let receivedBody = '';

      ({ server, port } = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          receivedBody = body;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'resp-1',
              object: 'chat.completion',
              created: 1700000000,
              model: 'opus',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Hi' },
                  finish_reason: 'stop',
                },
              ],
            }),
          );
        });
      }));

      client = new ContainerApiClient({
        tcpAddress: `127.0.0.1:${port}`,
        apiKey: 'key',
      });

      await client.complete({ prompt: 'test', model: 'opus' });
      const parsed = JSON.parse(receivedBody);
      expect(parsed.model).toBe('opus');
    });

    it('passes session ID header when provided', async () => {
      let receivedHeaders: http.IncomingHttpHeaders = {};

      ({ server, port } = await createMockServer((req, res) => {
        receivedHeaders = req.headers;
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'resp-1',
              object: 'chat.completion',
              created: 1700000000,
              model: 'sonnet',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
              ],
            }),
          );
        });
      }));

      client = new ContainerApiClient({
        tcpAddress: `127.0.0.1:${port}`,
        apiKey: 'key',
      });

      await client.complete({ prompt: 'test', sessionId: 'sess-123' });
      expect(receivedHeaders['x-claude-session-id']).toBe('sess-123');
    });
  });

  describe('close', () => {
    it('can be called without error (no-op stub)', () => {
      const client = new ContainerApiClient({
        socketPath: '/tmp/test.sock',
        apiKey: 'test',
      });
      expect(() => client.close()).not.toThrow();
    });
  });

  describe('completeStream', () => {
    let server: http.Server;
    let port: number;
    let client: ContainerApiClient;

    afterEach(async () => {
      if (client) client.close();
      if (server) await closeServer(server);
    });

    it('streams ChatCompletionChunks from SSE response', async () => {
      ({ server, port } = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });

          res.write(
            'data: ' +
              JSON.stringify({
                id: 'c1',
                object: 'chat.completion.chunk',
                created: 1700000000,
                model: 'sonnet',
                choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
              }) +
              '\n\n',
          );

          res.write(
            'data: ' +
              JSON.stringify({
                id: 'c1',
                object: 'chat.completion.chunk',
                created: 1700000000,
                model: 'sonnet',
                choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
              }) +
              '\n\n',
          );

          res.write(
            'data: ' +
              JSON.stringify({
                id: 'c1',
                object: 'chat.completion.chunk',
                created: 1700000000,
                model: 'sonnet',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              }) +
              '\n\n',
          );

          res.write('data: [DONE]\n\n');
          res.end();
        });
      }));

      client = new ContainerApiClient({
        tcpAddress: `127.0.0.1:${port}`,
        apiKey: 'key',
      });

      const chunks: import('./sse-parser.js').ChatCompletionChunk[] = [];
      for await (const chunk of client.completeStream({ prompt: 'test' })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0]!.choices[0]!.delta.content).toBe('Hello');
      expect(chunks[1]!.choices[0]!.delta.content).toBe(' world');
      expect(chunks[2]!.choices[0]!.finish_reason).toBe('stop');
    });

    it('rejects on HTTP error in streaming mode', async () => {
      ({ server, port } = await createMockServer((_req, res) => {
        res.writeHead(401);
        res.end('Unauthorized');
      }));

      client = new ContainerApiClient({
        tcpAddress: `127.0.0.1:${port}`,
        apiKey: 'bad-key',
      });

      const gen = client.completeStream({ prompt: 'test' });
      await expect(gen.next()).rejects.toThrow('API request failed: 401');
    });
  });
});
