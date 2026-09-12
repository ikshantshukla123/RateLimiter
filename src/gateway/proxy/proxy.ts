import { createProxyMiddleware } from 'http-proxy-middleware';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { RateLimiter } from '../../core/rate-limiter';
import { labState } from '../../lab/lab-state';
import type { MetricsRecorder } from '../../observability/metrics';
import { createRateLimitMiddleware } from '../middleware/rate-limit-middleware';

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

const BLOCKED_TUNNEL_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.google',
  'metadata.goog',
  '100.100.100.200',
]);

const MAX_TUNNEL_BYTES = 5_000_000;

/** Validate a user-supplied backend URL. Returns an error message or null when OK. */
export function validateCustomBackendUrl(raw: string): string | null {
  if (raw.length > 500) return 'URL too long (max 500 characters).';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'Not a valid URL. Include http(s)://, e.g. https://api.example.com/items';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'Only http:// and https:// backends are supported.';
  }
  if (!u.hostname) return 'URL must include a hostname.';
  if (BLOCKED_TUNNEL_HOSTS.has(u.hostname.toLowerCase())) {
    return 'That host is blocked (cloud metadata). Use your own server URL.';
  }
  if (u.username || u.password) return 'URLs with embedded credentials are not accepted.';
  return null;
}

/**
 * "Bring your own backend" tunnel:
 *   Client -> /tunnel/* -> rate-limit decision -> your server URL.
 * Allowed requests are forwarded; denied ones get 429 and never touch
 * the upstream. Unlike /proxy (fixed env target, unmetered), the tunnel
 * target is set live from the Lab dashboard and every request is metered
 * with the Lab's current rule + key strategy.
 */
export function mountTunnel(app: Express, options: { limiter?: RateLimiter; metrics?: MetricsRecorder }): void {
  const limiter = options.limiter;
  if (!limiter) {
    app.use('/tunnel', (_req: Request, res: Response) => {
      res.status(503).json({ error: 'Limiter not configured' });
    });
    return;
  }

  // 1) Rate-limit gate (live Lab rule, same as /api/*).
  app.use('/tunnel', (req: Request, res: Response, next: (err?: unknown) => void) => {
    const live = labState.getRules();
    const mw = createRateLimitMiddleware({
      limiter,
      metrics: options.metrics,
      keyBy: live.keyBy,
      defaultRule: live.defaultRule,
    });
    mw(req, res, next);
  });

  // 2) Forward allowed traffic to the user-configured backend.
  app.use('/tunnel', async (req: Request, res: Response) => {
    const target = labState.customBackendUrl;
    if (!target) {
      res
        .status(400)
        .json({ error: 'No backend configured', message: 'Paste your server URL in the Lab dashboard first.' });
      return;
    }
    let base: URL;
    try {
      base = new URL(target);
    } catch {
      res.status(400).json({ error: 'Configured backend URL is invalid. Save a valid URL and retry.' });
      return;
    }
    const suffix = req.url.startsWith('/') ? req.url : `/${req.url}`;
    const upstreamUrl = base.toString().replace(/\/+$/, '') + suffix;

    const hopHeaders = new Set([
      'host',
      'connection',
      'content-length',
      'transfer-encoding',
      'content-encoding',
      'keep-alive',
      'upgrade',
    ]);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!hopHeaders.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
    }
    let body: string | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
      const ctype = req.headers['content-type'] ?? '';
      if (typeof ctype === 'string' && ctype.includes('application/json') && req.body !== undefined) {
        body = JSON.stringify(req.body);
        headers['content-type'] = 'application/json';
      }
    }

    try {
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const declared = upstream.headers.get('content-length');
      if (declared && Number(declared) > MAX_TUNNEL_BYTES) {
        res.status(502).json({ error: 'Bad Gateway', message: 'Backend response too large (>5MB).' });
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length > MAX_TUNNEL_BYTES) {
        res.status(502).json({ error: 'Bad Gateway', message: 'Backend response too large (>5MB).' });
        return;
      }
      res.status(upstream.status);
      upstream.headers.forEach((v: string, k: string) => {
        const lk = k.toLowerCase();
        // Rate-limit headers are ours (set by the gate above); never let the
        // upstream overwrite them or confuse the dashboard.
        if (hopHeaders.has(lk) || lk.startsWith('x-ratelimit-') || lk === 'retry-after') return;
        try {
          res.setHeader(k, v);
        } catch {
          // ignore unsettable headers
        }
      });
      res.send(buf);
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      res.status(502).json({
        error: 'Bad Gateway',
        message: timedOut ? 'Backend timed out after 10s.' : 'Downstream backend unavailable.',
      });
    }
  });
}
