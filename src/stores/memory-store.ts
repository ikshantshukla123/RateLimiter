import type { Store } from './store';

/**
 * Phase 2 provides the full in-memory implementation (TTL map, expiry sweep,
 * atomic increment helper). Stub here so Phase 1 compiles.
 */
export class MemoryStore implements Store {
  readonly name = 'memory';
  async get<T>(_key: string): Promise<T | null> {
    void _key;
    throw new Error('MemoryStore: not implemented yet (Phase 2)');
  }
  async set<T>(_key: string, _value: T, _ttlMs: number): Promise<void> {
    void _key;
    void _value;
    void _ttlMs;
    throw new Error('MemoryStore: not implemented yet (Phase 2)');
  }
  async delete(_key: string): Promise<void> {
    void _key;
    throw new Error('MemoryStore: not implemented yet (Phase 2)');
  }
}
