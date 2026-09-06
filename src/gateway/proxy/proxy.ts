import { createProxyMiddleware } from 'http-proxy-middleware';
import type { Express, RequestHandler } from 'express';

/**
 * Mount a transparent reverse proxy for allowed traffic:
 *   Gateway (rate-limit decision) -> downstream backend.
 * Errors from the backend surface as 502 so limiter 429s stay distinct.
 */
export function mountProxy(app: Express, backendUrl: string, mountPath = '/proxy'): void {
  const proxy: RequestHandler = createProxyMiddleware({
    target: backendUrl,
    changeOrigin: true,
    pathRewrite: { [`^${mountPath}`]: '' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: (_err: any, _req: any, res: any) => {
        if (res && typeof res.status === 'function' && !res.headersSent) {
          res.status(502).json({ error: 'Bad Gateway', message: 'Downstream backend unavailable' });
        }
      },
    } as never,
  });
  app.use(mountPath, proxy);
}

/** Minimal dummy downstream backend (used by docker-compose + local demo). */
export function dummyBackendResponse(path: string): Record<string, unknown> {
  return { ok: true, backend: 'dummy', path, servedAt: new Date().toISOString() };
}
