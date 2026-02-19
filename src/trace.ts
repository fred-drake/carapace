/**
 * Message tracing / debug mode for Carapace.
 *
 * Provides real-time visibility into the message flow through the system.
 * When debug mode is enabled (`carapace start --debug`), all messages are
 * pretty-printed with timestamps, credential data is redacted, and output
 * can be filtered by topic or plugin.
 *
 * Uses the same credential patterns as the response sanitizer for
 * defense-in-depth redaction.
 */

import { ResponseSanitizer, REDACTED_PLACEHOLDER } from './core/response-sanitizer.js';
import type { WireMessage, RequestEnvelope, ResponseEnvelope } from './types/protocol.js';

// ---------------------------------------------------------------------------
// Trace event types
// ---------------------------------------------------------------------------

/** All trace event types emitted by the tracer. */
export type TraceEventType =
  | 'wire_received'
  | 'envelope_constructed'
  | 'stage_passed'
  | 'stage_rejected'
  | 'dispatched'
  | 'response_sent';

/** A structured trace event for formatting and output. */
export interface TraceEvent {
  type: TraceEventType;
  timestamp: string;
  topic: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/** Optional filters to narrow trace output. */
export interface TraceFilter {
  /** Topic patterns to include. Supports trailing `*` wildcard. */
  topics?: string[];
  /** Plugin names to include. Extracted from `tool.invoke.<plugin>.*` topics. */
  plugins?: string[];
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Injectable dependencies for the MessageTracer. */
export interface TracerDeps {
  /** Output function (e.g. process.stderr.write or console.error). */
  output: (line: string) => void;
  /** Clock function returning ISO timestamps. */
  now: () => string;
}

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
} as const;

const EVENT_COLORS: Record<TraceEventType, string> = {
  wire_received: ANSI.cyan,
  envelope_constructed: ANSI.blue,
  stage_passed: ANSI.green,
  stage_rejected: ANSI.red,
  dispatched: ANSI.magenta,
  response_sent: ANSI.yellow,
};

// ---------------------------------------------------------------------------
// formatTraceEvent
// ---------------------------------------------------------------------------

/**
 * Format a TraceEvent into a pretty-printed, human-readable string.
 *
 * Output format:
 *   [HH:MM:SS.mmm] EVENT_TYPE  topic
 *     { data... }
 */
export function formatTraceEvent(event: TraceEvent): string {
  const time = extractTime(event.timestamp);
  const color = EVENT_COLORS[event.type];
  const label = `${color}${event.type}${ANSI.reset}`;
  const topicStr = `${ANSI.dim}${event.topic}${ANSI.reset}`;

  const lines: string[] = [];
  lines.push(`[${time}] ${label}  ${topicStr}`);

  // Add specific info for certain event types
  if (event.type === 'stage_rejected') {
    const code = event.data.code ?? 'UNKNOWN';
    const message = event.data.message ?? '';
    lines.push(`  ${ANSI.red}ERROR${ANSI.reset} ${code}: ${message}`);
  } else if (event.type === 'response_sent') {
    if (event.data.hasError) {
      const errorCode = event.data.errorCode ?? 'UNKNOWN';
      lines.push(`  ${ANSI.red}ERROR${ANSI.reset} ${errorCode}`);
    } else {
      lines.push(`  ${ANSI.green}OK${ANSI.reset}`);
    }
  }

  // Pretty-print data
  const dataStr = JSON.stringify(event.data, null, 2);
  const indented = dataStr
    .split('\n')
    .map((line) => `  ${ANSI.dim}${line}${ANSI.reset}`)
    .join('\n');
  lines.push(indented);

  return lines.join('\n');
}

/** Extract HH:MM:SS.mmm from an ISO timestamp. */
function extractTime(iso: string): string {
  // Handle both full ISO strings and time-only strings
  const match = iso.match(/(\d{2}:\d{2}:\d{2}\.\d{3})/);
  return match ? match[1] : iso;
}

// ---------------------------------------------------------------------------
// MessageTracer
// ---------------------------------------------------------------------------

export class MessageTracer {
  private readonly deps: TracerDeps;
  private readonly filter: TraceFilter;
  private readonly sanitizer: ResponseSanitizer;
  private enabled: boolean;

  constructor(deps: TracerDeps, filter?: TraceFilter) {
    this.deps = deps;
    this.filter = filter ?? {};
    this.sanitizer = new ResponseSanitizer();
    this.enabled = true;
  }

  /** Enable or disable trace output. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Trace an incoming wire message from the container. */
  traceWireReceived(wire: WireMessage): void {
    if (!this.shouldTrace(wire.topic)) return;

    const sanitized = this.sanitizer.sanitize(wire.arguments);
    this.emit({
      type: 'wire_received',
      timestamp: this.deps.now(),
      topic: wire.topic,
      data: {
        correlation: wire.correlation,
        arguments: sanitized.value,
      },
    });
  }

  /** Trace an envelope constructed from a wire message. */
  traceEnvelopeConstructed(envelope: RequestEnvelope): void {
    if (!this.shouldTrace(envelope.topic)) return;

    this.emit({
      type: 'envelope_constructed',
      timestamp: this.deps.now(),
      topic: envelope.topic,
      data: {
        id: envelope.id,
        source: envelope.source,
        correlation: envelope.correlation,
        group: envelope.group,
      },
    });
  }

  /** Trace a pipeline stage that passed. */
  traceStagePassed(stageName: string, topic: string): void {
    if (!this.shouldTrace(topic)) return;

    this.emit({
      type: 'stage_passed',
      timestamp: this.deps.now(),
      topic,
      data: { stage: stageName },
    });
  }

  /** Trace a pipeline stage that rejected the message. */
  traceStageRejected(stageName: string, errorCode: string, errorMessage: string): void {
    this.emit({
      type: 'stage_rejected',
      timestamp: this.deps.now(),
      topic: '',
      data: {
        stage: stageName,
        code: errorCode,
        message: errorMessage,
      },
    });
  }

  /** Trace a message being dispatched to a plugin handler. */
  traceDispatched(toolName: string, correlation: string): void {
    const topic = `tool.invoke.${toolName}`;
    if (!this.shouldTrace(topic, toolName)) return;

    this.emit({
      type: 'dispatched',
      timestamp: this.deps.now(),
      topic,
      data: { tool: toolName, correlation },
    });
  }

  /** Trace a response being sent back. */
  traceResponseSent(response: ResponseEnvelope): void {
    if (!this.shouldTrace(response.topic)) return;

    const sanitized = this.sanitizer.sanitize(response.payload);
    const hasError = response.payload.error !== null;

    this.emit({
      type: 'response_sent',
      timestamp: this.deps.now(),
      topic: response.topic,
      data: {
        correlation: response.correlation,
        hasError,
        ...(hasError && response.payload.error ? { errorCode: response.payload.error.code } : {}),
        payload: sanitized.value,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private emit(event: TraceEvent): void {
    if (!this.enabled) return;
    this.deps.output(formatTraceEvent(event));
  }

  /**
   * Check if a trace event should be emitted based on the configured filter.
   *
   * When both topic and plugin filters are set, BOTH must match (AND logic).
   * When only one filter is set, just that filter must match.
   * When no filters are set, all events pass through.
   */
  private shouldTrace(topic: string, toolName?: string): boolean {
    if (!this.enabled) return false;

    const topicMatch = this.matchesTopic(topic);
    const pluginMatch = this.matchesPlugin(topic, toolName);

    return topicMatch && pluginMatch;
  }

  private matchesTopic(topic: string): boolean {
    if (!this.filter.topics || this.filter.topics.length === 0) return true;

    return this.filter.topics.some((pattern) => {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        return topic.startsWith(prefix);
      }
      return topic === pattern;
    });
  }

  private matchesPlugin(topic: string, toolName?: string): boolean {
    if (!this.filter.plugins || this.filter.plugins.length === 0) return true;

    // Extract plugin name from tool name or topic
    const name = toolName ?? this.extractPluginName(topic);
    if (!name) return true; // Non-tool events pass through plugin filter

    const pluginName = name.split('.')[0];
    return this.filter.plugins.includes(pluginName);
  }

  /** Extract plugin name from a tool.invoke.* topic. */
  private extractPluginName(topic: string): string | null {
    const prefix = 'tool.invoke.';
    if (!topic.startsWith(prefix)) return null;
    return topic.slice(prefix.length);
  }
}
