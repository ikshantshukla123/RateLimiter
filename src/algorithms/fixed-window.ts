import type { FixedWindowRule, RateLimitResult } from '../core/types';
import type { Store } from '../stores/store';
import { FIXED_WINDOW_LUA } from './lua';

interface FixedWindowState {
  count: number;
  windowStart: number;
}

async function runExclusive<T>(store: Store, key: string, fn: () => Promise<T>): Promise<T> {
  if (store.runExclusive) return store.runExclusive(key, fn);
  return fn();
}

function parseLuaResult(raw: unknown, algorithm: 'fixed-window'): RateLimitResult {
  const [allowed, remaining, resetMs, retryAfterMs, limit] = (raw as Array<string | number>).map(Number);
  return {
    allowed: allowed === 1,
    remaining,
    resetMs,
    retryAfterMs,
    limit,
    algorithm,
  };
}

/**
 * Fixed Window Counter.
 *
 *   windowStart = floor(now / windowMs) * windowMs
 *   count++ ; allow iff count <= limit
 *
 * Memory path uses a per-key mutex; Redis path runs FIXED_WINDOW_LUA
 * atomically so increment + expiry + decision never split across instances.
 */
export class FixedWindowAlgorithm {
  readonly name = 'fixed-window' as const;

  async tryConsume(key: string, rule: FixedWindowRule, store: Store, now = Date.now()): Promise<RateLimitResult> {
    if (store.evaluate) {
      const raw = await store.evaluate(FIXED_WINDOW_LUA, [key], [now, rule.windowMs, rule.limit]);
      return parseLuaResult(raw, this.name);
    }
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
