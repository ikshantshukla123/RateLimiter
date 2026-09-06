import { describe, expect, it } from 'vitest';
import { FixedWindowAlgorithm } from '../../../src/algorithms/fixed-window';
import { MemoryStore } from '../../../src/stores/memory-store';

const rule = { algorithm: 'fixed-window' as const, limit: 3, windowMs: 1000 };

describe('fixed-window', () => {
  it('allows up to limit then denies within one window', async () => {
    const store = new MemoryStore();
    const algo = new FixedWindowAlgorithm();
    const now = 10_000;
    expect((await algo.tryConsume('k1', rule, store, now)).allowed).toBe(true);
    expect((await algo.tryConsume('k1', rule, store, now + 1)).remaining).toBe(1);
    expect((await algo.tryConsume('k1', rule, store, now + 2)).remaining).toBe(0);
    const denied = await algo.tryConsume('k1', rule, store, now + 3);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.resetMs).toBe(11_000);
    await store.close();
  });

  it('resets in the next window', async () => {
    const store = new MemoryStore();
    const algo = new FixedWindowAlgorithm();
    await algo.tryConsume('k', rule, store, 1000);
    await algo.tryConsume('k', rule, store, 1001);
    await algo.tryConsume('k', rule, store, 1002);
    expect((await algo.tryConsume('k', rule, store, 1003)).allowed).toBe(false);
    // Next window starts at 2000
    const next = await algo.tryConsume('k', rule, store, 2000);
    expect(next.allowed).toBe(true);
    expect(next.remaining).toBe(2);
    await store.close();
  });

  it('isolates keys', async () => {
    const store = new MemoryStore();
    const algo = new FixedWindowAlgorithm();
    await algo.tryConsume('a', rule, store, 5000);
    await algo.tryConsume('a', rule, store, 5001);
    await algo.tryConsume('a', rule, store, 5002);
    expect((await algo.tryConsume('a', rule, store, 5003)).allowed).toBe(false);
    expect((await algo.tryConsume('b', rule, store, 5003)).allowed).toBe(true);
    await store.close();
  });
});
