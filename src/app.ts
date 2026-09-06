import 'dotenv/config';
import { registerAllAlgorithms } from './algorithms';
import { loadConfig } from './config';
import { RateLimiter } from './core/rate-limiter';
import { createServer } from './gateway/server';
import { logger } from './observability/logger';
import { MemoryStore } from './stores/memory-store';

const config = loadConfig();

// Phase 3: single-instance memory backend. Phase 4 swaps in RedisStore
// (with MemoryStore retained as degraded fallback).
const store = new MemoryStore();
const limiter = registerAllAlgorithms(
  new RateLimiter({
    store,
    defaultRule: config.defaultRule,
    failureMode: config.failureMode,
    timeoutMs: config.storeTimeoutMs,
    enableFallback: false,
  }),
);

const app = createServer({ limiter, backendUrl: config.backendUrl, enableProxy: false });

if (require.main === module) {
  app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'gateway listening');
  });
}

export default app;
export { config, limiter, store };
