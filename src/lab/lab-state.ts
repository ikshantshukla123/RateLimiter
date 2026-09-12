import type { RateLimitRule } from '../core/types';
import type { KeySource } from '../gateway/middleware/rate-limit-middleware';

export interface LabChaos {
  redisDown: boolean;
  addedLatencyMs: number;
}

export interface LabDecisionEvent {
  t: number;
  key: string;
  route: string;
  algorithm: string;
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterMs: number;
  resetMs: number;
  latencyMs: number;
  fallback: boolean;
  store: string;
}

interface SecondBucket {
  tSec: number;
  allowed: number;
  denied: number;
  fallback: number;
  latencySumMs: number;
  latencyCount: number;
  latencyMaxMs: number;
}

const MAX_EVENTS = 120;
const MAX_BUCKETS = 90;

class LabState {
  defaultRule: RateLimitRule = {
    algorithm: 'token-bucket',
    capacity: 20,
    refillRatePerSec: 2,
    keyPrefix: 'rl',
  };

  expensiveRule: RateLimitRule = {
    algorithm: 'fixed-window',
    limit: 5,
    windowMs: 60_000,
    keyPrefix: 'rl',
  };

  keyBy: KeySource = 'ip';

  /** User-supplied backend for the /tunnel proxy. Null = not configured yet. */
  customBackendUrl: string | null = null;

  chaos: LabChaos = { redisDown: false, addedLatencyMs: 0 };

  failureMode: 'fail-open' | 'fail-closed' = 'fail-closed';
  timeoutMs = 150;
  enableFallback = true;

  storeName = 'memory';
  useRedis = false;

  private events: LabDecisionEvent[] = [];
  private buckets = new Map<number, SecondBucket>();
  private totalAllowed = 0;
  private totalDenied = 0;
  private totalFallback = 0;
  private latenciesMs: number[] = [];
  private sseClients = new Set<(payload: string) => void>();

  getRules(): { defaultRule: RateLimitRule; expensiveRule: RateLimitRule; keyBy: KeySource } {
    return { defaultRule: this.defaultRule, expensiveRule: this.expensiveRule, keyBy: this.keyBy };
  }

  setRules(input: {
    defaultRule?: RateLimitRule;
    expensiveRule?: RateLimitRule;
    keyBy?: KeySource;
  }): void {
    if (input.defaultRule) this.defaultRule = input.defaultRule;
    if (input.expensiveRule) this.expensiveRule = input.expensiveRule;
    if (input.keyBy) this.keyBy = input.keyBy;
  }

  record(ev: LabDecisionEvent): void {
    this.events.unshift(ev);
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;

    if (ev.allowed) this.totalAllowed += 1;
    else this.totalDenied += 1;
    if (ev.fallback) this.totalFallback += 1;

    this.latenciesMs.push(ev.latencyMs);
    if (this.latenciesMs.length > 500) this.latenciesMs.splice(0, this.latenciesMs.length - 500);

    const sec = Math.floor(ev.t / 1000);
    let b = this.buckets.get(sec);
    if (!b) {
      b = { tSec: sec, allowed: 0, denied: 0, fallback: 0, latencySumMs: 0, latencyCount: 0, latencyMaxMs: 0 };
      this.buckets.set(sec, b);
    }
    if (ev.allowed) b.allowed += 1;
    else b.denied += 1;
    if (ev.fallback) b.fallback += 1;
    b.latencySumMs += ev.latencyMs;
    b.latencyCount += 1;
    b.latencyMaxMs = Math.max(b.latencyMaxMs, ev.latencyMs);

    if (this.buckets.size > MAX_BUCKETS) {
      const oldest = Math.min(...this.buckets.keys());
      this.buckets.delete(oldest);
    }

    this.broadcastTick();
  }

  recordFallbackOnly(): void {
    this.totalFallback += 1;
  }

  resetStats(): void {
    this.events = [];
    this.buckets.clear();
    this.totalAllowed = 0;
    this.totalDenied = 0;
    this.totalFallback = 0;
    this.latenciesMs = [];
  }

  subscribe(fn: (payload: string) => void): () => void {
    this.sseClients.add(fn);
    return () => {
      this.sseClients.delete(fn);
    };
  }

  private lastBroadcast = 0;
  private broadcastTick(): void {
    const now = Date.now();
    // Throttle fan-out: at most ~4 pushes/sec even under burst traffic.
    if (now - this.lastBroadcast < 250) return;
    this.lastBroadcast = now;
    const payload = `event: tick\ndata: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const fn of this.sseClients) {
      try {
        fn(payload);
      } catch {
        // ignore broken pipe; unsubscribe happens on close
      }
    }
  }

  snapshot(): Record<string, unknown> {
    const sortedSecs = [...this.buckets.keys()].sort((a, b) => a - b).slice(-60);
    const series = sortedSecs.map((s) => {
      const b = this.buckets.get(s)!;
      return {
        t: s * 1000,
        allowed: b.allowed,
        denied: b.denied,
        fallback: b.fallback,
        avgMs: b.latencyCount > 0 ? Math.round((b.latencySumMs / b.latencyCount) * 100) / 100 : 0,
        maxMs: Math.round(b.latencyMaxMs * 100) / 100,
      };
    });

    const last = series.slice(-5);
    const recentTotal = last.reduce((n, p) => n + p.allowed + p.denied, 0);
    const rps = last.length > 0 ? Math.round((recentTotal / (last.length || 1)) * 10) / 10 : 0;

    const sortedLat = [...this.latenciesMs].sort((a, b) => a - b);
    const pct = (p: number): number => {
      if (sortedLat.length === 0) return 0;
      const idx = Math.min(sortedLat.length - 1, Math.floor((p / 100) * sortedLat.length));
      return Math.round(sortedLat[idx] * 100) / 100;
    };

    const total = this.totalAllowed + this.totalDenied;
    return {
      now: Date.now(),
      rules: this.getRules(),
      backend: { customUrl: this.customBackendUrl },
      chaos: { ...this.chaos },
      resilience: {
        failureMode: this.failureMode,
        timeoutMs: this.timeoutMs,
        enableFallback: this.enableFallback,
        store: this.storeName,
        useRedis: this.useRedis,
        redisUp: !this.chaos.redisDown,
      },
      totals: {
        allowed: this.totalAllowed,
        denied: this.totalDenied,
        total,
        fallback: this.totalFallback,
        denyRate: total > 0 ? Math.round((this.totalDenied / total) * 1000) / 10 : 0,
        rps,
        p50Ms: pct(50),
        p95Ms: pct(95),
        p99Ms: pct(99),
      },
      series,
      recent: this.events.slice(0, 25),
    };
  }
}

export const labState = new LabState();

export function recordLabDecision(ev: LabDecisionEvent): void {
  labState.record(ev);
}
