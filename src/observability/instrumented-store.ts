import type { Store } from '../stores/store';
import type { MetricsRecorder } from './metrics';

/**
 * Decorator that records per-operation success/error counters without
 * touching store internals (keeps Store dumb, metrics on the outside).
 */
export function withMetrics(store: Store, metrics: MetricsRecorder): Store {
  const record = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    try {
      const result = await fn();
      metrics.observeStoreOperation(store.name, operation, true);
      return result;
    } catch (err) {
      metrics.observeStoreOperation(store.name, operation, false);
      throw err;
    }
  };

  return {
    name: store.name,
    get: <T>(key: string) => record('get', () => store.get<T>(key)),
    set: <T>(key: string, value: T, ttlMs: number) => record('set', () => store.set(key, value, ttlMs)),
    delete: (key: string) => record('delete', () => store.delete(key)),
    incrementWithTtl: store.incrementWithTtl
      ? (key: string, ttlMs: number) => record('incrementWithTtl', () => store.incrementWithTtl!(key, ttlMs))
      : undefined,
    evaluate: store.evaluate
      ? (script: string, keys: string[], args: Array<string | number>) =>
          record('evaluate', () => store.evaluate!(script, keys, args))
      : undefined,
    runExclusive: store.runExclusive
      ? <T>(key: string, fn: () => Promise<T>) => store.runExclusive!(key, fn)
      : undefined,
    close: store.close ? () => store.close!() : undefined,
  };
}
