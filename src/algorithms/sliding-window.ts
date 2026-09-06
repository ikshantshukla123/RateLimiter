import type { SlidingWindowRule, RateLimitResult } from '../core/types';
import type { Store } from '../stores/store';

/** Phase 2: sliding-window counter. Stub for Phase 1 module graph. */
export class SlidingWindowAlgorithm {
  readonly name = 'sliding-window' as const;
  async tryConsume(_key: string, _rule: SlidingWindowRule, _store: Store, _now?: number): Promise<RateLimitResult> {
    void _key;
    void _rule;
    void _store;
    void _now;
    throw new Error('SlidingWindowAlgorithm: not implemented yet (Phase 2)');
  }
}
