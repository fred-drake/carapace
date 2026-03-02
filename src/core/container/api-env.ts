/**
 * Environment variable contract for claude-cli-api mode inside containers.
 *
 * Single source of truth for the env vars shared between the entrypoint
 * script and the lifecycle manager. Import this instead of hardcoding
 * env var names in multiple places.
 */

export const API_MODE_ENV = {
  /** Set to '1' to enable API server mode in entrypoint.sh. */
  CARAPACE_API_MODE: 'CARAPACE_API_MODE',
  /** Path to the file containing the API bearer token (not an env var value). */
  CARAPACE_API_KEY_FILE: 'CARAPACE_API_KEY_FILE',
  /** TCP port (Apple Containers fallback). */
  PORT: 'PORT',
  /** TCP bind address (Apple Containers fallback). */
  HOST: 'HOST',
  /** Limit to single concurrent claude process per container. */
  MAX_CONCURRENT_PROCESSES: 'MAX_CONCURRENT_PROCESSES',
} as const;
