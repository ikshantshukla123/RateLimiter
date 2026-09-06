/**
 * Pluggable storage contract.
 *
 * - MemoryStore: single-instance Map, used for local dev / unit tests / fallback tier.
 * - RedisStore: shared fleet-wide state with Lua-based atomic transitions.
 *
 * The store is deliberately dumb: it persists state with TTLs and can run a
 * Lua script atomically. Algorithm semantics live in `src/algorithms/*`.
 */
export interface Store {
  /** Human-readable backend name used in errors/metrics (`memory`, `redis`). */
  readonly name: string;

  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;

  /**
   * Atomic `INCR + PEXPIRE-if-new` helper. Used by the fixed-window fast path
   * so increment and expiry never split into an unsafe two-step sequence.
   * Returns the counter value after increment.
   */
  incrementWithTtl?(key: string, ttlMs: number): Promise<number>;

  /**
   * Run a Lua script atomically (Redis `EVAL`). MemoryStore does not implement this.
   * Algorithms use it for multi-step transitions (token-bucket refill/check/update, ...).
   */
  evaluate?(script: string, keys: string[], args: Array<string | number>): Promise<unknown>;

  /**
   * Run `fn` exclusively per key (in-memory mutex). Algorithms wrap their
   * read-modify-write in this when available so concurrent `Promise.all`
   * checks on one Node process cannot interleave and lose counts.
   * Redis paths use Lua instead and may omit this.
   */
  runExclusive?<T>(key: string, fn: () => Promise<T>): Promise<T>;

  close?(): Promise<void>;
}
