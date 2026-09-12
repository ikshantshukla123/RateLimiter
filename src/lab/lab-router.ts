import { Router } from 'express';
import { RateLimiter } from '../core/rate-limiter';
import type { RateLimitRule } from '../core/types';
import { validateCustomBackendUrl } from '../gateway/proxy/proxy';
import type { KeySource } from '../gateway/middleware/rate-limit-middleware';
import { labState } from './lab-state';

export interface LabRouterOptions {
  limiter?: RateLimiter;
  applyResilience?: (patch: {
    failureMode?: 'fail-open' | 'fail-closed';
    timeoutMs?: number;
    enableFallback?: boolean;
  }) => void;
}

function isKeySource(v: unknown): v is KeySource {
  return v === 'ip' || v === 'apiKey' || v === 'userId' || v === 'route';
}

function sanitizeRule(rule: unknown): RateLimitRule | undefined {
  if (!rule || typeof rule !== 'object') return undefined;
  try {
    RateLimiter.validateRule(rule as RateLimitRule);
    return rule as RateLimitRule;
  } catch {
    return undefined;
  }
}

export function buildLabRouter(options: LabRouterOptions = {}): Router {
  const router = Router();

  router.get('/lab/config', (_req, res) => {
    res.json({ ok: true, ...labState.getRules(), resilience: labState.snapshot().resilience });
  });

  router.post('/lab/config', (req, res) => {
    const body = (req.body ?? {}) as {
      defaultRule?: unknown;
      expensiveRule?: unknown;
      keyBy?: unknown;
    };
    const patch: { defaultRule?: RateLimitRule; expensiveRule?: RateLimitRule; keyBy?: KeySource } = {};
    if (body.defaultRule !== undefined) {
      const r = sanitizeRule(body.defaultRule);
      if (!r) {
        res.status(400).json({ ok: false, error: 'invalid defaultRule' });
        return;
      }
      patch.defaultRule = r;
    }
    if (body.expensiveRule !== undefined) {
      const r = sanitizeRule(body.expensiveRule);
      if (!r) {
        res.status(400).json({ ok: false, error: 'invalid expensiveRule' });
        return;
      }
      patch.expensiveRule = r;
    }
    if (body.keyBy !== undefined) {
      if (!isKeySource(body.keyBy)) {
        res.status(400).json({ ok: false, error: 'invalid keyBy' });
        return;
      }
      patch.keyBy = body.keyBy;
    }
    labState.setRules(patch);
    res.json({ ok: true, ...labState.getRules() });
  });

  router.get('/lab/status', (_req, res) => {
    res.json({ ok: true, snapshot: labState.snapshot() });
  });

  router.post('/lab/chaos', (req, res) => {
    const body = (req.body ?? {}) as {
      redisDown?: unknown;
      addedLatencyMs?: unknown;
      failureMode?: unknown;
      timeoutMs?: unknown;
      enableFallback?: unknown;
    };
    if (typeof body.redisDown === 'boolean') labState.chaos.redisDown = body.redisDown;
    if (typeof body.addedLatencyMs === 'number' && Number.isFinite(body.addedLatencyMs)) {
      labState.chaos.addedLatencyMs = Math.max(0, Math.min(2000, Math.floor(body.addedLatencyMs)));
    }
    const resiliencePatch: { failureMode?: 'fail-open' | 'fail-closed'; timeoutMs?: number; enableFallback?: boolean } = {};
    if (body.failureMode === 'fail-open' || body.failureMode === 'fail-closed') {
      labState.failureMode = body.failureMode;
      resiliencePatch.failureMode = body.failureMode;
    }
    if (typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)) {
      const t = Math.max(20, Math.min(2000, Math.floor(body.timeoutMs)));
      labState.timeoutMs = t;
      resiliencePatch.timeoutMs = t;
    }
    if (typeof body.enableFallback === 'boolean') {
      labState.enableFallback = body.enableFallback;
      resiliencePatch.enableFallback = body.enableFallback;
    }
    if (options.applyResilience && Object.keys(resiliencePatch).length > 0) {
      options.applyResilience(resiliencePatch);
    }
    // Force an immediate SSE push so toggles feel instant even with no traffic.
    labState.recordFallbackOnly();
    res.json({ ok: true, snapshot: labState.snapshot() });
  });

  router.post('/lab/reset', (_req, res) => {
    labState.resetStats();
    res.json({ ok: true });
  });

  // Bring-your-own-backend: point the /tunnel proxy at any server URL.
  router.post('/lab/backend', (req, res) => {
    const body = (req.body ?? {}) as { url?: unknown };
    if (typeof body.url !== 'string' || !body.url.trim()) {
      res.status(400).json({ ok: false, error: 'Provide a backend URL, e.g. https://api.example.com/items' });
      return;
    }
    const url = body.url.trim();
    const invalid = validateCustomBackendUrl(url);
    if (invalid) {
      res.status(400).json({ ok: false, error: invalid });
      return;
    }
    labState.customBackendUrl = url;
    res.json({ ok: true, backend: { customUrl: labState.customBackendUrl } });
  });

  router.delete('/lab/backend', (_req, res) => {
    labState.customBackendUrl = null;
    res.json({ ok: true, backend: { customUrl: null } });
  });

  router.get('/lab/presets', (_req, res) => {
    res.json({
      ok: true,
      presets: [
        {
          id: 'flash-sale',
          name: 'Flash sale',
          blurb: 'Bursty crowd, token bucket absorbs the spike',
          defaultRule: { algorithm: 'token-bucket', capacity: 60, refillRatePerSec: 8, keyPrefix: 'rl' },
          rps: 45,
        },
        {
          id: 'boundary-burst',
          name: 'Boundary burst',
          blurb: 'Fixed window lets 2x through at the edge',
          defaultRule: { algorithm: 'fixed-window', limit: 20, windowMs: 10_000, keyPrefix: 'rl' },
          rps: 30,
        },
        {
          id: 'expensive-api',
          name: 'Expensive API',
          blurb: 'Strict 5/min guard on /api/expensive',
          defaultRule: { algorithm: 'sliding-window', limit: 60, windowMs: 60_000, keyPrefix: 'rl' },
          rps: 20,
        },
        {
          id: 'redis-outage',
          name: 'Redis outage',
          blurb: 'Kill Redis mid-traffic, watch fallback hold',
          chaos: { redisDown: true },
          rps: 25,
        },
      ],
    });
  });

  // Server-Sent Events: single long-lived stream the dashboard subscribes to.
  // Emits full snapshot ~2/sec + on every decision burst (throttled in lab-state).
  router.get('/lab/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (payload: string): void => {
      try {
        res.write(payload);
      } catch {
        // client gone
      }
    };
    send(`event: snapshot\ndata: ${JSON.stringify(labState.snapshot())}\n\n`);

    const interval = setInterval(() => {
      send(`event: tick\ndata: ${JSON.stringify(labState.snapshot())}\n\n`);
    }, 1000);

    const unsubscribe = labState.subscribe(send);
    const cleanup = (): void => {
      clearInterval(interval);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  return router;
}
