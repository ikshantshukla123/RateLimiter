import { StoreError } from '../core/errors';
import type { Store } from './store';

interface Entry {
  value: unknown;
  expiresAt: number;
}

export interface MemoryStoreOptions {
  /** Sweep interval for expired keys. Set 0 to disable. Default 60s. */
  cleanupIntervalMs?: number;
  clock?: () => number;
  /** Max keys before oldest-expired sweep is forced. Default 50_000. */
  maxKeys?: number;
}

/**
 * Single-instance Map store with TTL expiry.
 *
 * - `get` returns null for missing/expired keys (and lazily deletes them).
 * - `runExclusive` serializes concurrent transitions per key via promise chaining,
 *   closing the read-modify-write race for in-process concurrency.
 * - Background sweep prevents unbounded memory growth (expired-key cleanup).
 */
export class MemoryStore implements Store {
  readonly name = 'memory';
  private readonly data = new Map<string, Entry>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly clock: () => number;
  private readonly maxKeys: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: MemoryStoreOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.maxKeys = options.maxKeys ?? 50_000;
    const interval = options.cleanupIntervalMs ?? 60_000;
    if (interval > 0) {
      this.cleanupTimer = setInterval(() => this.sweep(), interval);
      this.cleanupTimer.unref?.();
    }
  }

  private now(): number {
    return this.clock();
  }

  private isExpired(entry: Entry, now: number): boolean {
    return entry.expiresAt <= now;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    const now = this.now();
    if (this.isExpired(entry, now)) {
      this.data.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new StoreError('ttlMs must be a positive number', { store: this.name, operation: 'set' });
    }
    if (!key) throw new StoreError('key must be non-empty', { store: this.name, operation: 'set' });
    if (this.data.size >= this.maxKeys && !this.data.has(key)) {
      this.sweep();
      if (this.data.size >= this.maxKeys) {
        throw new StoreError(`max keys (${this.maxKeys}) exceeded`, { store: this.name, operation: 'set' });
      }
    }
    this.data.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async incrementWithTtl(key: string, ttlMs: number): Promise<number> {
    return this.runExclusive(key, async () => {
      const current = (await this.get<number>(key)) ?? 0;
      const next = current + 1;
      // Preserve existing TTL when the key already exists so fixed windows
      // stay anchored; only fresh keys take the full ttlMs.
      const entry = this.data.get(key);
      const now = this.now();
      if (entry && !this.isExpired(entry, now)) {
        const remaining = Math.max(1, entry.expiresAt - now);
        this.data.set(key, { value: next, expiresAt: now + remaining });
      } else {
        await this.set(key, next, ttlMs);
      }
      return next;
    });
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => current);
    this.chains.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      // Only clear if no successor queued behind us.
      if (this.chains.get(key) === tail) this.chains.delete(key);
    }
  }

  /** Number of live (non-expired) keys. Sweeps first for accuracy. */
  size(): number {
    this.sweep();
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.data) {
      if (this.isExpired(entry, now)) this.data.delete(key);
    }
  }
}
