import express from 'express';
import type { RateLimiter } from '../core/rate-limiter';
import type { MetricsRecorder } from '../observability/metrics';
import { mountProxy } from './proxy/proxy';
import { buildRoutes } from './routes';

export interface ServerOptions {
  limiter?: RateLimiter;
  backendUrl?: string;
  enableProxy?: boolean;
  metrics?: MetricsRecorder;
}

export function createServer(options: ServerOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  if (options.enableProxy && options.backendUrl) {
    mountProxy(app, options.backendUrl);
  }

  app.use('/', buildRoutes({ limiter: options.limiter, metrics: options.metrics }));

  // 404 + error handler (kept last).
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Internal Server Error', message });
  });

  return app;
}
