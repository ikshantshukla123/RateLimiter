import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { registerAllAlgorithms } from '../../../src/algorithms';
import { RateLimiter } from '../../../src/core/rate-limiter';
import type { RateLimitRule } from '../../../src/core/types';
import { RedisStore } from '../../../src/stores/redis-store';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
let redisAvailable = false;
let probe: RedisStore | undefined;

beforeAll(async () => {
  probe = new RedisStore({ redisUrl: REDIS_URL, connectTimeoutMs: 1500 });
  try {
    redisAvailable = await probe.ping();
  } catch {
    redisAvailable = false;
  }
  if (!redisAvailable) await probe.close().catch(() => undefined);
}, 10000);

afterAll(async () => {
  await probe?.close().catch(() => undefined);
});

describe('Redis-backed algorithms (Lua atomicity)', () => {
  const cases: Array<{ name: string; rule: RateLimitRule; limit: number }> = [
    { name: 'fixed-window', rule: { algorithm: 'fixed-window', limit: 10, windowMs: 60_000 }, limit: 10 },
    { name: 'sliding-window', rule: { algorithm: 'sliding-window', limit: 10, windowMs: 60_000 }, limit: 10 },
    { name: 'token-bucket', rule: { algorithm: 'token-bucket', capacity: 10, refillRatePerSec: 1 }, limit: 10 },
    { name: 'leaky-bucket', rule: { algorithm: 'leaky-bucket', capacity: 10, leakRatePerSec: 1 }, limit: 10 },
  ];

  for (const { name, rule, limit } of cases) {
    it(`${name}: exactly ${limit} of 30 concurrent decisions allowed`, async () => {
      if (!redisAvailable) {
        console.warn('SKIP: Redis unavailable at ' + REDIS_URL);
        return;
      }
      const store = new RedisStore({ redisUrl: REDIS_URL });
      const limiter = registerAllAlgorithms(
        new RateLimiter({ store, failureMode: 'fail-closed', timeoutMs: 2000 }),
      );
      const key = `it:${name}:${Date.now()}`;
      const now = Date.now();
      const results = await Promise.all(
        Array.from({ length: 30 }, () => limiter.check({ key, rule, now })),
      );
      expect(results.filter((r) => r.allowed).length).toBe(limit);
      await store.delete(`rl:${key}`).catch(() => undefined);
      await store.delete(key).catch(() => undefined);
      await store.close();
    });
  }
});
