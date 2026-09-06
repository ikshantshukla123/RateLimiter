import type { TokenBucketRule, RateLimitResult } from '../core/types';
import type { Store } from '../stores/store';

/** Phase 2: token bucket. Stub for Phase 1 module graph. */
export class TokenBucketAlgorithm {
  readonly name = 'token-bucket' as const;
  async tryConsume(_key: string, _rule: TokenBucketRule, _store: Store, _now?: number): Promise<RateLimitResult> {
    void _key;
    void _rule;
    void _store;
    void _now;
    throw new Error('TokenBucketAlgorithm: not implemented yet (Phase 2)');
  }
}
