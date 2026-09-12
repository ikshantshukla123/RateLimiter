import { Router } from 'express';
import type { RateLimiter } from '../core/rate-limiter';
import { labState } from '../lab/lab-state';
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
    // Lab-aware: rules + key strategy resolve live per request so the
    // dashboard sliders apply instantly with no restart.
    router.use('/api/', (req, _res, next) => {
      const live = labState.getRules();
      const mw = createRateLimitMiddleware({
        limiter: options.limiter!,
        metrics: options.metrics,
        keyBy: live.keyBy,
        defaultRule: live.defaultRule,
        routeRules: { '/api/expensive': live.expensiveRule },
      });
      mw(req, _res, next);
    });
  }

  router.get('/api/data', (req, res) => {
    res.json(dummyBackendResponse(req.path));
  });

  router.get('/api/expensive', (req, res) => {
    res.json({ ...dummyBackendResponse(req.path), expensive: true });
  });

  return router;
}
