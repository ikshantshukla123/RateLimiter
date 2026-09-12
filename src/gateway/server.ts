import express from 'express';
import path from 'node:path';
import pinoHttp from 'pino-http';
import type { RateLimiter } from '../core/rate-limiter';
import { buildLabRouter } from '../lab/lab-router';
import { logger } from '../observability/logger';
import type { MetricsRecorder } from '../observability/metrics';
import { PrometheusMetrics } from '../observability/metrics';
import { mountProxy } from './proxy/proxy';
import { mountTunnel } from './proxy/proxy';
import { buildRoutes } from './routes';

export interface ServerOptions {
  limiter?: RateLimiter;
  backendUrl?: string;
  enableProxy?: boolean;
  metrics?: MetricsRecorder;
  applyResilience?: (patch: {
    failureMode?: 'fail-open' | 'fail-closed';
    timeoutMs?: number;
    enableFallback?: boolean;
  }) => void;
}

export function createServer(options: ServerOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  // Structured JSON request logs (silent in tests via logger).
  app.use(pinoHttp({ logger }));

  // Lab dashboard (real-time control plane). Static assets live in /public.
  const publicDir = path.join(__dirname, '..', '..', 'public');
  app.use(express.static(publicDir));
  app.get('/lab', (_req, res) => {
    res.sendFile(path.join(publicDir, 'lab.html'));
  });
  app.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(publicDir, 'dashboard.html'));
  });
  app.use('/', buildLabRouter({ limiter: options.limiter, applyResilience: options.applyResilience }));

  if (options.enableProxy && options.backendUrl) {
    mountProxy(app, options.backendUrl);
  }

  app.use('/', buildRoutes({ limiter: options.limiter, metrics: options.metrics }));

  // Bring-your-own-backend tunnel (rate-limited, target set live via /lab/backend).
  mountTunnel(app, { limiter: options.limiter, metrics: options.metrics });

  // Prometheus scrape target. Never rate-limited; placed after buildRoutes on
  // purpose (buildRoutes only limits /api/*) but registered before 404.
  app.get('/metrics', async (_req, res, next) => {
    try {
      if (options.metrics instanceof PrometheusMetrics) {
        const { contentType, body } = await options.metrics.exposition();
        res.setHeader('Content-Type', contentType);
        res.send(body);
      } else {
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        res.send('# no prometheus registry configured\n');
      }
    } catch (err) {
      next(err);
    }
  });

  // 404 + error handler (kept last).
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    void _next;
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Internal Server Error', message });
  });

  return app;
}
