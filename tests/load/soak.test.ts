import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { registerAllAlgorithms } from '../../src/algorithms';
import { RateLimiter } from '../../src/core/rate-limiter';
import { createServer } from '../../src/gateway/server';
import { MemoryStore } from '../../src/stores/memory-store';

/**
 * Soak/burst correctness at the HTTP layer (runs in CI without k6).
 * k6 in tests/load/rate-limiter.js covers realistic traffic shapes;
 * this file asserts the same invariants deterministically.
 */
function buildApp() {
  const store = new MemoryStore({ cleanupIntervalMs: 0 });
  const limiter = registerAllAlgorithms(new RateLimiter({ store, failureMode: 'fail-closed' }));
  return createServer({ limiter });
}

describe('load invariants', () => {
  it('sustained sequential traffic: denies cluster after capacity, refill recovers', async () => {
    const app = buildApp();
    let allowed = 0;
    for (let i = 0; i < 40; i++) {
      const res = await request(app).get('/api/data');
      if (res.status === 200) allowed++;
      else expect(res.status).toBe(429);
    }
    // Capacity 20 with 2/s refill: sequential supertest run refills a few tokens mid-run.
    expect(allowed).toBeGreaterThanOrEqual(20);
    expect(allowed).toBeLessThan(40);
  }, 30000);

  it('burst from one IP: exactly capacity passes (shared-key contention is correct)', async () => {
    const app = buildApp();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        request(app).get('/api/data').set('X-Forwarded-For', `10.0.0.${i}`),
      ),
    );
    // NOTE: supertest against one Express app shares 127.0.0.1 as req.ip
    // (trust-proxy off), so all 50 share one limiter key: expect exactly 20 allowed.
    // This documents the IP-keying behavior; per-user isolation is covered at
    // the core layer (concurrency.test.ts) and via x-api-key keying.
    expect(results.filter((r) => r.status === 200).length).toBe(20);
  });

  it('429 responses always carry retry metadata', async () => {
    const app = buildApp();
    for (let i = 0; i < 25; i++) await request(app).get('/api/data');
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/data');
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.body.retryAfterMs).toBeGreaterThan(0);
      expect(res.body.resetMs).toBeGreaterThan(0);
    }
  });
});
