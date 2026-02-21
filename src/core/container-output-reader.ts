/**
 * ContainerOutputReader — bridges container stdout → StreamParser → EventBus.
 *
 * Reads streaming JSON output from a container's stdout line-by-line,
 * parses each line through StreamParser, constructs EventEnvelopes with
 * core-owned identity fields, and publishes them on the EventBus.
 *
 * Also extracts and persists Claude session IDs from response.system
 * and response.end events for --resume support.
 */

import { createInterface } from 'readline';
import { StreamParser } from './stream-parser.js';
import { PROTOCOL_VERSION } from '../types/protocol.js';
import type { EventEnvelope } from '../types/protocol.js';
import type { SystemEventPayload, EndEventPayload } from '../types/protocol.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerOutputReaderDeps {
  eventBus: { publish(envelope: EventEnvelope): Promise<void> };
  claudeSessionStore: { save(group: string, claudeSessionId: string): void };
  logger?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  /** Optional response sanitizer for defense-in-depth credential redaction on response.* events. */
  sanitizer?: { sanitize(value: unknown): { value: unknown; redactedPaths: string[] } };
}

export interface OutputSession {
  sessionId: string;
  group: string;
  containerId: string;
}

// ---------------------------------------------------------------------------
// ContainerOutputReader
// ---------------------------------------------------------------------------

export class ContainerOutputReader {
  private readonly deps: ContainerOutputReaderDeps;

  constructor(deps: ContainerOutputReaderDeps) {
    this.deps = deps;
  }

  /**
   * Start reading a container's stdout and publishing events.
   * Runs until the stream ends (container exits).
   * Fire-and-forget — caller does not need to await.
   */
  async start(stdout: NodeJS.ReadableStream, session: OutputSession): Promise<void> {
    const parser = new StreamParser();
    const rl = createInterface({ input: stdout });

    for await (const line of rl) {
      const event = parser.parseLine(line);
      if (!event) continue;

      // Apply response sanitizer if available (defense-in-depth credential redaction)
      const rawPayload = { ...event.payload };
      const payload = this.deps.sanitizer
        ? (this.deps.sanitizer.sanitize(rawPayload).value as Record<string, unknown>)
        : rawPayload;

      const envelope: EventEnvelope = {
        id: crypto.randomUUID(),
        version: PROTOCOL_VERSION,
        type: 'event',
        topic: event.topic,
        source: session.containerId,
        correlation: null,
        timestamp: new Date().toISOString(),
        group: session.group,
        payload,
      };

      await this.deps.eventBus.publish(envelope);

      // Extract and persist Claude session ID from system/end events
      if (event.topic === 'response.system' || event.topic === 'response.end') {
        const payload = event.payload as SystemEventPayload | EndEventPayload;
        if (payload.claudeSessionId) {
          this.deps.claudeSessionStore.save(session.group, payload.claudeSessionId);
        }
      }
    }
  }
}
