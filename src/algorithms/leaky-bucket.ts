import type { LeakyBucketRule, RateLimitResult } from '../core/types';
import type { Store } from '../stores/store';

interface LeakyBucketState {
  level: number;
  lastLeakMs: number;
}

async function runExclusive<T>(store: Store, key: string, fn: () => Promise<T>): Promise<T> {
  if (store.runExclusive) return store.runExclusive(key, fn);
  return fn();
}

/**
 * Leaky Bucket (traffic shaping).
 *
 *   level = max(0, level - elapsed * leakRate)
 *   allow iff level + 1 <= capacity (then level += 1)
 *
 * Unlike token bucket (which permits bursts), the bucket drains at a constant
 * rate, producing a smooth constant downstream output.
 */
export class LeakyBucketAlgorithm {
  readonly name = 'leaky-bucket' as const;

  async tryConsume(key: string, rule: LeakyBucketRule, store: Store, now = Date.now()): Promise<RateLimitResult> {
    return runExclusive(store, key, async () => {
      const prev = await store.get<LeakyBucketState>(key);
      const prevLevel = prev?.level ?? 0;
      const lastLeak = prev?.lastLeakMs ?? now;

      const elapsedSec = Math.max(0, (now - lastLeak) / 1000);
      const drained = Math.max(0, prevLevel - elapsedSec * rule.leakRatePerSec);

      const allowed = drained + 1 <= rule.capacity + 1e-9;
      const level = allowed ? drained + 1 : drained;
      const ttlMs = Math.ceil((rule.capacity / rule.leakRatePerSec) * 1000) + 1000;
      await store.set<LeakyBucketState>(key, { level, lastLeakMs: now }, ttlMs);

      const remaining = Math.max(0, rule.capacity - Math.ceil(level));
      let retryAfterMs = 0;
      if (!allowed) {
        const excess = drained + 1 - rule.capacity;
        retryAfterMs = Math.ceil((excess / rule.leakRatePerSec) * 1000);
      }
      const resetMs = level <= 0 ? now : now + Math.ceil((level / rule.leakRatePerSec) * 1000);

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
