/**
 * Carapace message protocol types.
 *
 * Defines the wire format (container → host) and the full envelope
 * (used internally on both ZeroMQ channels). See docs/ARCHITECTURE.md
 * for the protocol specification.
 */

import type { ErrorPayload } from './errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current protocol version. Validated on every message by the core. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * The three fields the container sends across the trust boundary.
 * Zero overlap with ENVELOPE_IDENTITY_FIELDS — one owner per field.
 */
export const WIRE_FIELDS = ['topic', 'correlation', 'arguments'] as const;

/**
 * Fields the core constructs from trusted session state.
 * Never present on the wire; never writable by the container.
 */
export const ENVELOPE_IDENTITY_FIELDS = [
  'id',
  'version',
  'type',
  'source',
  'group',
  'timestamp',
] as const;

// ---------------------------------------------------------------------------
// Topic hierarchy
// ---------------------------------------------------------------------------

/**
 * All valid topic strings in the protocol.
 *
 * Fixed topics map 1:1 to the hierarchy in ARCHITECTURE.md.
 * `tool.invoke.${string}` is a template literal covering every
 * plugin-declared tool name.
 */
export type Topic =
  | 'message.inbound'
  | 'agent.started'
  | 'agent.completed'
  | 'agent.error'
  | 'task.created'
  | 'task.triggered'
  | 'plugin.ready'
  | 'plugin.stopping'
  | `tool.invoke.${string}`;

// ---------------------------------------------------------------------------
// Message type discriminator
// ---------------------------------------------------------------------------

/** The three message types carried by the envelope. */
export type MessageType = 'event' | 'request' | 'response';

// ---------------------------------------------------------------------------
// Wire format (container → host)
// ---------------------------------------------------------------------------

/**
 * Minimal wire message sent by the `ipc` binary across the trust boundary.
 * Contains only fields owned by the container; the core adds everything else.
 */
export interface WireMessage {
  topic: string;
  correlation: string;
  arguments: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Envelope (internal, both channels)
// ---------------------------------------------------------------------------

/**
 * Base envelope shared by all message types. The core constructs this from
 * the wire message + trusted session state.
 *
 * @typeParam T - The message type discriminator.
 * @typeParam P - The shape of the payload.
 */
export interface BaseEnvelope<T extends MessageType, P> {
  id: string;
  version: number;
  type: T;
  topic: string;
  source: string;
  correlation: string | null;
  timestamp: string;
  group: string;
  payload: P;
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

/** Payload for event envelopes (PUB/SUB channel). */
export type EventPayload = Record<string, unknown>;

/** Payload for request envelopes (ROUTER/DEALER channel). */
export type RequestPayload = { arguments: Record<string, unknown> };

/** Payload for response envelopes (ROUTER/DEALER channel). */
export type ResponsePayload = { result: unknown; error: ErrorPayload | null };

// ---------------------------------------------------------------------------
// Concrete envelope types
// ---------------------------------------------------------------------------

/** An event envelope. Correlation may or may not be present. */
export type EventEnvelope = BaseEnvelope<'event', EventPayload>;

/**
 * A request envelope. Correlation is always present (non-null) because
 * every request expects a matched response.
 */
export type RequestEnvelope = BaseEnvelope<'request', RequestPayload> & {
  correlation: string;
};

/**
 * A response envelope. Correlation is always present (non-null) because
 * it must reference the originating request.
 */
export type ResponseEnvelope = BaseEnvelope<'response', ResponsePayload> & {
  correlation: string;
};

/** Discriminated union of all envelope types. */
export type Envelope = EventEnvelope | RequestEnvelope | ResponseEnvelope;
