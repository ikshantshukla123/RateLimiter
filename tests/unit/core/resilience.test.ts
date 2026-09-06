import { describe, expect, it, vi } from 'vitest';
import { registerAllAlgorithms } from '../../../src/algorithms';
import { RateLimiter } from '../../../src/core/rate-limiter';
import type { RateLimitRule } from '../../../src/core/types';
import { MemoryStore } from '../../../src/stores/memory-store';
import type { Store } from '../../../src/stores/store';

const rule: RateLimitRule = { algorithm: 'fixed-window', limit: 5, windowMs: 60_000 };

/** Store that always fails (simulates Redis down). */
class FailingStore implements Store {
  readonly name = 'failing';
  async get(): Promise<never> {
    throw new Error('connection refused');
  }
  async set(): Promise<never> {
    throw new Error('connection refused');
  }
  async delete(): Promise<void> {
    throw new Error('connection refused');
  }
}

/** Store that hangs (simulates slow Redis). */
class HangingStore implements Store {
  readonly name = 'hanging';
  async get<T>(): Promise<T | null> {
    return new Promise(() => undefined) as Promise<T | null>;
  }
  async set(): Promise<void> {
    return new Promise(() => undefined) as Promise<void>;
  }
  async delete(): Promise<void> {
    return new Promise(() => undefined) as Promise<void>;
  }
}

describe('failure behavior', () => {
  it('fail-closed throws when the primary store fails', async () => {
    const limiter = registerAllAlgorithms(
      new RateLimiter({ store: new FailingStore(), failureMode: 'fail-closed', timeoutMs: 100 }),
    );
    await expect(limiter.check({ key: 'k', rule })).rejects.toThrow();
  });

  it('fail-open allows with limit 0 when the primary store fails', async () => {
    const limiter = registerAllAlgorithms(
      new RateLimiter({ store: new FailingStore(), failureMode: 'fail-open', timeoutMs: 100 }),
    );
    const result = await limiter.check({ key: 'k', rule });
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(0);
  });

  it('degraded fallback serves from memory when Redis is down', async () => {
    const fallback = new MemoryStore({ cleanupIntervalMs: 0 });
    const events: unknown[] = [];
    const logs: unknown[] = [];
    const limiter = registerAllAlgorithms(
      new RateLimiter({
        store: new FailingStore(),
        fallbackStore: fallback,
        enableFallback: true,
        failureMode: 'fail-closed',
        timeoutMs: 100,
        logger: { warn: (o: unknown, m?: string) => void logs.push([o, m]), error: () => undefined },
        onFallback: (e) => void events.push(e),
      }),
    );
    // Fallback still enforces limits per instance (weaker than fleet-wide, safer than open).
    for (let i = 0; i < 5; i++) {
      expect((await limiter.check({ key: 'k', rule })).allowed).toBe(true);
    }
    expect((await limiter.check({ key: 'k', rule })).allowed).toBe(false);
    expect(events.length).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
    await fallback.close();
  });

  it('slow store hits timeout instead of blocking (fail-closed)', async () => {
    const limiter = registerAllAlgorithms(
      new RateLimiter({ store: new HangingStore(), failureMode: 'fail-closed', timeoutMs: 20 }),
    );
    const started = Date.now();
    await expect(limiter.check({ key: 'k', rule })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('slow primary falls back to memory within timeout budget', async () => {
    const fallback = new MemoryStore({ cleanupIntervalMs: 0 });
    const limiter = registerAllAlgorithms(
      new RateLimiter({
        store: new HangingStore(),
        fallbackStore: fallback,
        enableFallback: true,
        failureMode: 'fail-closed',
        timeoutMs: 50,
      }),
    );
    const result = await limiter.check({ key: 'k', rule });
    expect(result.allowed).toBe(true);
    await fallback.close();
  });

  it('still enforces limits after fallback engages (no silent open)', async () => {
    const fallback = new MemoryStore({ cleanupIntervalMs: 0 });
    const limiter = registerAllAlgorithms(
      new RateLimiter({
        store: new FailingStore(),
        fallbackStore: fallback,
        enableFallback: true,
        failureMode: 'fail-open',
        timeoutMs: 50,
      }),
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.check({ key: 'same', rule })),
    );
    // Memory fallback serializes via mutex: exactly 5 allowed, not 10, not 0.
    expect(results.filter((r) => r.allowed).length).toBe(5);
    await fallback.close();
  });

  it('calls onFallback hook for metrics wiring', async () => {
    const onFallback = vi.fn();
    const limiter = registerAllAlgorithms(
      new RateLimiter({
        store: new FailingStore(),
        fallbackStore: new MemoryStore({ cleanupIntervalMs: 0 }),
        enableFallback: true,
        timeoutMs: 50,
        onFallback,
      }),
    );
    await limiter.check({ key: 'k', rule });
    expect(onFallback).toHaveBeenCalledOnce();
  });
});
