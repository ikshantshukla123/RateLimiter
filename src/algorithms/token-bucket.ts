import type { RateLimitResult, TokenBucketRule } from '../core/types';
import type { Store } from '../stores/store';

interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
}

async function runExclusive<T>(store: Store, key: string, fn: () => Promise<T>): Promise<T> {
  if (store.runExclusive) return store.runExclusive(key, fn);
  return fn();
}

/**
 * Token Bucket.
 *
 *   elapsed = now - lastRefill
 *   tokens  = min(capacity, tokens + elapsed * refillRate)
 *   allow iff tokens >= 1 (then tokens -= 1)
 *
 * Allows controlled bursts up to `capacity` while enforcing the average
 * `refillRatePerSec`. One of the two main production/demo algorithms.
 */
export class TokenBucketAlgorithm {
  readonly name = 'token-bucket' as const;

  async tryConsume(key: string, rule: TokenBucketRule, store: Store, now = Date.now()): Promise<RateLimitResult> {
    return runExclusive(store, key, async () => {
      const prev = await store.get<TokenBucketState>(key);
      const tokensBefore = prev?.tokens ?? rule.capacity;
      const lastRefill = prev?.lastRefillMs ?? now;

      const elapsedSec = Math.max(0, (now - lastRefill) / 1000);
      const refilled = Math.min(rule.capacity, tokensBefore + elapsedSec * rule.refillRatePerSec);

      const allowed = refilled >= 1;
      const tokensAfter = allowed ? refilled - 1 : refilled;
      // TTL: time to refill from empty to full + 1s buffer so idle keys vanish.
      const ttlMs = Math.ceil((rule.capacity / rule.refillRatePerSec) * 1000) + 1000;
      await store.set<TokenBucketState>(key, { tokens: tokensAfter, lastRefillMs: now }, ttlMs);

      const remaining = Math.max(0, Math.floor(tokensAfter));
      let resetMs: number;
      let retryAfterMs: number;
      if (allowed && tokensAfter >= rule.capacity - 1e-9) {
        resetMs = now;
        retryAfterMs = 0;
      } else if (allowed) {
        // Time until bucket is full again (informational reset).
        resetMs = now + Math.ceil(((rule.capacity - tokensAfter) / rule.refillRatePerSec) * 1000);
        retryAfterMs = 0;
      } else {
        const deficit = 1 - refilled;
        retryAfterMs = Math.ceil((deficit / rule.refillRatePerSec) * 1000);
        resetMs = now + retryAfterMs;
      }

      return {
        allowed,
        limit: rule.capacity,
        remaining,
        resetMs,
        retryAfterMs: Math.max(0, retryAfterMs),
        algorithm: this.name,
      };
    });
  }
}
