import { describe, expect, it } from 'vitest';
import { registerAllAlgorithms } from '../../../src/algorithms';
import { RateLimiter } from '../../../src/core/rate-limiter';
import type { RateLimitRule } from '../../../src/core/types';
import { MemoryStore } from '../../../src/stores/memory-store';

function buildLimiter() {
  const store = new MemoryStore({ cleanupIntervalMs: 0 });
  const limiter = registerAllAlgorithms(new RateLimiter({ store, failureMode: 'fail-closed' }));
  return { store, limiter };
}

describe('concurrency correctness (in-process race check)', () => {
  const cases: Array<{ name: string; rule: RateLimitRule; limit: number }> = [
    { name: 'fixed-window', rule: { algorithm: 'fixed-window', limit: 10, windowMs: 60_000 }, limit: 10 },
    { name: 'sliding-window', rule: { algorithm: 'sliding-window', limit: 10, windowMs: 60_000 }, limit: 10 },
    { name: 'token-bucket', rule: { algorithm: 'token-bucket', capacity: 10, refillRatePerSec: 1 }, limit: 10 },
    { name: 'leaky-bucket', rule: { algorithm: 'leaky-bucket', capacity: 10, leakRatePerSec: 1 }, limit: 10 },
  ];

  for (const { name, rule, limit } of cases) {
    it(`${name}: exactly ${limit} of 50 concurrent requests allowed`, async () => {
      const { store, limiter } = buildLimiter();
      const now = Date.now();
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => limiter.check({ key: `hot:${name}:${i % 1}`, rule, now })),
      );
      // All 50 share one key (i % 1 === 0) and one timestamp.
      expect(results.filter((r) => r.allowed).length).toBe(limit);
      await store.close();
    });
  }

  it('different keys do not interfere', async () => {
    const { store, limiter } = buildLimiter();
    const rule: RateLimitRule = { algorithm: 'fixed-window', limit: 1, windowMs: 60_000 };
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => limiter.check({ key: `user:${i}`, rule })),
    );
    expect(results.every((r) => r.allowed)).toBe(true);
    await store.close();
  });
});
