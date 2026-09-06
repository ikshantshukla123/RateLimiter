import type { RateLimitRule } from '../core/types';

/** Named limit presets. Gateway resolves a route -> one of these rules. */
export const limitPresets: Record<string, RateLimitRule> = {
  // General API traffic: bursty but bounded on average.
  apiDefault: { algorithm: 'token-bucket', capacity: 100, refillRatePerSec: 10, keyPrefix: 'rl' },
  // Expensive endpoint: strict fixed window.
  strict: { algorithm: 'fixed-window', limit: 20, windowMs: 60_000, keyPrefix: 'rl' },
  // Smooth high-throughput endpoint.
  smooth: { algorithm: 'sliding-window', limit: 200, windowMs: 60_000, keyPrefix: 'rl' },
  // Downstream-sensitive endpoint: constant output shaping.
  shaped: { algorithm: 'leaky-bucket', capacity: 50, leakRatePerSec: 5, keyPrefix: 'rl' },
};
