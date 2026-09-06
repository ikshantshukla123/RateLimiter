import type { LeakyBucketRule, RateLimitResult } from '../core/types';
import type { Store } from '../stores/store';

/** Phase 2: leaky bucket. Stub for Phase 1 module graph. */
export class LeakyBucketAlgorithm {
  readonly name = 'leaky-bucket' as const;
  async tryConsume(_key: string, _rule: LeakyBucketRule, _store: Store, _now?: number): Promise<RateLimitResult> {
    void _key;
    void _rule;
    void _store;
    void _now;
    throw new Error('LeakyBucketAlgorithm: not implemented yet (Phase 2)');
  }
}
