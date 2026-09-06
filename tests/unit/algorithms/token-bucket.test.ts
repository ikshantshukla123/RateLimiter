import { describe, expect, it } from 'vitest';
import { TokenBucketAlgorithm } from '../../../src/algorithms/token-bucket';
import { MemoryStore } from '../../../src/stores/memory-store';

const rule = { algorithm: 'token-bucket' as const, capacity: 5, refillRatePerSec: 1 };

describe('token-bucket', () => {
  it('allows a burst up to capacity then denies', async () => {
    const store = new MemoryStore();
    const algo = new TokenBucketAlgorithm();
    const now = 50_000;
    for (let i = 0; i < 5; i++) {
      expect((await algo.tryConsume('k', rule, store, now)).allowed).toBe(true);
    }
    const denied = await algo.tryConsume('k', rule, store, now);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    await store.close();
  });

  it('refills over time', async () => {
    const store = new MemoryStore();
    const algo = new TokenBucketAlgorithm();
    const t0 = 100_000;
    for (let i = 0; i < 5; i++) await algo.tryConsume('k', rule, store, t0);
    expect((await algo.tryConsume('k', rule, store, t0)).allowed).toBe(false);
    // 3s later at 1 token/s -> ~3 tokens
    expect((await algo.tryConsume('k', rule, store, t0 + 3000)).allowed).toBe(true);
    expect((await algo.tryConsume('k', rule, store, t0 + 3000)).allowed).toBe(true);
    expect((await algo.tryConsume('k', rule, store, t0 + 3000)).allowed).toBe(true);
    expect((await algo.tryConsume('k', rule, store, t0 + 3000)).allowed).toBe(false);
    await store.close();
  });

  it('caps refill at capacity (no token hoarding past max)', async () => {
    const store = new MemoryStore();
    const algo = new TokenBucketAlgorithm();
    await algo.tryConsume('k', rule, store, 0); // 5 -> 4
    // idle for an hour: bucket must be full (5), not 3605
    let allowed = 0;
    for (let i = 0; i < 6; i++) {
      if ((await algo.tryConsume('k', rule, store, 3_600_000)).allowed) allowed++;
    }
    expect(allowed).toBe(5);
    await store.close();
  });
});
