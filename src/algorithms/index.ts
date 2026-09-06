import { FixedWindowAlgorithm } from '../algorithms/fixed-window';
import { LeakyBucketAlgorithm } from '../algorithms/leaky-bucket';
import { SlidingWindowAlgorithm } from '../algorithms/sliding-window';
import { TokenBucketAlgorithm } from '../algorithms/token-bucket';

// Algorithm stubs: real logic lands in Phase 2. Re-exported here so the
// gateway/core wiring can be type-checked from Phase 1 onward.
export { FixedWindowAlgorithm } from '../algorithms/fixed-window';
export { SlidingWindowAlgorithm } from '../algorithms/sliding-window';
export { TokenBucketAlgorithm } from '../algorithms/token-bucket';
export { LeakyBucketAlgorithm } from '../algorithms/leaky-bucket';

export const allAlgorithms = [
  FixedWindowAlgorithm,
  SlidingWindowAlgorithm,
  TokenBucketAlgorithm,
  LeakyBucketAlgorithm,
];
