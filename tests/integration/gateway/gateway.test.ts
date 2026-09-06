import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { registerAllAlgorithms } from '../../../src/algorithms';
import { RateLimiter } from '../../../src/core/rate-limiter';
import { createServer } from '../../../src/gateway/server';
import { MemoryStore } from '../../../src/stores/memory-store';

function buildApp() {
  const store = new MemoryStore({ cleanupIntervalMs: 0 });
  const limiter = registerAllAlgorithms(new RateLimiter({ store, failureMode: 'fail-closed' }));
  return { store, app: createServer({ limiter }) };
}

describe('gateway integration', () => {
  it('GET /health is unprotected', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('allows traffic then returns 429 with headers once the bucket drains', async () => {
    const { app } = buildApp();
    // Default /api/data rule: token-bucket capacity 20, refill 2/s.
    for (let i = 0; i < 20; i++) {
      const res = await request(app).get('/api/data');
      expect(res.status).toBe(200);
    }
    const denied = await request(app).get('/api/data');
    expect(denied.status).toBe(429);
    expect(denied.headers['x-ratelimit-limit']).toBe('20');
    expect(denied.headers['x-ratelimit-remaining']).toBe('0');
    expect(denied.headers['retry-after']).toBeDefined();
    expect(denied.body.error).toMatch(/Too Many Requests/);
  });

  it('sets rate-limit headers on allowed responses', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/data');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('bursts 50 concurrent requests: exactly capacity succeeds', async () => {
    const { app } = buildApp();
    const results = await Promise.all(Array.from({ length: 50 }, () => request(app).get('/api/data')));
    expect(results.filter((r) => r.status === 200).length).toBe(20);
    expect(results.filter((r) => r.status === 429).length).toBe(30);
  });
});
