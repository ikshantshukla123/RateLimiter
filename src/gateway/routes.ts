import { Router } from 'express';
import type { RateLimiter } from '../core/rate-limiter';
import type { MetricsRecorder } from '../observability/metrics';
import { createRateLimitMiddleware } from './middleware/rate-limit-middleware';
import { dummyBackendResponse } from './proxy/proxy';

export interface RoutesOptions {
  limiter?: RateLimiter;
  metrics?: MetricsRecorder;
}

/**
 * Demo surface:
 *   GET /health        -> liveness (never rate-limited)
 *   GET /api/data      -> rate-limited, then dummy backend payload
 *   GET /api/expensive -> strict rule example (wired via routeRules when limiter present)
 */
export function buildRoutes(options: RoutesOptions = {}): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (options.limiter) {
    router.use(
      '/api/',
      createRateLimitMiddleware({
        limiter: options.limiter,
        metrics: options.metrics,
        keyBy: 'ip',
        defaultRule: {
          algorithm: 'token-bucket',
          capacity: 20,
          refillRatePerSec: 2,
          keyPrefix: 'rl',
        },
        routeRules: {
          '/api/expensive': {
            algorithm: 'fixed-window',
            limit: 5,
            windowMs: 60_000,
            keyPrefix: 'rl',
          },
        },
      }),
    );
  }

  router.get('/api/data', (req, res) => {
    res.json(dummyBackendResponse(req.path));
  });

  router.get('/api/expensive', (req, res) => {
    res.json({ ...dummyBackendResponse(req.path), expensive: true });
  });

  return router;
}
