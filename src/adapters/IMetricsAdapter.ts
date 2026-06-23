export type MetricName =
  | 'approval.submitted'
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.cancelled'
  | 'approval.expired'
  | 'approval.sla_breached'
  | 'approval.escalated'
  | 'approval.reassigned'
  | 'approval.overridden'
  | 'approval.conflict_retry'
  | 'approval.operation_duration_ms';

export interface IMetricsAdapter {
  /** Increment a counter. Synchronous — never awaited. */
  increment(metric: MetricName, labels?: Record<string, string>): void;
  /** Record a timing measurement in milliseconds. Synchronous — never awaited. */
  timing(metric: MetricName, durationMs: number, labels?: Record<string, string>): void;
}
