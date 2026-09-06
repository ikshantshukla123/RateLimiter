import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface MetricsRecorder {
  observeDecision(algorithm: string, route: string, allowed: boolean): void;
  observeLatency(algorithm: string, seconds: number): void;
  observeStoreOperation(store: string, operation: string, ok: boolean): void;
  observeFallback(from: string, to: string): void;
}

export const noopMetrics: MetricsRecorder = {
  observeDecision: () => undefined,
  observeLatency: () => undefined,
  observeStoreOperation: () => undefined,
  observeFallback: () => undefined,
};

/**
 * Prometheus recorder. Route labels are normalized by the middleware caller
 * (bounded route templates only — never raw user IDs) to avoid cardinality blowup.
 */
export class PrometheusMetrics implements MetricsRecorder {
  readonly registry: Registry;

  private readonly decisions: Counter<string>;
  private readonly latency: Histogram<string>;
  private readonly storeOps: Counter<string>;
  private readonly storeErrors: Counter<string>;
  private readonly fallbacks: Counter<string>;

  constructor(registry?: Registry) {
    this.registry = registry ?? new Registry();
    if (!registry) collectDefaultMetrics({ register: this.registry });

    this.decisions = new Counter({
      name: 'rate_limiter_decisions_total',
      help: 'Allowed/denied rate-limit decisions',
      labelNames: ['algorithm', 'route', 'decision'],
      registers: [this.registry],
    });
    this.latency = new Histogram({
      name: 'rate_limiter_latency_seconds',
      help: 'Rate-limiter decision latency in seconds',
      labelNames: ['algorithm'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [this.registry],
    });
    this.storeOps = new Counter({
      name: 'rate_limiter_store_operations_total',
      help: 'Store operations by backend and operation',
      labelNames: ['store', 'operation', 'status'],
      registers: [this.registry],
    });
    this.storeErrors = new Counter({
      name: 'rate_limiter_store_errors_total',
      help: 'Store errors by backend and operation',
      labelNames: ['store', 'operation'],
      registers: [this.registry],
    });
    this.fallbacks = new Counter({
      name: 'rate_limiter_fallback_total',
      help: 'Degraded fallback engagements (primary -> fallback)',
      labelNames: ['from', 'to'],
      registers: [this.registry],
    });
  }

  observeDecision(algorithm: string, route: string, allowed: boolean): void {
    this.decisions.inc({ algorithm, route, decision: allowed ? 'allow' : 'deny' });
  }

  observeLatency(algorithm: string, seconds: number): void {
    this.latency.observe({ algorithm }, seconds);
  }

  observeStoreOperation(store: string, operation: string, ok: boolean): void {
    this.storeOps.inc({ store, operation, status: ok ? 'ok' : 'error' });
    if (!ok) this.storeErrors.inc({ store, operation });
  }

  observeFallback(from: string, to: string): void {
    this.fallbacks.inc({ from, to });
  }

  async exposition(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
