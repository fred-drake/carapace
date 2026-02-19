import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter } from './rate-limiter.js';
import type { RateLimiterConfig } from './rate-limiter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultConfig(overrides?: Partial<RateLimiterConfig>): RateLimiterConfig {
  return {
    requestsPerMinute: 60,
    burstSize: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter(defaultConfig());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  describe('construction', () => {
    it('creates a rate limiter with default config', () => {
      expect(limiter).toBeInstanceOf(RateLimiter);
    });

    it('rejects zero requestsPerMinute', () => {
      expect(() => new RateLimiter(defaultConfig({ requestsPerMinute: 0 }))).toThrow(
        /requestsPerMinute must be positive/,
      );
    });

    it('rejects negative requestsPerMinute', () => {
      expect(() => new RateLimiter(defaultConfig({ requestsPerMinute: -1 }))).toThrow(
        /requestsPerMinute must be positive/,
      );
    });

    it('rejects zero burstSize', () => {
      expect(() => new RateLimiter(defaultConfig({ burstSize: 0 }))).toThrow(
        /burstSize must be positive/,
      );
    });

    it('rejects negative burstSize', () => {
      expect(() => new RateLimiter(defaultConfig({ burstSize: -1 }))).toThrow(
        /burstSize must be positive/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Basic allow/deny
  // -----------------------------------------------------------------------

  describe('tryConsume', () => {
    it('allows requests within the burst limit', () => {
      const result = limiter.tryConsume('session-1');
      expect(result.allowed).toBe(true);
    });

    it('allows burst-many requests in quick succession', () => {
      for (let i = 0; i < 10; i++) {
        const result = limiter.tryConsume('session-1');
        expect(result.allowed).toBe(true);
      }
    });

    it('denies requests that exceed the burst limit', () => {
      // Exhaust the burst
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume('session-1');
      }

      const result = limiter.tryConsume('session-1');
      expect(result.allowed).toBe(false);
    });

    it('returns retry_after when denied', () => {
      // Exhaust the burst
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume('session-1');
      }

      const result = limiter.tryConsume('session-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.retryAfter).toBeGreaterThan(0);
      }
    });

    it('retry_after reflects time until next token', () => {
      // 60 requests/min = 1 token/second
      // Exhaust burst of 10
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume('session-1');
      }

      const result = limiter.tryConsume('session-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        // Should be ~1 second (time for one token refill at 60/min)
        expect(result.retryAfter).toBeCloseTo(1, 1);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Token refill over time
  // -----------------------------------------------------------------------

  describe('token refill', () => {
    it('refills tokens over time', () => {
      // Exhaust the burst (10 tokens)
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume('session-1');
      }

      // Should be denied now
      expect(limiter.tryConsume('session-1').allowed).toBe(false);

      // Advance 1 second (1 token at 60/min = 1/sec)
      vi.advanceTimersByTime(1000);

      // Should be allowed again (1 token refilled)
      expect(limiter.tryConsume('session-1').allowed).toBe(true);
    });

    it('refills multiple tokens over longer periods', () => {
      // Exhaust the burst
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume('session-1');
      }

      // Advance 5 seconds → 5 tokens refilled
      vi.advanceTimersByTime(5000);

      for (let i = 0; i < 5; i++) {
        expect(limiter.tryConsume('session-1').allowed).toBe(true);
      }
      expect(limiter.tryConsume('session-1').allowed).toBe(false);
    });

    it('does not refill beyond burst limit', () => {
      // Exhaust burst
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume('session-1');
      }

      // Advance 60 seconds → would refill 60 tokens, but capped at burst=10
      vi.advanceTimersByTime(60000);

      // Should allow exactly 10 (burst cap)
      for (let i = 0; i < 10; i++) {
        expect(limiter.tryConsume('session-1').allowed).toBe(true);
      }
      expect(limiter.tryConsume('session-1').allowed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Session isolation
  // -----------------------------------------------------------------------

  describe('session isolation', () => {
    it('tracks separate buckets per session', () => {
      // Exhaust session-1 burst
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume('session-1');
      }

      // session-2 should still have full burst
      expect(limiter.tryConsume('session-2').allowed).toBe(true);
    });

    it('exhausting one session does not affect another', () => {
      // Exhaust session-1
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume('session-1');
      }
      expect(limiter.tryConsume('session-1').allowed).toBe(false);

      // session-2 gets full burst
      for (let i = 0; i < 10; i++) {
        expect(limiter.tryConsume('session-2').allowed).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Per-group configuration
  // -----------------------------------------------------------------------

  describe('per-group configuration', () => {
    it('applies group-specific limits', () => {
      limiter.setGroupConfig('premium', {
        requestsPerMinute: 120,
        burstSize: 20,
      });

      // Premium group gets 20 burst
      for (let i = 0; i < 20; i++) {
        expect(limiter.tryConsume('session-1', 'premium').allowed).toBe(true);
      }
      expect(limiter.tryConsume('session-1', 'premium').allowed).toBe(false);
    });

    it('falls back to default config when group has no override', () => {
      limiter.setGroupConfig('premium', {
        requestsPerMinute: 120,
        burstSize: 20,
      });

      // Default group still gets burst of 10
      for (let i = 0; i < 10; i++) {
        expect(limiter.tryConsume('session-2').allowed).toBe(true);
      }
      expect(limiter.tryConsume('session-2').allowed).toBe(false);
    });

    it('applies group-specific refill rate', () => {
      limiter.setGroupConfig('slow', {
        requestsPerMinute: 30,
        burstSize: 5,
      });

      // Exhaust slow group burst
      for (let i = 0; i < 5; i++) {
        limiter.tryConsume('session-1', 'slow');
      }

      // 30/min = 0.5/sec → need 2 seconds for 1 token
      vi.advanceTimersByTime(1000);
      expect(limiter.tryConsume('session-1', 'slow').allowed).toBe(false);

      vi.advanceTimersByTime(1000);
      expect(limiter.tryConsume('session-1', 'slow').allowed).toBe(true);
    });

    it('removeGroupConfig reverts to default limits', () => {
      limiter.setGroupConfig('custom', {
        requestsPerMinute: 120,
        burstSize: 20,
      });

      limiter.removeGroupConfig('custom');

      // Should now use default burst of 10
      for (let i = 0; i < 10; i++) {
        expect(limiter.tryConsume('session-1', 'custom').allowed).toBe(true);
      }
      expect(limiter.tryConsume('session-1', 'custom').allowed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Session teardown / state reset
  // -----------------------------------------------------------------------

  describe('resetSession', () => {
    it('clears rate limit state for a session', () => {
      // Exhaust burst
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume('session-1');
      }
      expect(limiter.tryConsume('session-1').allowed).toBe(false);

      // Reset session
      limiter.resetSession('session-1');

      // Should have full burst again
      for (let i = 0; i < 10; i++) {
        expect(limiter.tryConsume('session-1').allowed).toBe(true);
      }
    });

    it('resetting one session does not affect others', () => {
      // Partially use both sessions
      for (let i = 0; i < 5; i++) {
        limiter.tryConsume('session-1');
        limiter.tryConsume('session-2');
      }

      limiter.resetSession('session-1');

      // session-1 reset to full burst
      for (let i = 0; i < 10; i++) {
        expect(limiter.tryConsume('session-1').allowed).toBe(true);
      }

      // session-2 still has only 5 remaining
      for (let i = 0; i < 5; i++) {
        expect(limiter.tryConsume('session-2').allowed).toBe(true);
      }
      expect(limiter.tryConsume('session-2').allowed).toBe(false);
    });

    it('is a no-op for unknown session IDs', () => {
      // Should not throw
      limiter.resetSession('nonexistent');
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  describe('cleanup', () => {
    it('removes all session state', () => {
      // Exhaust two sessions
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume('session-1');
        limiter.tryConsume('session-2');
      }

      limiter.cleanup();

      // Both should start fresh
      expect(limiter.tryConsume('session-1').allowed).toBe(true);
      expect(limiter.tryConsume('session-2').allowed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Burst handling
  // -----------------------------------------------------------------------

  describe('burst handling', () => {
    it('handles burst followed by steady-state correctly', () => {
      // Use all 10 burst tokens
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume('session-1');
      }

      // Now do steady state: 1 request per second
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(1000);
        expect(limiter.tryConsume('session-1').allowed).toBe(true);
      }
    });

    it('micro-burst within a second is handled by token bucket', () => {
      // Use 5 tokens
      for (let i = 0; i < 5; i++) {
        limiter.tryConsume('session-1');
      }

      // Wait 3 seconds → 3 tokens refilled
      vi.advanceTimersByTime(3000);

      // Can burst 8 total (5 remaining + 3 refilled)
      for (let i = 0; i < 8; i++) {
        expect(limiter.tryConsume('session-1').allowed).toBe(true);
      }
      expect(limiter.tryConsume('session-1').allowed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Accuracy at boundary (±5%)
  // -----------------------------------------------------------------------

  describe('accuracy at boundary', () => {
    it('allows exactly burstSize requests without refill', () => {
      let allowed = 0;
      for (let i = 0; i < 20; i++) {
        if (limiter.tryConsume('session-1').allowed) {
          allowed++;
        }
      }
      expect(allowed).toBe(10); // exactly burstSize
    });

    it('allows requestsPerMinute requests over one minute', () => {
      let allowed = 0;
      // Send 1 request every second for 60 seconds
      // First request at t=0 uses burst
      for (let i = 0; i < 60; i++) {
        if (limiter.tryConsume('session-1').allowed) {
          allowed++;
        }
        vi.advanceTimersByTime(1000);
      }

      // Should be within ±5% of 60
      expect(allowed).toBeGreaterThanOrEqual(57); // 60 - 5%
      expect(allowed).toBeLessThanOrEqual(63); // 60 + 5%
    });

    it('sustained throughput matches configured rate', () => {
      const config: RateLimiterConfig = {
        requestsPerMinute: 120,
        burstSize: 20,
      };
      const fastLimiter = new RateLimiter(config);

      let allowed = 0;
      // 120/min = 2/sec, test over 30 seconds
      for (let i = 0; i < 120; i++) {
        if (fastLimiter.tryConsume('session-1').allowed) {
          allowed++;
        }
        vi.advanceTimersByTime(500); // 2 requests per second
      }

      // Should be within ±5% of 120
      // Over 60 seconds at 2/sec = 120 requests window
      expect(allowed).toBeGreaterThanOrEqual(114);
      expect(allowed).toBeLessThanOrEqual(126);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent load simulation
  // -----------------------------------------------------------------------

  describe('concurrent load', () => {
    it('maintains accuracy across multiple sessions under load', () => {
      const sessions = ['s1', 's2', 's3', 's4', 's5'];
      const counts: Record<string, number> = {};

      for (const s of sessions) {
        counts[s] = 0;
      }

      // Simulate 30 seconds of concurrent requests
      for (let tick = 0; tick < 30; tick++) {
        for (const s of sessions) {
          // Each session sends 2 requests per tick
          for (let r = 0; r < 2; r++) {
            if (limiter.tryConsume(s).allowed) {
              counts[s]++;
            }
          }
        }
        vi.advanceTimersByTime(1000);
      }

      // Each session: 60 req/min, burst 10
      // Over 30 seconds with 2 req/sec → 60 attempts
      // Expected: ~30 allowed (30 seconds * 1 token/sec)
      // Plus initial burst of 10 = ~40
      // But capped by actual token math
      for (const s of sessions) {
        // Each session should get roughly the same amount (burst + steady)
        expect(counts[s]).toBeGreaterThanOrEqual(10);
        expect(counts[s]).toBeLessThanOrEqual(41);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Group config changes mid-session
  // -----------------------------------------------------------------------

  describe('dynamic group config changes', () => {
    it('changing group config applies to existing sessions immediately', () => {
      // Use default config (burst=10), exhaust burst
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume('session-1', 'flexible');
      }
      expect(limiter.tryConsume('session-1', 'flexible').allowed).toBe(false);

      // Increase burst for that group
      limiter.setGroupConfig('flexible', {
        requestsPerMinute: 60,
        burstSize: 20,
      });

      // The existing bucket still has its current token count;
      // but the new burstSize cap means refills can go higher.
      // Advance time to refill some tokens
      vi.advanceTimersByTime(5000); // 5 tokens

      for (let i = 0; i < 5; i++) {
        expect(limiter.tryConsume('session-1', 'flexible').allowed).toBe(true);
      }
    });
  });
});
