import 'dotenv/config';
import { registerAllAlgorithms } from './algorithms';
import { loadConfig } from './config';
import { RateLimiter } from './core/rate-limiter';
import { createServer } from './gateway/server';
import { logger } from './observability/logger';
import { MemoryStore } from './stores/memory-store';
import { RedisStore } from './stores/redis-store';
import type { Store } from './stores/store';

const config = loadConfig();

// Store topology (agent.md §12):
//   USE_REDIS=true  -> Redis primary (fleet-wide) + MemoryStore degraded fallback.
//   otherwise       -> single-instance MemoryStore (local dev / tests).
// Either way a slow dependency is bounded by `storeTimeoutMs` and the failure
// mode stays explicit (fail-open vs fail-closed).
const useRedis = (process.env.USE_REDIS ?? 'false').toLowerCase() === 'true';

let primary: Store;
let fallback: Store | undefined;
if (useRedis) {
  primary = new RedisStore({ redisUrl: config.redisUrl });
  fallback = new MemoryStore();
  logger.info({ redisUrl: '<redacted>', fallback: 'memory' }, 'using Redis primary with memory fallback');
} else {
  primary = new MemoryStore();
}

const limiter = registerAllAlgorithms(
  new RateLimiter({
    store: primary,
    fallbackStore: fallback,
    defaultRule: config.defaultRule,
    failureMode: config.failureMode,
    timeoutMs: config.storeTimeoutMs,
    enableFallback: config.enableFallback && !!fallback,
    logger,
  }),
);

const app = createServer({ limiter, backendUrl: config.backendUrl, enableProxy: false });

if (require.main === module) {
  app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env, store: primary.name }, 'gateway listening');
  });
}

export default app;
export { config, limiter };
export const store = primary;
export const fallbackStore = fallback;
