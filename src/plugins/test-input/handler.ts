/**
 * Test input plugin handler for Carapace.
 *
 * Provides a programmatic API for injecting prompts into the system
 * and capturing agent responses. Designed for e2e and integration testing.
 *
 * Public API beyond PluginHandler:
 * - `submit(prompt, options?)` — inject a prompt, returns correlation ID
 * - `waitForResponse(correlationId, timeout?)` — block until agent responds
 * - `getResponses(correlationId?)` — retrieve captured responses
 * - `reset()` — clear all state for test isolation
 */

import { randomUUID } from 'node:crypto';
import type {
  PluginHandler,
  ChannelServices,
  PluginContext,
  ToolInvocationResult,
} from '../../core/plugin-handler.js';
import type { EventEnvelope } from '../../types/protocol.js';
import { ErrorCode } from '../../types/errors.js';

// ---------------------------------------------------------------------------
// Response record
// ---------------------------------------------------------------------------

export interface CapturedResponse {
  correlationId: string;
  body: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Waiter (pending waitForResponse calls)
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: (response: CapturedResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// TestInputHandler
// ---------------------------------------------------------------------------

export class TestInputHandler implements PluginHandler {
  private services: ChannelServices | null = null;
  private responses: CapturedResponse[] = [];
  private waiters: Map<string, Waiter> = new Map();
  private defaultGroup = 'test';

  async initialize(services: ChannelServices): Promise<void> {
    this.services = services;
  }

  async handleToolInvocation(
    tool: string,
    args: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ToolInvocationResult> {
    if (tool !== 'test_respond') {
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Unknown tool: "${tool}"`,
          retriable: false,
        },
      };
    }

    const body = args['body'] as string;
    const response: CapturedResponse = {
      correlationId: context.correlationId,
      body,
      timestamp: new Date().toISOString(),
    };

    this.responses.push(response);

    // Resolve any pending waiter for this correlation
    const waiter = this.waiters.get(context.correlationId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(context.correlationId);
      waiter.resolve(response);
    }

    return {
      ok: true,
      result: { captured: true, correlationId: context.correlationId },
    };
  }

  async handleEvent(envelope: EventEnvelope): Promise<void> {
    const correlationId = envelope.correlation;
    if (!correlationId) return;

    const waiter = this.waiters.get(correlationId);
    if (!waiter) return;

    if (envelope.topic === 'agent.completed') {
      // Agent finished — if there's still a waiter, it means no test_respond was called.
      // Check if we already have a response for this correlation.
      const hasResponse = this.responses.some((r) => r.correlationId === correlationId);
      if (!hasResponse) {
        clearTimeout(waiter.timer);
        this.waiters.delete(correlationId);
        waiter.resolve({
          correlationId,
          body: '',
          timestamp: new Date().toISOString(),
        });
      }
    } else if (envelope.topic === 'agent.error') {
      clearTimeout(waiter.timer);
      this.waiters.delete(correlationId);
      const errorMsg =
        typeof envelope.payload?.['error'] === 'string' ? envelope.payload['error'] : 'Agent error';
      waiter.reject(new Error(errorMsg));
    }
  }

  async shutdown(): Promise<void> {
    // Reject all pending waiters
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Handler shutting down'));
      this.waiters.delete(id);
    }
    this.services = null;
  }

  // -------------------------------------------------------------------------
  // Public test API
  // -------------------------------------------------------------------------

  /**
   * Submit a prompt to the system via the test-input channel.
   * Returns a correlation ID that can be used with `waitForResponse()`.
   */
  async submit(prompt: string, options?: { group?: string }): Promise<string> {
    if (!this.services) {
      throw new Error('Handler not initialized');
    }

    const correlationId = randomUUID();
    const group = options?.group ?? this.defaultGroup;

    await this.services.publishEvent({
      topic: 'message.inbound',
      source: 'test-input',
      group,
      payload: {
        channel: 'test-input',
        sender: 'test-harness',
        content_type: 'text',
        body: prompt,
        metadata: { correlationId },
      },
    });

    return correlationId;
  }

  /**
   * Wait for a response to the given correlation ID.
   * Resolves when the agent calls `test_respond` or `agent.completed` fires.
   * Rejects on timeout or `agent.error`.
   */
  waitForResponse(correlationId: string, timeout = 30_000): Promise<CapturedResponse> {
    // Check if we already have a response
    const existing = this.responses.find((r) => r.correlationId === correlationId);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise<CapturedResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(correlationId);
        reject(new Error(`waitForResponse timed out after ${timeout}ms`));
      }, timeout);

      this.waiters.set(correlationId, { resolve, reject, timer });
    });
  }

  /**
   * Get all captured responses, optionally filtered by correlation ID.
   */
  getResponses(correlationId?: string): CapturedResponse[] {
    if (correlationId) {
      return this.responses.filter((r) => r.correlationId === correlationId);
    }
    return [...this.responses];
  }

  /**
   * Clear all state for test isolation.
   */
  reset(): void {
    this.responses = [];
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Handler reset'));
      this.waiters.delete(id);
    }
  }
}

export default new TestInputHandler();
