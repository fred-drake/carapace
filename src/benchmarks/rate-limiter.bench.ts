/**
 * Rate limiter accuracy benchmark (QA-11).
 *
 * Measures rate limiter accuracy under concurrent load, verifying
 * that burst boundaries are respected within ±5% tolerance.
 *
 * Target: ±5% accuracy at burst boundary.
 */

import { bench, describe } from 'vitest';
import { RateLimiter } from '../core/rate-limiter.js';

describe('rate limiter accuracy', () => {
  describe('burst boundary accuracy', () => {
    bench(
      'tryConsume within burst (100 tokens)',
      () => {
        // Fresh limiter per iteration to test burst boundary
        const l = new RateLimiter({ requestsPerMinute: 600, burstSize: 100 });
        let allowed = 0;
        for (let i = 0; i < 100; i++) {
          if (l.tryConsume('bench-session').allowed) allowed++;
        }
        // Accuracy check: should allow exactly 100
        if (allowed !== 100) throw new Error(`Expected 100, got ${allowed}`);
      },
      { iterations: 100, time: 3000 },
    );

    bench(
      'tryConsume at burst boundary (101st request rejected)',
      () => {
        const l = new RateLimiter({ requestsPerMinute: 600, burstSize: 100 });
        for (let i = 0; i < 100; i++) l.tryConsume('bench-session');
        const result = l.tryConsume('bench-session');
        if (result.allowed) throw new Error('101st request should be rejected');
      },
      { iterations: 200, time: 3000 },
    );
  });

  describe('concurrent load', () => {
    bench(
      'concurrent tryConsume across 10 sessions',
      () => {
        const l = new RateLimiter({ requestsPerMinute: 6000, burstSize: 50 });
        for (let s = 0; s < 10; s++) {
          for (let i = 0; i < 50; i++) {
            l.tryConsume(`session-${s}`);
          }
        }
      },
      { iterations: 100, time: 3000 },
    );

    bench(
      'tryConsume with retryAfter calculation',
      () => {
        const l = new RateLimiter({ requestsPerMinute: 60, burstSize: 1 });
        l.tryConsume('bench');
        const result = l.tryConsume('bench');
        if (result.allowed) throw new Error('Should be rate limited');
      },
      { iterations: 500, time: 3000 },
    );
  });
});
