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

/**
 * Detect available container runtimes and return the best one.
 *
 * @param preference - Optional user-configured runtime preference that
 *   overrides auto-detection order. If the preferred runtime is not
 *   available, detection falls back to the default priority.
 * @returns The best available {@link ContainerRuntime}, or `null` if no
 *   supported container engine is found.
 */
export async function detect(preference?: RuntimeName): Promise<ContainerRuntime | null> {
  // Stub: adapter implementations (DEVOPS-03) will populate this.
  // Each adapter's isAvailable() is probed in priority order.
  void preference;
  return null;
}
