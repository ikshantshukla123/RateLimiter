/**
 * Prometheus instrumentation lands in Phase 6.
 * This stub keeps imports stable so gateway/core can reference metrics early.
 */
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
