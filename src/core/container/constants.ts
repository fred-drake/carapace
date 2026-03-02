/**
 * Shared constants for container infrastructure.
 *
 * Centralizes magic values that appear in multiple modules
 * (lifecycle manager, entrypoint, API client) to prevent drift.
 */

/** Apple Container VM gateway IP for host-reachable addresses. */
export const APPLE_CONTAINER_GATEWAY_IP = '192.168.64.1';

/** Container-side directory for the HTTP API socket and key file. */
export const CONTAINER_API_DIR = '/run/api';

/** Default TCP port for claude-cli-api inside the container. */
export const CONTAINER_API_PORT = 3456;

/**
 * Zero-value timestamp returned by Docker/Podman/Apple Containers
 * for unset date fields (StartedAt, FinishedAt).
 */
export const CONTAINER_ZERO_TIME = '0001-01-01T00:00:00Z';
