/**
 * Core domain types for the distributed rate limiter.
 *
 * Dependency direction (must stay clean):
 *   Gateway -> RateLimiter Core -> Algorithm + Store
 *
 * Algorithms must not depend on Express.
 * Core must not depend on Express.
 * Store must not know about HTTP.
 */

export type AlgorithmName = 'token-bucket' | 'fixed-window' | 'sliding-window' | 'leaky-bucket';

/** Failure strategy when the limiter cannot reach a decision (e.g. Redis down/slow). */
export type FailureMode = 'fail-open' | 'fail-closed';

/** Base fields shared by every rule. */
interface BaseRule {
  algorithm: AlgorithmName;
  /** Optional namespace prefix, e.g. `api`, `login`. Final store key = `${keyPrefix}:${key}`. */
  keyPrefix?: string;
}

export interface FixedWindowRule extends BaseRule {
  algorithm: 'fixed-window';
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface SlidingWindowRule extends BaseRule {
  algorithm: 'sliding-window';
  limit: number;
  windowMs: number;
}

export interface TokenBucketRule extends BaseRule {
  algorithm: 'token-bucket';
  /** Bucket capacity = max burst. Also reported as `limit` in results. */
  capacity: number;
  /** Sustained refill rate in tokens per second. */
  refillRatePerSec: number;
}

export interface LeakyBucketRule extends BaseRule {
  algorithm: 'leaky-bucket';
  /** Queue capacity. Also reported as `limit` in results. */
  capacity: number;
  /** Drain rate in requests per second (constant downstream output). */
  leakRatePerSec: number;
}

export type RateLimitRule = FixedWindowRule | SlidingWindowRule | TokenBucketRule | LeakyBucketRule;

export interface RateLimitResult {
  allowed: boolean;
  /** Configured allowance (limit or capacity depending on algorithm). */
  limit: number;
  /** Remaining allowance after this decision (>= 0). */
  remaining: number;
  /** Epoch ms when the current window/bucket fully resets. */
  resetMs: number;
  /** Ms the client should wait before retrying (0 when allowed). */
  retryAfterMs: number;
  algorithm: AlgorithmName;
}

/** Injectable clock for testability (defaults to Date.now). */
export type Clock = () => number;

/** Minimal structured logger core depends on (pino satisfies this; no pino import here). */
export interface DegradationLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface FallbackEvent {
  from: string;
  to: string;
  key: string;
  error: unknown;
}

export interface RateLimiterOptions {
  store: import('../stores/store').Store;
  /** Used when the primary store fails and `enableFallback` is true. */
  fallbackStore?: import('../stores/store').Store;
  defaultRule?: RateLimitRule;
  /** What to do when no decision can be made. Default: 'fail-closed'. */
  failureMode?: FailureMode;
  /** Per-check timeout for store operations. Slow Redis must not block requests. */
  timeoutMs?: number;
  /** Enable in-memory fallback on primary failure. Default: false (set true in Phase 5 wiring). */
  enableFallback?: boolean;
  clock?: Clock;
  /** Structured degradation logs (Redis down, fallback engaged). Default: silent. */
  logger?: DegradationLogger;
  /** Hook for metrics (Phase 6 wires fallback counters here). */
  onFallback?: (event: FallbackEvent) => void;
}

export interface CheckInput {
  key: string;
  rule?: RateLimitRule;
  /** Number of tokens/requests to consume (default 1). */
  cost?: number;
  now?: number;
}

/**
 * Strategy interface every algorithm must implement.
 * `store` is the shared state backend (memory or Redis).
 * Implementations must keep the read-check-write transition atomic
 * (single-threaded map ops for memory, Lua scripts for Redis).
 */
export interface Algorithm<TRule extends RateLimitRule = RateLimitRule> {
  readonly name: AlgorithmName;
  tryConsume(key: string, rule: TRule, store: import('../stores/store').Store, now?: number): Promise<RateLimitResult>;
}

export function getRuleLimit(rule: RateLimitRule): number {
  switch (rule.algorithm) {
    case 'fixed-window':
    case 'sliding-window':
      return rule.limit;
    case 'token-bucket':
    case 'leaky-bucket':
      return rule.capacity;
  }
}
