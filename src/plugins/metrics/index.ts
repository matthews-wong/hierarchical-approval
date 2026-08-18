/**
 * Observability / metrics plug-ins for the hierarchical-approval engine.
 *
 * All adapters implement {@link IMetricsAdapter} from
 * `../../adapters/IMetricsAdapter.js`, carry zero runtime dependencies, and are
 * drop-in for `ApprovalEngineOptions.metricsAdapter`.
 *
 * - {@link PrometheusMetricsAdapter} — accumulates counters + timing histograms
 *   and renders Prometheus text exposition format via `scrape()`.
 * - {@link InMemoryMetricsAdapter} — keeps raw counts + timing samples and
 *   exposes a structured `snapshot()` for tests and dashboards.
 * - {@link CompositeMetricsAdapter} — fans calls out to N child adapters.
 *
 * @packageDocumentation
 */

export {
  PrometheusMetricsAdapter,
  DEFAULT_TIMING_BUCKETS_MS,
} from './PrometheusMetricsAdapter.js';
export type { PrometheusMetricsAdapterConfig } from './PrometheusMetricsAdapter.js';

export { InMemoryMetricsAdapter } from './InMemoryMetricsAdapter.js';
export type {
  InMemoryMetricsAdapterConfig,
  MetricsSnapshot,
} from './InMemoryMetricsAdapter.js';

export { CompositeMetricsAdapter } from './CompositeMetricsAdapter.js';
export type { CompositeMetricsAdapterConfig } from './CompositeMetricsAdapter.js';

export type { TimingStats } from './stats.js';
export { computeTimingStats, percentileNearestRank } from './stats.js';
