import express from 'express';
import { buildRoutes } from './routes';

/** Phase 3 wires limiter + proxy + metrics. Phase 1: bare Express shell. */
export function createServer(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', buildRoutes());
  return app;
}
