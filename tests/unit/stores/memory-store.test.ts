import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../../src/stores/memory-store';

describe('MemoryStore', () => {
  it('stores, retrieves and deletes values', async () => {
    const store = new MemoryStore();
    expect(await store.get('missing')).toBeNull();
    await store.set('k', { n: 1 }, 1000);
    expect(await store.get('k')).toEqual({ n: 1 });
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
    await store.close();
  });

  it('expires keys after TTL (fake clock)', async () => {
    let now = 1_000_000;
    const store = new MemoryStore({ clock: () => now, cleanupIntervalMs: 0 });
    await store.set('k', 'v', 100);
    expect(await store.get('k')).toBe('v');
    now += 101;
    expect(await store.get('k')).toBeNull();
    await store.close();
  });

  it('atomic increment keeps one TTL window', async () => {
    const store = new MemoryStore({ cleanupIntervalMs: 0 });
    expect(await store.incrementWithTtl!('c', 1000)).toBe(1);
    expect(await store.incrementWithTtl!('c', 1000)).toBe(2);
    expect(await store.get('c')).toBe(2);
    await store.close();
  });

  it('serializes concurrent increments without lost updates', async () => {
    const store = new MemoryStore({ cleanupIntervalMs: 0 });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => store.incrementWithTtl!('hot', 60_000)),
    );
    expect(new Set(results).size).toBe(50);
    expect(await store.get('hot')).toBe(50);
    await store.close();
  });
});
