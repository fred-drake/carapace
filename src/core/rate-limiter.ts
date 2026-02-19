/**
 * Per-session token bucket rate limiter for tool invocations.
 *
 * State lives in memory (ephemeral by design). Resets on session teardown.
 * Supports per-group configuration overrides.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Rate limiter configuration for a group or the default. */
export interface RateLimiterConfig {
  /** Maximum tool invocations per minute (sustained rate). */
  requestsPerMinute: number;
  /** Maximum burst size (token bucket capacity). */
  burstSize: number;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of a rate limit check. */
export type RateLimitResult = { allowed: true } | { allowed: false; retryAfter: number };

// ---------------------------------------------------------------------------
// Internal bucket state
// ---------------------------------------------------------------------------

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly defaultConfig: RateLimiterConfig;
  private readonly groupConfigs = new Map<string, RateLimiterConfig>();
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(config: RateLimiterConfig) {
    validateConfig(config);
    this.defaultConfig = config;
  }

  /**
   * Attempt to consume one token for a session.
   *
   * @param sessionId - The session requesting a token.
   * @param group - Optional group name for per-group config lookup.
   * @returns Whether the request is allowed, with retry_after if denied.
   */
  tryConsume(sessionId: string, group?: string): RateLimitResult {
    const config = this.getConfig(group);
    const now = Date.now();
    const bucket = this.getOrCreateBucket(sessionId, config, now);

    this.refill(bucket, config, now);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    // Calculate time until next token
    const tokensPerMs = config.requestsPerMinute / 60_000;
    const retryAfter = (1 - bucket.tokens) / tokensPerMs / 1000;

    return { allowed: false, retryAfter };
  }

  /** Set a per-group rate limit configuration. */
  setGroupConfig(group: string, config: RateLimiterConfig): void {
    validateConfig(config);
    this.groupConfigs.set(group, config);
  }

  /** Remove a per-group configuration, reverting to defaults. */
  removeGroupConfig(group: string): void {
    this.groupConfigs.delete(group);
  }

  /** Clear all rate limit state for a specific session. */
  resetSession(sessionId: string): void {
    this.buckets.delete(sessionId);
  }

  /** Clear all session state. */
  cleanup(): void {
    this.buckets.clear();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private getConfig(group?: string): RateLimiterConfig {
    if (group) {
      return this.groupConfigs.get(group) ?? this.defaultConfig;
    }
    return this.defaultConfig;
  }

  private getOrCreateBucket(
    sessionId: string,
    config: RateLimiterConfig,
    now: number,
  ): TokenBucket {
    let bucket = this.buckets.get(sessionId);
    if (!bucket) {
      bucket = {
        tokens: config.burstSize,
        lastRefill: now,
      };
      this.buckets.set(sessionId, bucket);
    }
    return bucket;
  }

  private refill(bucket: TokenBucket, config: RateLimiterConfig, now: number): void {
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;

    const tokensPerMs = config.requestsPerMinute / 60_000;
    const newTokens = elapsed * tokensPerMs;

    bucket.tokens = Math.min(bucket.tokens + newTokens, config.burstSize);
    bucket.lastRefill = now;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateConfig(config: RateLimiterConfig): void {
  if (config.requestsPerMinute <= 0) {
    throw new Error('requestsPerMinute must be positive');
  }
  if (config.burstSize <= 0) {
    throw new Error('burstSize must be positive');
  }
}
