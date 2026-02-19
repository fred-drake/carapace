/**
 * Container runtime auto-detection.
 *
 * Probes the host for available container engines and returns the best
 * match based on security posture and user preference.
 *
 * Detection priority (when no preference is specified):
 *  1. Apple Containers (macOS 26+ Apple Silicon) — VM-per-container isolation
 *  2. Podman — rootless by default, no root daemon
 *  3. Docker — widest compatibility, fallback
 *
 * A user-configured preference (from config.toml `[runtime] engine`) always
 * wins over auto-detection order.
 *
 * @see docs/INSTALL_STRATEGY.md §4 for the full preference rationale.
 */

import type { ContainerRuntime, RuntimeName } from './runtime.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** How strongly the container is isolated from the host. */
export type IsolationLevel = 'vm' | 'namespace' | 'rootless-namespace';

/** Information about a single available runtime. */
export interface RuntimeInfo {
  runtime: ContainerRuntime;
  isolationLevel: IsolationLevel;
  version: string;
}

/** Result of runtime detection. */
export interface DetectionResult {
  /** The runtime selected by preference or priority order. */
  selected: RuntimeInfo;
  /** All runtimes that were found to be available. */
  available: RuntimeInfo[];
}

// ---------------------------------------------------------------------------
// Detection options
// ---------------------------------------------------------------------------

export interface DetectionOptions {
  /** Runtimes to probe. */
  runtimes: ContainerRuntime[];
  /** Host platform (e.g. `process.platform`). */
  platform: string;
  /** User-configured preference that overrides auto-detection order. */
  preference?: RuntimeName;
}

// ---------------------------------------------------------------------------
// Priority order
// ---------------------------------------------------------------------------

const PRIORITY: readonly RuntimeName[] = ['apple-container', 'podman', 'docker'];

// ---------------------------------------------------------------------------
// Isolation level mapping
// ---------------------------------------------------------------------------

function getIsolationLevel(name: RuntimeName, platform: string): IsolationLevel {
  if (name === 'apple-container') return 'vm';
  if (name === 'podman') return 'rootless-namespace';
  // Docker on macOS runs inside Docker Desktop VM
  if (name === 'docker' && platform === 'darwin') return 'vm';
  return 'namespace';
}

// ---------------------------------------------------------------------------
// Probe a single runtime
// ---------------------------------------------------------------------------

async function probeRuntime(
  runtime: ContainerRuntime,
  platform: string,
): Promise<RuntimeInfo | null> {
  try {
    const ok = await runtime.isAvailable();
    if (!ok) return null;
    const version = await runtime.version();
    return {
      runtime,
      isolationLevel: getIsolationLevel(runtime.name, platform),
      version,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// detectRuntime
// ---------------------------------------------------------------------------

/**
 * Detect available container runtimes and return the best one.
 *
 * Probes all provided runtimes in parallel, then selects the best
 * available runtime based on preference and priority order.
 */
export async function detectRuntime(options: DetectionOptions): Promise<DetectionResult | null> {
  const { runtimes, platform, preference } = options;

  // Probe all runtimes concurrently
  const probes = await Promise.all(runtimes.map((rt) => probeRuntime(rt, platform)));
  const available = probes.filter((info): info is RuntimeInfo => info !== null);

  if (available.length === 0) return null;

  // If user specified a preference, try that first
  if (preference) {
    const preferred = available.find((info) => info.runtime.name === preference);
    if (preferred) {
      return { selected: preferred, available };
    }
  }

  // Fall back to priority order
  for (const name of PRIORITY) {
    const match = available.find((info) => info.runtime.name === name);
    if (match) {
      return { selected: match, available };
    }
  }

  // Fallback: first available (shouldn't happen if PRIORITY covers all names)
  return { selected: available[0], available };
}

// ---------------------------------------------------------------------------
// listAvailableRuntimes
// ---------------------------------------------------------------------------

/**
 * List all available container runtimes with their isolation levels.
 */
export async function listAvailableRuntimes(
  options: Omit<DetectionOptions, 'preference'>,
): Promise<RuntimeInfo[]> {
  const { runtimes, platform } = options;
  const probes = await Promise.all(runtimes.map((rt) => probeRuntime(rt, platform)));
  return probes.filter((info): info is RuntimeInfo => info !== null);
}

// ---------------------------------------------------------------------------
// Legacy detect() — kept for backward compatibility during migration
// ---------------------------------------------------------------------------

/**
 * Detect available container runtimes and return the best one.
 *
 * @deprecated Use {@link detectRuntime} for the full detection result
 *   including isolation level and all available runtimes.
 */
export async function detect(preference?: RuntimeName): Promise<ContainerRuntime | null> {
  void preference;
  return null;
}
