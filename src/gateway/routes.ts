import { Router } from 'express';

/** Phase 3: demo + health + metrics routes. */
export function buildRoutes(): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', phase: 1 });
  });
  return router;
}
