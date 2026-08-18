import type { IMetricsAdapter, MetricName } from '../../adapters/IMetricsAdapter.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';
import {
  normalizeLabels,
  seriesKey,
  renderPromLabels,
  renderPromLabelsWith,
  promMetricName,
  sanitizeDuration,
  type NormalizedLabels,
} from './internal.js';

/**
 * Default histogram buckets (upper bounds, in milliseconds) for timing metrics.
 *
 * Chosen to span sub-millisecond to multi-second approval operations. The
 * implicit `+Inf` bucket is always appended and equals the total `_count`.
 */
export const DEFAULT_TIMING_BUCKETS_MS: readonly number[] = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

/**
 * Configuration for {@link PrometheusMetricsAdapter}.
 */
export interface PrometheusMetricsAdapterConfig {
  /**
   * Histogram bucket upper bounds (in milliseconds) applied to every timing
   * metric family. Will be de-duplicated and sorted ascending; `+Inf` is added
   * automatically. Defaults to {@link DEFAULT_TIMING_BUCKETS_MS}.
   */
  buckets?: readonly number[];
  /**
   * Logger used to warn about dropped/invalid samples. Defaults to
   * {@link noopLogger}.
   */
  logger?: Logger;
  /**
   * Optional override for the namespace prefix applied to every metric family
   * name (e.g. `myapp` produces `myapp_approval_submitted`). Empty by default.
   */
  namespace?: string;
}

interface CounterEntry {
  metric: MetricName;
  labels: NormalizedLabels;
  value: number;
}

interface HistogramEntry {
  metric: MetricName;
  labels: NormalizedLabels;
  /** Cumulative-ready per-bucket counts, aligned to `this.buckets`. */
  bucketCounts: number[];
  count: number;
  sum: number;
}

const COUNTER_HELP: Record<MetricName, string> = {
  'approval.submitted': 'Total approval instances submitted.',
  'approval.approved': 'Total approval steps approved.',
  'approval.rejected': 'Total approval instances rejected.',
  'approval.cancelled': 'Total approval instances cancelled.',
  'approval.expired': 'Total approval instances expired.',
  'approval.sla_breached': 'Total approval instances that breached their SLA.',
  'approval.escalated': 'Total approval levels escalated.',
  'approval.reassigned': 'Total approval levels reassigned.',
  'approval.overridden': 'Total approval instances overridden by an administrator.',
  'approval.conflict_retry': 'Total optimistic-concurrency conflict retries.',
  'approval.operation_duration_ms': 'Duration of approval engine operations in milliseconds.',
};

/**
 * A dependency-free {@link IMetricsAdapter} that accumulates counters and
 * timing histograms in memory and renders them via {@link scrape} in the
 * Prometheus text exposition format.
 *
 * The output is suitable for serving at a `/metrics` endpoint and is parseable
 * by a standard Prometheus parser:
 *
 * - one `# HELP` and one `# TYPE` line per metric family;
 * - counters are typed `counter`;
 * - timings are typed `histogram` with cumulative `_bucket{le="..."}` series
 *   (including `le="+Inf"`), plus `_sum` and `_count` series;
 * - the `+Inf` bucket always equals `_count`;
 * - label values are escaped per the exposition format rules;
 * - the output always ends with a trailing newline.
 *
 * **Threading model.** JavaScript is single-threaded; `increment`/`timing` run
 * to completion without interleaving, so concurrent async engine operations
 * accumulate without lost updates.
 *
 * **Memory.** Grows O(distinct series); keep label cardinality bounded.
 *
 * @example
 * ```ts
 * const metrics = new PrometheusMetricsAdapter();
 * metrics.increment('approval.submitted', { tenantId: 'acme' });
 * res.setHeader('Content-Type', 'text/plain; version=0.0.4');
 * res.end(metrics.scrape());
 * ```
 */
export class PrometheusMetricsAdapter implements IMetricsAdapter {
  private readonly logger: Logger;
  private readonly buckets: readonly number[];
  private readonly namespace: string;
  private readonly counters = new Map<string, CounterEntry>();
  private readonly histograms = new Map<string, HistogramEntry>();

  /**
   * @param config - Optional configuration (buckets, logger, namespace).
   */
  constructor(config: PrometheusMetricsAdapterConfig = {}) {
    this.logger = config.logger ?? noopLogger;
    this.namespace = config.namespace ? `${config.namespace}_` : '';
    const raw = config.buckets ?? DEFAULT_TIMING_BUCKETS_MS;
    const cleaned = Array.from(
      new Set(raw.filter((b) => Number.isFinite(b) && b >= 0)),
    ).sort((a, b) => a - b);
    this.buckets = cleaned.length > 0 ? cleaned : [...DEFAULT_TIMING_BUCKETS_MS];
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
      this.logger.warn('PrometheusMetricsAdapter: dropped invalid timing sample', {
        metric,
        durationMs,
      });
      return;
    }
    const norm = normalizeLabels(labels);
    const key = seriesKey(metric, norm);
    let entry = this.histograms.get(key);
    if (!entry) {
      entry = {
        metric,
        labels: norm,
        bucketCounts: new Array<number>(this.buckets.length).fill(0),
        count: 0,
        sum: 0,
      };
      this.histograms.set(key, entry);
    }
    entry.count += 1;
    entry.sum += value;
    // Increment the per-bucket (non-cumulative) tally; cumulative sums are
    // produced at scrape time.
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= (this.buckets[i] as number)) {
        entry.bucketCounts[i] = (entry.bucketCounts[i] as number) + 1;
        break;
      }
    }
    // Values exceeding the largest finite bucket fall only into +Inf, which is
    // derived from `count` at scrape time, so no explicit tally is needed.
  }

  /**
   * Render all accumulated metrics in the Prometheus text exposition format.
   *
   * Safe to call at any time, including before any metric has been recorded
   * (returns a valid, possibly empty document terminated by a newline).
   *
   * @returns The exposition text, always ending with `'\n'` (or `''` when no
   *   metric families exist).
   */
  scrape(): string {
    const lines: string[] = [];

    // Group series by metric family so each family emits exactly one HELP/TYPE.
    const counterFamilies = this.groupByMetric(this.counters.values());
    const histogramFamilies = this.groupByMetric(this.histograms.values());

    for (const [metric, entries] of counterFamilies) {
      const name = this.familyName(metric);
      lines.push(`# HELP ${name} ${this.escapeHelp(COUNTER_HELP[metric])}`);
      lines.push(`# TYPE ${name} counter`);
      for (const entry of entries) {
        lines.push(`${name}${renderPromLabels(entry.labels)} ${formatNumber(entry.value)}`);
      }
    }

    for (const [metric, entries] of histogramFamilies) {
      const name = this.familyName(metric);
      lines.push(`# HELP ${name} ${this.escapeHelp(COUNTER_HELP[metric])}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const entry of entries) {
        let cumulative = 0;
        for (let i = 0; i < this.buckets.length; i++) {
          cumulative += entry.bucketCounts[i] as number;
          const le = formatNumber(this.buckets[i] as number);
          lines.push(
            `${name}_bucket${renderPromLabelsWith(entry.labels, [['le', le]])} ${formatNumber(cumulative)}`,
          );
        }
        // The +Inf bucket is cumulative over everything and equals _count.
        lines.push(
          `${name}_bucket${renderPromLabelsWith(entry.labels, [['le', '+Inf']])} ${formatNumber(entry.count)}`,
        );
        lines.push(`${name}_sum${renderPromLabels(entry.labels)} ${formatNumber(entry.sum)}`);
        lines.push(`${name}_count${renderPromLabels(entry.labels)} ${formatNumber(entry.count)}`);
      }
    }

    if (lines.length === 0) return '';
    return `${lines.join('\n')}\n`;
  }

  /**
   * Reset all accumulated counters and histograms. Useful between test cases.
   */
  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }

  private familyName(metric: MetricName): string {
    return `${this.namespace}${promMetricName(metric)}`;
  }

  private escapeHelp(help: string): string {
    // In HELP lines, backslash and newline must be escaped.
    return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  }

  private groupByMetric<T extends { metric: MetricName }>(
    iter: IterableIterator<T>,
  ): Array<[MetricName, T[]]> {
    const groups = new Map<MetricName, T[]>();
    for (const entry of iter) {
      const list = groups.get(entry.metric);
      if (list) list.push(entry);
      else groups.set(entry.metric, [entry]);
    }
    return [...groups.entries()];
  }
}

/**
 * Format a number for the exposition format: integers print without a decimal
 * point, finite floats print via the shortest round-trippable representation.
 */
function formatNumber(n: number): string {
  return String(n);
}
