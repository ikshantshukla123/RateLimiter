import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { registerAllAlgorithms } from '../../../src/algorithms';
import { RateLimiter } from '../../../src/core/rate-limiter';
import { createServer } from '../../../src/gateway/server';
import { withMetrics } from '../../../src/observability/instrumented-store';
import { PrometheusMetrics, noopMetrics } from '../../../src/observability/metrics';
import { MemoryStore } from '../../../src/stores/memory-store';

describe('PrometheusMetrics', () => {
  it('records decisions, latency, store ops and fallbacks', async () => {
    const metrics = new PrometheusMetrics();
    metrics.observeDecision('token-bucket', '/api/data', true);
    metrics.observeDecision('token-bucket', '/api/data', false);
    metrics.observeLatency('token-bucket', 0.005);
    metrics.observeStoreOperation('memory', 'get', true);
    metrics.observeStoreOperation('redis', 'evaluate', false);
    metrics.observeFallback('redis', 'memory');

    const { body } = await metrics.exposition();
    expect(body).toContain('rate_limiter_decisions_total');
    expect(body).toContain('rate_limiter_latency_seconds');
    expect(body).toContain('rate_limiter_store_operations_total');
    expect(body).toContain('rate_limiter_store_errors_total');
    expect(body).toContain('rate_limiter_fallback_total');
  });

  it('noopMetrics never throws (safe default)', () => {
    expect(() => {
      noopMetrics.observeDecision('a', 'r', true);
      noopMetrics.observeLatency('a', 0.1);
      noopMetrics.observeStoreOperation('s', 'op', false);
      noopMetrics.observeFallback('a', 'b');
    }).not.toThrow();
  });

  it('instrumented store counts ok/error operations', async () => {
    const metrics = new PrometheusMetrics();
    const store = withMetrics(new MemoryStore({ cleanupIntervalMs: 0 }), metrics);
    await store.set('k', { v: 1 }, 1000);
    await store.get('k');
    await expect(store.set('bad', 1, 0)).rejects.toThrow();
    const { body } = await metrics.exposition();
    expect(body).toContain('store="memory"');
    await store.close?.();
  });
});

describe('GET /metrics', () => {
  it('exposes decisions after traffic', async () => {
    const metrics = new PrometheusMetrics();
    const store = withMetrics(new MemoryStore({ cleanupIntervalMs: 0 }), metrics);
    const limiter = registerAllAlgorithms(
      new RateLimiter({
        store,
        failureMode: 'fail-closed',
        onFallback: (e) => metrics.observeFallback(e.from, e.to),
      }),
    );
    const app = createServer({ limiter, metrics });
    await request(app).get('/api/data');
    await request(app).get('/api/data');

    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('rate_limiter_decisions_total');
    expect(res.text).toContain('algorithm="token-bucket"');
    await store.close?.();
  });

  it('/metrics is not rate-limited', async () => {
    const metrics = new PrometheusMetrics();
    const limiter = registerAllAlgorithms(
      new RateLimiter({ store: new MemoryStore({ cleanupIntervalMs: 0 }), failureMode: 'fail-closed' }),
    );
    const app = createServer({ limiter, metrics });
    for (let i = 0; i < 30; i++) await request(app).get('/api/data');
    expect((await request(app).get('/api/data')).status).toBe(429);
    expect((await request(app).get('/metrics')).status).toBe(200);
  });
});
