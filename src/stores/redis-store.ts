import type { Store } from './store';

/**
 * Phase 4 provides the Redis implementation (ioredis + Lua atomicity).
 * Stub here so Phase 1 compiles and dependency direction stays Gateway ->
 * RateLimiter -> Algorithm + Store.
 */
export class RedisStore implements Store {
  readonly name = 'redis';
  constructor(_redisUrl?: string) {
    void _redisUrl;
  }
  async get<T>(_key: string): Promise<T | null> {
    void _key;
    throw new Error('RedisStore: not implemented yet (Phase 4)');
  }
  async set<T>(_key: string, _value: T, _ttlMs: number): Promise<void> {
    void _key;
    void _value;
    void _ttlMs;
    throw new Error('RedisStore: not implemented yet (Phase 4)');
  }
  async delete(_key: string): Promise<void> {
    void _key;
    throw new Error('RedisStore: not implemented yet (Phase 4)');
  }
}
