/**
 * Plugin handler interfaces and types for Carapace.
 *
 * Defines the contract that every plugin handler must satisfy, plus
 * the result types used by PluginLoader during discovery and
 * initialization.
 */

import type { RequestEnvelope, EventEnvelope, PluginManifest } from '../types/index.js';

// ---------------------------------------------------------------------------
// CoreServices (placeholder — filled in ENG-16)
// ---------------------------------------------------------------------------

/**
 * Services provided by the core to plugins during initialization.
 * Intentionally empty until ENG-16 defines the full service surface.
 */
export interface CoreServices {}

// ---------------------------------------------------------------------------
// PluginHandler
// ---------------------------------------------------------------------------

/**
 * The host-side handler interface that every plugin must implement.
 *
 * - `initialize` is called once during plugin loading.
 * - `handleRequest` processes tool invocations from the container.
 * - `handleEvent` (optional) reacts to PUB/SUB events.
 * - `shutdown` is called during graceful teardown.
 */
export interface PluginHandler {
  initialize(services: CoreServices): Promise<void>;
  handleRequest(envelope: RequestEnvelope): Promise<Record<string, unknown>>;
  handleEvent?(envelope: EventEnvelope): Promise<void>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Init failure categories
// ---------------------------------------------------------------------------

/**
 * Categories of plugin initialization failure. Used by PluginLoadResult
 * to classify why a plugin could not be loaded.
 */
export type InitFailureCategory = 'invalid_manifest' | 'init_error' | 'timeout' | 'missing_handler';

// ---------------------------------------------------------------------------
// PluginLoadResult
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by PluginLoader for each plugin load attempt.
 */
export type PluginLoadResult =
  | { ok: true; pluginName: string; manifest: PluginManifest; handler: PluginHandler }
  | { ok: false; pluginName: string; error: string; category: InitFailureCategory };
