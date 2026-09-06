import Redis from 'ioredis';
import { StoreError } from '../core/errors';
import type { Store } from './store';

export interface RedisStoreOptions {
  redisUrl?: string;
  /** Prefix applied to every key (fleet namespace). Default: none (keys already namespaced). */
  keyPrefix?: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  lazyConnect?: boolean;
}

/**
 * Shared fleet-wide state backend.
 *
 * - Generic state uses JSON strings with PX TTL.
 * - `incrementWithTtl` uses a Lua script so INCR + PEXPIRE are atomic.
 * - `evaluate` runs algorithm Lua scripts atomically (EVAL), which is how
 *   multi-step transitions (refill/check/update) stay correct under concurrency:
 *   Gateway 1/2/3 -> one Redis -> one atomic decision.
 */
export class RedisStore implements Store {
  readonly name = 'redis';
  private readonly client: Redis;
  private readonly keyPrefix: string;
  private readonly commandTimeoutMs: number;

  constructor(options: RedisStoreOptions | string = {}) {
    const opts: RedisStoreOptions = typeof options === 'string' ? { redisUrl: options } : options;
    this.keyPrefix = opts.keyPrefix ?? '';
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 1000;
    this.client = new Redis(opts.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379', {
      connectTimeout: opts.connectTimeoutMs ?? 2000,
      lazyConnect: opts.lazyConnect ?? false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    this.client.on('error', () => {
      // Swallowed here; operations surface StoreError to the RateLimiter,
      // which applies timeout/fail-open/fail-closed + fallback (Phase 5).
    });
  }

  /** Exposed for health checks and tests. */
  get redis(): Redis {
    return this.client;
  }

  private namespaced(key: string): string {
    return this.keyPrefix ? `${this.keyPrefix}:${key}` : key;
  }

  private wrap<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return fn().catch((err) => {
      throw new StoreError(err instanceof Error ? err.message : String(err), {
        store: this.name,
        operation,
      });
    });
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    return this.wrap('get', async () => {
      const raw = await this.client.get(this.namespaced(key));
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    });
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new StoreError('ttlMs must be a positive number', { store: this.name, operation: 'set' });
    }
    await this.wrap('set', async () => {
      await this.client.set(this.namespaced(key), JSON.stringify(value), 'PX', Math.floor(ttlMs));
    });
  }

  async delete(key: string): Promise<void> {
    await this.wrap('delete', async () => {
      await this.client.del(this.namespaced(key));
    });
  }

  async incrementWithTtl(key: string, ttlMs: number): Promise<number> {
    const script = `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
      return count
    `;
    const result = await this.evaluate(script, [this.namespaced(key)], [Math.floor(ttlMs)]);
    return Number(result);
  }

  async evaluate(script: string, keys: string[], args: Array<string | number>): Promise<unknown> {
    return this.wrap('evaluate', async () => {
      const stringArgs = args.map((a) => String(a));
      // ioredis v5: eval(script, numKeys, ...keysAndArgs)
      return await this.client.eval(script, keys.length, ...keys, ...stringArgs);
    });
  }

  async close(): Promise<void> {
    try {
      if (this.client.status === 'ready' || this.client.status === 'connect') {
        await this.client.quit();
      } else {
        this.client.disconnect();
      }
    } catch {
      this.client.disconnect();
    }
  }
}
