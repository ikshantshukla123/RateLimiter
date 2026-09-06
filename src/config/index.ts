import type { RateLimitRule } from '../core/types';

export interface GatewayRouteConfig {
  path: string;
  /** Limiting identity source for this route. */
  keyBy?: 'ip' | 'apiKey' | 'userId' | 'route';
  rule: RateLimitRule;
}

export interface AppConfig {
  env: string;
  port: number;
  backendUrl: string;
  redisUrl: string;
  storeTimeoutMs: number;
  failureMode: 'fail-open' | 'fail-closed';
  enableFallback: boolean;
  defaultRule: RateLimitRule;
  routes: GatewayRouteConfig[];
}

function num(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    env: env.NODE_ENV ?? 'development',
    port: num(env.PORT, 3000),
    backendUrl: env.BACKEND_URL ?? 'http://localhost:3001',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    storeTimeoutMs: num(env.STORE_TIMEOUT_MS, 150),
    failureMode: env.FAILURE_MODE === 'fail-open' ? 'fail-open' : 'fail-closed',
    enableFallback: (env.ENABLE_FALLBACK ?? 'true') !== 'false',
    defaultRule: {
      algorithm: 'token-bucket',
      capacity: num(env.DEFAULT_CAPACITY, 100),
      refillRatePerSec: num(env.DEFAULT_REFILL_PER_SEC, 10),
      keyPrefix: 'rl',
    },
    routes: [],
  };
}
