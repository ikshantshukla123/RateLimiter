import type { FixedWindowRule, RateLimitResult } from '../core/types';
import type { Store } from '../stores/store';

interface FixedWindowState {
  count: number;
  windowStart: number;
}

async function runExclusive<T>(store: Store, key: string, fn: () => Promise<T>): Promise<T> {
  if (store.runExclusive) return store.runExclusive(key, fn);
  return fn();
}

/**
 * Fixed Window Counter.
 *
 *   windowStart = floor(now / windowMs) * windowMs
 *   count++ ; allow iff count <= limit
 *
 * Simple and cheap. Demonstrates the boundary-burst artifact: a client can
 * consume `limit` at the end of window N and `limit` again at the start of
 * window N+1 (≈2×limit in ~one window span).
 */
export class FixedWindowAlgorithm {
  readonly name = 'fixed-window' as const;

  async tryConsume(key: string, rule: FixedWindowRule, store: Store, now = Date.now()): Promise<RateLimitResult> {
    return runExclusive(store, key, async () => {
      const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
      const resetMs = windowStart + rule.windowMs;
      const prev = await store.get<FixedWindowState>(key);

      let count: number;
      if (!prev || prev.windowStart !== windowStart) {
        count = 1;
      } else {
        count = prev.count + 1;
      }
      const ttlMs = Math.max(1, resetMs - now);
      await store.set<FixedWindowState>(key, { count, windowStart }, ttlMs);

      const allowed = count <= rule.limit;
      return {
        allowed,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - count),
        resetMs,
        retryAfterMs: allowed ? 0 : Math.max(0, resetMs - now),
        algorithm: this.name,
      };
    });
  }
}
