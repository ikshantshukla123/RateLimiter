import type { Algorithm, RateLimitRule } from '../core/types';
import type { Store } from '../stores/store';

/**
 * Phase 2 implements these four algorithms with unit tests.
 * Stubs below keep the module graph + dependency direction verifiable in Phase 1.
 */
export abstract class BaseAlgorithmStub<TRule extends RateLimitRule> implements Algorithm<TRule> {
  abstract readonly name: Algorithm<TRule>['name'];
  async tryConsume(): Promise<never> {
    throw new Error(`${this.name}: not implemented yet (Phase 2)`);
  }
}
