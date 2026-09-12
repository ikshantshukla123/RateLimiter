import { labState } from './lab-state';
import type { Store } from '../stores/store';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chaos decorator for the Lab.
 * Lets the dashboard simulate `Kill Redis` / `+latency` in real time
 * without needing `docker stop`. When `redisDown` is on, every operation
 * on the wrapped primary throws, so the RateLimiter's real timeout +
 * fallback + fail-open/closed path engages (not a fake).
 */
export function withChaos(store: Store): Store {
  const wrap = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    if (labState.chaos.redisDown && store.name !== 'memory') {
      throw new Error(`lab chaos: ${store.name} is down (${operation})`);
    }
    const extra = labState.chaos.addedLatencyMs;
    if (extra > 0) await sleep(extra);
    return fn();
  };

  return {
    name: store.name,
    get: <T>(key: string) => wrap('get', () => store.get<T>(key)),
    set: <T>(key: string, value: T, ttlMs: number) => wrap('set', () => store.set(key, value, ttlMs)),
    delete: (key: string) => wrap('delete', () => store.delete(key)),
    incrementWithTtl: store.incrementWithTtl
      ? (key: string, ttlMs: number) => wrap('incrementWithTtl', () => store.incrementWithTtl!(key, ttlMs))
      : undefined,
    evaluate: store.evaluate
      ? (script: string, keys: string[], args: Array<string | number>) =>
          wrap('evaluate', () => store.evaluate!(script, keys, args))
      : undefined,
    runExclusive: store.runExclusive
      ? <T>(key: string, fn: () => Promise<T>) => store.runExclusive!(key, () => wrap('runExclusive', fn))
      : undefined,
    close: store.close ? () => store.close!() : undefined,
  };
}
