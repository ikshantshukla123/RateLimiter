import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { RedisStore } from '../../../src/stores/redis-store';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let redisAvailable = false;
let probe: RedisStore | undefined;

beforeAll(async () => {
  probe = new RedisStore({ redisUrl: REDIS_URL, lazyConnect: false, connectTimeoutMs: 1500 });
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

describe('RedisStore', () => {
  it('stores, retrieves and deletes JSON values', async () => {
    if (!redisAvailable || !probe) {
      console.warn('SKIP: Redis unavailable at ' + REDIS_URL);
      return;
    }
    const store = new RedisStore({ redisUrl: REDIS_URL });
    const key = `test:basic:${Date.now()}`;
    expect(await store.get(key)).toBeNull();
    await store.set(key, { n: 42 }, 5000);
    expect(await store.get<{ n: number }>(key)).toEqual({ n: 42 });
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await store.close();
  });

  it('incrementWithTtl is atomic under concurrency', async () => {
    if (!redisAvailable) {
      console.warn('SKIP: Redis unavailable at ' + REDIS_URL);
      return;
    }
    const store = new RedisStore({ redisUrl: REDIS_URL });
    const key = `test:incr:${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 30 }, () => store.incrementWithTtl(key, 60_000)));
    expect(new Set(results).size).toBe(30);
    expect(Math.max(...results)).toBe(30);
    await store.delete(key);
    await store.close();
  });
});
