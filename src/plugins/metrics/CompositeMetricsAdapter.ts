import type { IMetricsAdapter, MetricName } from '../../adapters/IMetricsAdapter.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';

/**
 * Configuration for {@link CompositeMetricsAdapter}.
 */
export interface CompositeMetricsAdapterConfig {
  /**
   * The child adapters to fan out to, invoked in array order. May be empty
   * (the composite then behaves as a no-op).
   */
  children: readonly IMetricsAdapter[];
  /**
   * Logger used to report a child that throws. Defaults to {@link noopLogger}.
   */
  logger?: Logger;
}

/**
 * An {@link IMetricsAdapter} that fans every `increment`/`timing` call out to a
 * fixed set of child adapters, synchronously and in order.
 *
 * **Error isolation.** If a child throws, the error is caught and logged via
 * the configured logger, and the remaining children still receive the call.
 * Both methods always return `void` and never throw on behalf of a child.
 *
 * **Zero children.** A composite with no children is a valid no-op.
 *
 * @example
 * ```ts
 * const prom = new PrometheusMetricsAdapter();
 * const mem = new InMemoryMetricsAdapter();
 * const metrics = new CompositeMetricsAdapter({ children: [prom, mem] });
 * // metrics is a drop-in for ApprovalEngineOptions.metricsAdapter
 * ```
 */
export class CompositeMetricsAdapter implements IMetricsAdapter {
  private readonly children: readonly IMetricsAdapter[];
  private readonly logger: Logger;

  /**
   * @param config - The child adapters and optional logger.
   */
  constructor(config: CompositeMetricsAdapterConfig) {
    this.children = [...config.children];
    this.logger = config.logger ?? noopLogger;
  }

  /** @inheritDoc */
  increment(metric: MetricName, labels?: Record<string, string>): void {
    for (let i = 0; i < this.children.length; i++) {
      const child = this.children[i] as IMetricsAdapter;
      try {
        child.increment(metric, labels);
      } catch (err) {
        this.logger.error('CompositeMetricsAdapter: child increment() threw', err, {
          childIndex: i,
          metric,
        });
      }
    }
  }

  /** @inheritDoc */
  timing(metric: MetricName, durationMs: number, labels?: Record<string, string>): void {
    for (let i = 0; i < this.children.length; i++) {
      const child = this.children[i] as IMetricsAdapter;
      try {
        child.timing(metric, durationMs, labels);
      } catch (err) {
        this.logger.error('CompositeMetricsAdapter: child timing() threw', err, {
          childIndex: i,
          metric,
        });
      }
    }
  }
}
