import type { NextFunction, Request, Response } from 'express';

/** Phase 3: extracts identity, calls RateLimiter, returns 429 or proxies. */
export function rateLimitMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  void _req;
  void _res;
  next();
}

export function resolveKey(_req: Request): string {
  void _req;
  return 'stub';
}
