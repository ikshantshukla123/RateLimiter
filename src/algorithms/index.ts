import type { RateLimiter } from '../core/rate-limiter';
import { FixedWindowAlgorithm } from '../algorithms/fixed-window';
import { LeakyBucketAlgorithm } from '../algorithms/leaky-bucket';
import { SlidingWindowAlgorithm } from '../algorithms/sliding-window';
import { TokenBucketAlgorithm } from '../algorithms/token-bucket';

export { FixedWindowAlgorithm } from '../algorithms/fixed-window';
export { SlidingWindowAlgorithm } from '../algorithms/sliding-window';
export { TokenBucketAlgorithm } from '../algorithms/token-bucket';
export { LeakyBucketAlgorithm } from '../algorithms/leaky-bucket';

/** Register all four algorithms on a RateLimiter instance. */
export function registerAllAlgorithms(limiter: RateLimiter): RateLimiter {
  limiter
    .registerAlgorithm(new FixedWindowAlgorithm())
    .registerAlgorithm(new SlidingWindowAlgorithm())
    .registerAlgorithm(new TokenBucketAlgorithm())
    .registerAlgorithm(new LeakyBucketAlgorithm());
  return limiter;
}
