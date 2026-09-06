import { describe, expect, it } from 'vitest';
import { LeakyBucketAlgorithm } from '../../../src/algorithms/leaky-bucket';
import { MemoryStore } from '../../../src/stores/memory-store';

const rule = { algorithm: 'leaky-bucket' as const, capacity: 3, leakRatePerSec: 1 };

describe('leaky-bucket', () => {
  it('allows bursts up to capacity then denies', async () => {
    const store = new MemoryStore();
    const algo = new LeakyBucketAlgorithm();
    const now = 70_000;
    expect((await algo.tryConsume('k', rule, store, now)).allowed).toBe(true);
    expect((await algo.tryConsume('k', rule, store, now)).allowed).toBe(true);
    expect((await algo.tryConsume('k', rule, store, now)).allowed).toBe(true);
    const denied = await algo.tryConsume('k', rule, store, now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    await store.close();
  });

  it('drains at a constant rate', async () => {
    const store = new MemoryStore();
    const algo = new LeakyBucketAlgorithm();
    const t0 = 200_000;
    await algo.tryConsume('k', rule, store, t0);
    await algo.tryConsume('k', rule, store, t0);
    await algo.tryConsume('k', rule, store, t0);
    // 2s later at 1/s: level 3 -> 1, room for two more (1->2, 2->3), then full
    expect((await algo.tryConsume('k', rule, store, t0 + 2000)).allowed).toBe(true);
    expect((await algo.tryConsume('k', rule, store, t0 + 2000)).allowed).toBe(true);
    expect((await algo.tryConsume('k', rule, store, t0 + 2000)).allowed).toBe(false);
    await store.close();
  });
});
