import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../../src/core/rate-limiter';

describe('Phase 1 core contracts', () => {
  it('builds namespaced keys and rejects empty keys', () => {
    expect(RateLimiter.buildKey('rl', 'user:123')).toBe('rl:user:123');
    expect(RateLimiter.buildKey(undefined, 'abc')).toBe('abc');
    expect(() => RateLimiter.buildKey('rl', '   ')).toThrow();
  });

  it('validates rules per algorithm', () => {
    expect(() =>
      RateLimiter.validateRule({ algorithm: 'fixed-window', limit: 10, windowMs: 1000 }),
    ).not.toThrow();
    expect(() =>
      RateLimiter.validateRule({ algorithm: 'token-bucket', capacity: 10, refillRatePerSec: 1 }),
    ).not.toThrow();
    expect(() => RateLimiter.validateRule({ algorithm: 'fixed-window', limit: 0, windowMs: 1000 } as any)).toThrow();
    expect(() => RateLimiter.validateRule({ algorithm: 'token-bucket', capacity: 10, refillRatePerSec: 0 } as any)).toThrow();
    expect(() => RateLimiter.validateRule({ algorithm: 'nope' } as any)).toThrow();
  });
});
