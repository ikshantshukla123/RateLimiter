import type { FixedWindowRule, RateLimitResult } from '../core/types';
import type { Store } from '../stores/store';

/** Phase 2: fixed-window counter. Stub for Phase 1 module graph. */
export class FixedWindowAlgorithm {
  readonly name = 'fixed-window' as const;
  async tryConsume(_key: string, _rule: FixedWindowRule, _store: Store, _now?: number): Promise<RateLimitResult> {
    void _key;
    void _rule;
    void _store;
    void _now;
    throw new Error('FixedWindowAlgorithm: not implemented yet (Phase 2)');
  }
}
