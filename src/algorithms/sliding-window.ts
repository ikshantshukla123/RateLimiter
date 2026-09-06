import type { RateLimitResult, SlidingWindowRule } from '../core/types';
import type { Store } from '../stores/store';
import { SLIDING_WINDOW_LUA } from './lua';

interface SlidingWindowState {
  currentCount: number;
  currentWindowStart: number;
  previousCount: number;
}

async function runExclusive<T>(store: Store, key: string, fn: () => Promise<T>): Promise<T> {
  if (store.runExclusive) return store.runExclusive(key, fn);
  return fn();
}

/**
 * Sliding Window Counter (weighted approximation).
 *
 *   estimate = prevCount * overlap + currentCount
 *   allow iff estimate < limit (then currentCount++)
 *
 * Removes most fixed-window boundary bursts while keeping state tiny
 * (two counters instead of a per-request log).
 */
export class SlidingWindowAlgorithm {
  readonly name = 'sliding-window' as const;

  async tryConsume(key: string, rule: SlidingWindowRule, store: Store, now = Date.now()): Promise<RateLimitResult> {
    if (store.evaluate) {
      const [allowed, remaining, resetMs, retryAfterMs, limit] = (
        (await store.evaluate(SLIDING_WINDOW_LUA, [key], [now, rule.windowMs, rule.limit])) as Array<
          string | number
        >
      ).map(Number);
      return { allowed: allowed === 1, remaining, resetMs, retryAfterMs, limit, algorithm: this.name };
    }
    return runExclusive(store, key, async () => {
      const currentWindowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
      const prev = await store.get<SlidingWindowState>(key);

      let currentCount = 0;
      let previousCount = 0;
      if (prev) {
        if (prev.currentWindowStart === currentWindowStart) {
          currentCount = prev.currentCount;
          previousCount = prev.previousCount;
        } else if (prev.currentWindowStart === currentWindowStart - rule.windowMs) {
          previousCount = prev.currentCount;
          currentCount = 0;
        } else {
          previousCount = 0;
          currentCount = 0;
        }
      }

      const elapsedInWindow = now - currentWindowStart;
      const overlap = Math.min(1, Math.max(0, (rule.windowMs - elapsedInWindow) / rule.windowMs));
      const estimate = previousCount * overlap + currentCount;
      const allowed = estimate < rule.limit;

      if (allowed) currentCount += 1;
      await store.set<SlidingWindowState>(
        key,
        { currentCount, currentWindowStart, previousCount },
        rule.windowMs * 2,
      );

      const resetMs = currentWindowStart + rule.windowMs;
      return {
        allowed,
        limit: rule.limit,
        remaining: allowed ? Math.max(0, rule.limit - Math.ceil(estimate) - 1) : 0,
        resetMs,
        retryAfterMs: allowed ? 0 : Math.max(0, resetMs - now),
        algorithm: this.name,
      };
    });
  }
}
