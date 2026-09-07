import 'dotenv/config';
import { registerAllAlgorithms } from './algorithms';
import { loadConfig } from './config';
import { RateLimiter } from './core/rate-limiter';
import { createServer } from './gateway/server';
import { withMetrics } from './observability/instrumented-store';
import { logger } from './observability/logger';
import { PrometheusMetrics } from './observability/metrics';
import { MemoryStore } from './stores/memory-store';
import { RedisStore } from './stores/redis-store';
import type { Store } from './stores/store';

const config = loadConfig();
const metrics = new PrometheusMetrics();


const useRedis = (process.env.USE_REDIS ?? 'false').toLowerCase() === 'true';

const rawPrimary: Store = useRedis ? new RedisStore({ redisUrl: config.redisUrl }) : new MemoryStore();
const rawFallback: Store | undefined = useRedis ? new MemoryStore() : undefined;
if (useRedis) logger.info({ fallback: 'memory' }, 'using Redis primary with memory fallback');

const primary = withMetrics(rawPrimary, metrics);
const fallback = rawFallback ? withMetrics(rawFallback, metrics) : undefined;

const limiter = registerAllAlgorithms(
  new RateLimiter({
    store: primary,
    fallbackStore: fallback,
    defaultRule: config.defaultRule,
    failureMode: config.failureMode,
    timeoutMs: config.storeTimeoutMs,
    enableFallback: config.enableFallback && !!fallback,
    logger,
    onFallback: (e) => metrics.observeFallback(e.from, e.to),
  }),
);

const app = createServer({ limiter, backendUrl: config.backendUrl, enableProxy: true, metrics });

if (require.main === module) {
  app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env, store: primary.name }, 'gateway listening');
  });
}

export default app;
export { config, limiter, metrics };
export const store = primary;
export const fallbackStore = fallback;
