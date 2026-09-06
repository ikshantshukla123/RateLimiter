import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { RateLimiter } from '../../core/rate-limiter';
import type { RateLimitRule } from '../../core/types';
import type { MetricsRecorder } from '../../observability/metrics';

export type KeySource = 'ip' | 'apiKey' | 'userId' | 'route';

export interface RateLimitMiddlewareOptions {
  limiter: RateLimiter;
  /** Rule applied when the route has no specific rule. */
  defaultRule?: RateLimitRule;
  /** Per-route rules, matched on `req.path` prefix. */
  routeRules?: Record<string, RateLimitRule>;
  keyBy?: KeySource;
  metrics?: MetricsRecorder;
}

/** Explicit, testable key-selection strategy (agent.md §10). */
export function resolveKey(req: Request, keyBy: KeySource = 'ip'): string {
  switch (keyBy) {
    case 'apiKey': {
      const fromHeader = req.header('x-api-key');
      const fromQuery = typeof req.query.api_key === 'string' ? req.query.api_key : undefined;
      if (fromHeader ?? fromQuery) return `apikey:${fromHeader ?? fromQuery}`;
      break;
    }
    case 'userId': {
      const header = req.header('x-user-id');
      const nested = (req as Request & { user?: { id?: string } }).user?.id;
      if (header ?? nested) return `user:${header ?? nested}`;
      break;
    }
    case 'route':
      return `route:${req.path}`;
    case 'ip':
    default:
      break;
  }
  // Default / fallback: IP. req.ip is Express-aware (trust proxy settings).
  // Combine route + identity so one abusive route does not starve others.
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  return `${keyBy}:${ip}:${req.path}`;
}

function resolveRule(req: Request, options: RateLimitMiddlewareOptions): RateLimitRule | undefined {
  if (options.routeRules) {
    // Longest-prefix match so `/api/v1` beats `/api`.
    const entries = Object.entries(options.routeRules).sort((a, b) => b[0].length - a[0].length);
    for (const [prefix, rule] of entries) {
      if (req.path.startsWith(prefix)) return rule;
    }
  }
  return options.defaultRule;
}

function setRateLimitHeaders(
  res: Response,
  result: { limit: number; remaining: number; resetMs: number },
): void {
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
}

/**
 * Express middleware: identity -> rule -> RateLimiter.check ->
 * 429 + Retry-After on deny, otherwise `next()` toward the proxy/backend.
 */
export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions): RequestHandler {
  const metrics = options.metrics;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rule = resolveRule(req, options);
    if (!rule) {
      next();
      return;
    }
    const key = resolveKey(req, options.keyBy ?? 'ip');
    const started = process.hrtime.bigint();
    try {
      const result = await options.limiter.check({ key, rule });
      const elapsedSec = Number(process.hrtime.bigint() - started) / 1e9;
      metrics?.observeDecision(rule.algorithm, req.path, result.allowed);
      metrics?.observeLatency(rule.algorithm, elapsedSec);
      setRateLimitHeaders(res, result);
      if (!result.allowed) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
        res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please retry later.',
          limit: result.limit,
          remaining: result.remaining,
          retryAfterMs: result.retryAfterMs,
          resetMs: result.resetMs,
        });
        return;
      }
      next();
    } catch (err) {
      // Limiter failures already applied fail-open/fail-closed inside RateLimiter.
      // If we still land here (no rule default / unexpected), fail closed loudly
      // in non-production so misconfiguration surfaces fast.
      if (process.env.NODE_ENV !== 'production') {
        next(err);
        return;
      }
      res.status(500).json({ error: 'Internal Server Error' });
    }
  };
}
