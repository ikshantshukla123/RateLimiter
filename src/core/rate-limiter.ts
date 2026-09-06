import { StoreTimeoutError, ValidationError } from './errors';
import {
  Algorithm,
  AlgorithmName,
  CheckInput,
  Clock,
  DegradationLogger,
  FallbackEvent,
  FailureMode,
  RateLimiterOptions,
  RateLimitResult,
  RateLimitRule,
} from './types';
import type { Store } from '../stores/store';

/**
 * Reusable rate-limiting core. Independent of Express.
 *
 * Flow: check(key, rule) -> resolve algorithm -> atomic store transition
 *       -> Allow/Deny + metadata.
 * Failure path (explicit, Phase 5):
 *   primary timeout/error -> warn log -> MemoryStore fallback (if enabled)
 *   -> fail-open (allow, limit 0) or fail-closed (throw).
 * A slow Redis can therefore never become the main request-latency source:
 * every store call races against `timeoutMs`.
 */
export class RateLimiter {
  private readonly store: Store;
  private readonly fallbackStore?: Store;
  private readonly defaultRule?: RateLimitRule;
  private readonly failureMode: FailureMode;
  private readonly timeoutMs: number;
  private readonly enableFallback: boolean;
  private readonly clock: Clock;
  private readonly logger?: DegradationLogger;
  private readonly onFallback?: (event: FallbackEvent) => void;
  private readonly algorithms = new Map<AlgorithmName, Algorithm<any>>();

  constructor(options: RateLimiterOptions) {
    if (!options?.store) throw new ValidationError('RateLimiter requires a store');
    this.store = options.store;
    this.fallbackStore = options.fallbackStore;
    this.defaultRule = options.defaultRule;
    this.failureMode = options.failureMode ?? 'fail-closed';
    this.timeoutMs = options.timeoutMs ?? 150;
    this.enableFallback = options.enableFallback ?? false;
    this.clock = options.clock ?? Date.now;
    this.logger = options.logger;
    this.onFallback = options.onFallback;
  }

  registerAlgorithm<TRule extends RateLimitRule>(algorithm: Algorithm<TRule>): this {
    this.algorithms.set(algorithm.name, algorithm);
    return this;
  }

  static buildKey(prefix: string | undefined, key: string): string {
    const clean = key.trim();
    if (!clean) throw new ValidationError('rate-limit key must be a non-empty string');
    if (clean.length > 512) throw new ValidationError('rate-limit key exceeds 512 characters');
    return prefix ? `${prefix}:${clean}` : clean;
  }

  static validateRule(rule: RateLimitRule): void {
    if (!rule || typeof rule !== 'object') throw new ValidationError('rule must be an object');
    switch (rule.algorithm) {
      case 'fixed-window':
      case 'sliding-window':
        if (!Number.isFinite(rule.limit) || rule.limit <= 0) {
          throw new ValidationError(`${rule.algorithm}: limit must be a positive number`);
        }
        if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) {
          throw new ValidationError(`${rule.algorithm}: windowMs must be a positive number`);
        }
        break;
      case 'token-bucket':
        if (!Number.isFinite(rule.capacity) || rule.capacity <= 0) {
          throw new ValidationError('token-bucket: capacity must be a positive number');
        }
        if (!Number.isFinite(rule.refillRatePerSec) || rule.refillRatePerSec <= 0) {
          throw new ValidationError('token-bucket: refillRatePerSec must be a positive number');
        }
        break;
      case 'leaky-bucket':
        if (!Number.isFinite(rule.capacity) || rule.capacity <= 0) {
          throw new ValidationError('leaky-bucket: capacity must be a positive number');
        }
        if (!Number.isFinite(rule.leakRatePerSec) || rule.leakRatePerSec <= 0) {
          throw new ValidationError('leaky-bucket: leakRatePerSec must be a positive number');
        }
        break;
      default:
        throw new ValidationError(`unknown algorithm: ${(rule as { algorithm: string }).algorithm}`);
    }
  }

  async check(key: string, rule?: RateLimitRule, now?: number): Promise<RateLimitResult>;
  async check(input: CheckInput): Promise<RateLimitResult>;
  async check(
    keyOrInput: string | CheckInput,
    ruleOverride?: RateLimitRule,
    nowOverride?: number,
  ): Promise<RateLimitResult> {
    const input: CheckInput =
      typeof keyOrInput === 'string' ? { key: keyOrInput, rule: ruleOverride, now: nowOverride } : keyOrInput;

    const rule = input.rule ?? this.defaultRule;
    if (!rule) throw new ValidationError('no rate-limit rule provided and no defaultRule configured');
    RateLimiter.validateRule(rule);
    void (input.cost ?? 1); // cost > 1 reserved for a later phase; validated then.

    const storeKey = RateLimiter.buildKey(rule.keyPrefix, input.key);
    const algorithm = this.algorithms.get(rule.algorithm);
    if (!algorithm) {
      throw new ValidationError(`no algorithm registered for "${rule.algorithm}"`);
    }

    const now = input.now ?? this.clock();
    try {
      return await this.withTimeout(
        algorithm.tryConsume(storeKey, rule, this.store, now),
        this.timeoutMs,
        this.store.name,
        'tryConsume',
      );
    } catch (err) {
      this.logger?.warn(
        { primary: this.store.name, key: storeKey, error: err instanceof Error ? err.message : String(err) },
        'rate-limiter primary store failed',
      );
      if (this.enableFallback && this.fallbackStore) {
        try {
          const result = await this.withTimeout(
            algorithm.tryConsume(storeKey, rule, this.fallbackStore, now),
            this.timeoutMs,
            this.fallbackStore.name,
            'tryConsume(fallback)',
          );
          this.logger?.warn(
            { from: this.store.name, to: this.fallbackStore.name, key: storeKey },
            'rate-limiter degraded fallback engaged',
          );
          this.onFallback?.({ from: this.store.name, to: this.fallbackStore.name, key: storeKey, error: err });
          return result;
        } catch (fallbackErr) {
          this.logger?.error(
            {
              primary: this.store.name,
              fallback: this.fallbackStore.name,
              error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
            },
            'rate-limiter fallback store also failed',
          );
        }
      }
      if (this.failureMode === 'fail-open') {
        return {
          allowed: true,
          limit: 0,
          remaining: 0,
          resetMs: now + 1000,
          retryAfterMs: 0,
          algorithm: rule.algorithm,
        };
      }
      throw err;
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, store: string, op: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StoreTimeoutError(store, op, ms)), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
