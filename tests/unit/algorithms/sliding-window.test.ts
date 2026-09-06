import { describe, expect, it } from 'vitest';
import { SlidingWindowAlgorithm } from '../../../src/algorithms/sliding-window';
import { MemoryStore } from '../../../src/stores/memory-store';

const rule = { algorithm: 'sliding-window' as const, limit: 5, windowMs: 10_000 };

describe('sliding-window counter', () => {
  it('allows up to limit then denies within one window', async () => {
    const store = new MemoryStore();
    const algo = new SlidingWindowAlgorithm();
    const now = 20_000;
    for (let i = 0; i < 5; i++) {
      expect((await algo.tryConsume('k', rule, store, now + i)).allowed).toBe(true);
    }
    expect((await algo.tryConsume('k', rule, store, now + 5)).allowed).toBe(false);
    await store.close();
  });

  it('weights the previous window (no fixed-window boundary burst)', async () => {
    const store = new MemoryStore();
    const algo = new SlidingWindowAlgorithm();
    // Fill previous window [0,10000)
    for (let i = 0; i < 5; i++) await algo.tryConsume('k', rule, store, 9000 + i);
    // At t=10000 (start of next window) overlap=1 -> estimate ~= 5 -> deny
    expect((await algo.tryConsume('k', rule, store, 10_000)).allowed).toBe(false);
    // Near end of next window overlap~=0 -> estimate ~= current -> allow
    expect((await algo.tryConsume('k', rule, store, 19_999)).allowed).toBe(true);
    await store.close();
  });

  it('recovers after an idle gap', async () => {
    const store = new MemoryStore();
    const algo = new SlidingWindowAlgorithm();
    for (let i = 0; i < 5; i++) await algo.tryConsume('k', rule, store, 0);
    expect((await algo.tryConsume('k', rule, store, 1)).allowed).toBe(false);
    expect((await algo.tryConsume('k', rule, store, 100_000)).allowed).toBe(true);
    await store.close();
  });
});
