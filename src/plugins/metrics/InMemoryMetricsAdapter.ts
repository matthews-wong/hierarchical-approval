import type { IMetricsAdapter, MetricName } from '../../adapters/IMetricsAdapter.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';
import {
  normalizeLabels,
  seriesKey,
  renderPromLabels,
  sanitizeDuration,
  type NormalizedLabels,
} from './internal.js';
import { computeTimingStats, type TimingStats } from './stats.js';

/**
 * Structured snapshot produced by {@link InMemoryMetricsAdapter.snapshot}.
 *
 * Series keys are human-readable, e.g. `approval.submitted{tenantId="acme"}`,
 * and are stable across snapshots for the same `(metric, labelSet)`.
 */
export interface MetricsSnapshot {
  /** Counter totals keyed by series. */
  counters: Record<string, number>;
  /** Timing statistics keyed by series. */
  timings: Record<string, TimingStats>;
}

/**
 * Configuration for {@link InMemoryMetricsAdapter}.
 */
export interface InMemoryMetricsAdapterConfig {
  /**
   * Logger used to warn about dropped/invalid samples. Defaults to
   * {@link noopLogger}.
   */
  logger?: Logger;
  /**
   * Maximum number of raw timing samples retained **per series**. When the cap
   * is exceeded the oldest samples are discarded (FIFO) while `count`/`sum`/
   * `min`/`max` continue to reflect *all* observed samples. This bounds memory
   * under high-cardinality / high-volume timing without corrupting the
   * aggregate counts.
   *
   * Percentiles are then computed over the retained reservoir. Set to
   * `Infinity` to retain every sample (the default). A finite cap trades
   * percentile precision for bounded memory.
   *
   * @defaultValue `Infinity`
   */
  maxSamplesPerSeries?: number;
}

interface CounterEntry {
  metric: MetricName;
  labels: NormalizedLabels;
  value: number;
}

interface TimingEntry {
  metric: MetricName;
  labels: NormalizedLabels;
  /**
   * Retained raw samples held in a fixed-size ring buffer when the cap is
   * finite (`writeIndex`/`retained` track the live window); when the cap is
   * `Infinity` it simply grows without bound and `retained === samples.length`.
   */
  samples: number[];
  /** Next write position in the ring (only meaningful for a finite cap). */
  writeIndex: number;
  /** Number of retained samples currently in the ring (<= cap). */
  retained: number;
  /** Aggregate count over ALL observed samples (not just retained). */
  count: number;
  /** Aggregate sum over ALL observed samples. */
  sum: number;
  /** Min over ALL observed samples. */
  min: number;
  /** Max over ALL observed samples. */
  max: number;
}

/**
 * An in-memory {@link IMetricsAdapter} that keeps raw counter totals and timing
 * samples and exposes a structured {@link MetricsSnapshot}.
 *
 * Intended for tests, local development and lightweight dashboards. It is a
 * drop-in for `ApprovalEngineOptions.metricsAdapter`.
 *
 * **Threading model.** JavaScript is single-threaded; `increment`/`timing` run
 * to completion without interleaving, so concurrent async engine operations
 * accumulate without lost updates.
 *
 * **Memory.** Counters cost O(distinct series). Timing memory is bounded by
 * `maxSamplesPerSeries`. With many distinct `tenantId`s, series count grows
 * linearly with cardinality — keep label cardinality bounded in production.
 *
 * @example
 * ```ts
 * const metrics = new InMemoryMetricsAdapter();
 * metrics.increment('approval.submitted', { tenantId: 'acme' });
 * metrics.timing('approval.operation_duration_ms', 12, { operation: 'submit' });
 * const snap = metrics.snapshot();
 * ```
 */
export class InMemoryMetricsAdapter implements IMetricsAdapter {
  private readonly logger: Logger;
  private readonly maxSamplesPerSeries: number;
  private readonly counters = new Map<string, CounterEntry>();
  private readonly timings = new Map<string, TimingEntry>();

  /**
   * @param config - Optional configuration (logger, sample cap).
   */
  constructor(config: InMemoryMetricsAdapterConfig = {}) {
    this.logger = config.logger ?? noopLogger;
    const cap = config.maxSamplesPerSeries ?? Infinity;
    this.maxSamplesPerSeries = cap > 0 ? cap : Infinity;
  }

  /** @inheritDoc */
  increment(metric: MetricName, labels?: Record<string, string>): void {
    const norm = normalizeLabels(labels);
    const key = seriesKey(metric, norm);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += 1;
    } else {
      this.counters.set(key, { metric, labels: norm, value: 1 });
    }
  }

  /** @inheritDoc */
  timing(metric: MetricName, durationMs: number, labels?: Record<string, string>): void {
    const value = sanitizeDuration(durationMs);
    if (value === null) {
      this.logger.warn('InMemoryMetricsAdapter: dropped invalid timing sample', {
        metric,
        durationMs,
      });
      return;
    }
    const norm = normalizeLabels(labels);
    const key = seriesKey(metric, norm);
    const existing = this.timings.get(key);
    if (existing) {
      existing.count += 1;
      existing.sum += value;
      if (value < existing.min) existing.min = value;
      if (value > existing.max) existing.max = value;
      if (this.maxSamplesPerSeries === Infinity) {
        // Unbounded: keep every sample.
        existing.samples.push(value);
        existing.retained = existing.samples.length;
      } else if (existing.retained < this.maxSamplesPerSeries) {
        // Still filling the ring for the first time: O(1) append.
        existing.samples[existing.writeIndex] = value;
        existing.writeIndex = (existing.writeIndex + 1) % this.maxSamplesPerSeries;
        existing.retained += 1;
      } else {
        // Ring full: overwrite the oldest slot in O(1) (no Array.shift()).
        existing.samples[existing.writeIndex] = value;
        existing.writeIndex = (existing.writeIndex + 1) % this.maxSamplesPerSeries;
      }
    } else {
      this.timings.set(key, {
        metric,
        labels: norm,
        samples: [value],
        writeIndex: this.maxSamplesPerSeries === Infinity ? 1 : 1 % this.maxSamplesPerSeries,
        retained: 1,
        count: 1,
        sum: value,
        min: value,
        max: value,
      });
    }
  }

  /**
   * Produce a structured snapshot of all accumulated counters and timing
   * statistics. The snapshot is a deep copy — mutating it does not affect the
   * adapter's internal state.
   *
   * Timing `count`/`sum`/`min`/`max`/`avg` always reflect every observed
   * sample. Percentiles (`p50`/`p95`) are computed over the retained sample
   * reservoir (all samples unless `maxSamplesPerSeries` is finite).
   *
   * @returns The structured {@link MetricsSnapshot}.
   */
  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const entry of this.counters.values()) {
      counters[this.displayKey(entry.metric, entry.labels)] = entry.value;
    }

    const timings: Record<string, TimingStats> = {};
    for (const entry of this.timings.values()) {
      // Compute percentiles over only the retained window. When the ring has
      // wrapped, `samples` is exactly cap-length and fully retained; while still
      // filling, only the first `retained` slots are live. Order is irrelevant
      // because computeTimingStats sorts.
      const retainedSamples =
        entry.retained === entry.samples.length
          ? entry.samples
          : entry.samples.slice(0, entry.retained);
      const reservoirStats = computeTimingStats(retainedSamples);
      // Override aggregate fields with the exact lifetime aggregates so that a
      // finite sample cap never distorts count/sum/min/max/avg.
      timings[this.displayKey(entry.metric, entry.labels)] = {
        count: entry.count,
        sum: entry.sum,
        min: entry.min,
        max: entry.max,
        avg: entry.count === 0 ? 0 : entry.sum / entry.count,
        p50: reservoirStats.p50,
        p95: reservoirStats.p95,
      };
    }

    return { counters, timings };
  }

  /**
   * Reset all accumulated counters and timing samples. Useful between test
   * cases.
   */
  reset(): void {
    this.counters.clear();
    this.timings.clear();
  }

  private displayKey(metric: MetricName, labels: NormalizedLabels): string {
    const block = renderPromLabels(labels);
    return `${metric}${block}`;
  }
}
