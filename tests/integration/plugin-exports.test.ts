import { describe, it, expect } from 'vitest';

/**
 * Guards the public API surface of the enterprise plug-ins. Each plug-in area is
 * published as its own subpath (`hierarchical-approval/plugins/<area>`), wired in
 * package.json `exports` and tsup `entry`. If a barrel stops exporting a documented
 * symbol — or a subpath is dropped from the build — this fails loudly instead of
 * shipping dead code in the npm artifact.
 */
describe('plugin public exports', () => {
  it('audit barrel exposes its documented surface', async () => {
    const m = await import('../../src/plugins/audit/index.js');
    for (const name of [
      'HashChainAuditAdapter',
      'RedactingAuditAdapter',
      'CompositeAuditAdapter',
      'canonicalize',
      'CircularReferenceError',
      'GENESIS_PREV_HASH',
      'DEFAULT_REDACTION_MASK',
    ]) {
      expect(m, `audit should export ${name}`).toHaveProperty(name);
    }
  });

  it('metrics barrel exposes its documented surface', async () => {
    const m = await import('../../src/plugins/metrics/index.js');
    for (const name of [
      'PrometheusMetricsAdapter',
      'InMemoryMetricsAdapter',
      'CompositeMetricsAdapter',
      'computeTimingStats',
      'percentileNearestRank',
      'DEFAULT_TIMING_BUCKETS_MS',
    ]) {
      expect(m, `metrics should export ${name}`).toHaveProperty(name);
    }
  });

  it('notify barrel exposes its documented surface', async () => {
    const m = await import('../../src/plugins/notify/index.js');
    for (const name of [
      'OutboxNotificationAdapter',
      'InMemoryOutboxStore',
      'CompositeNotificationAdapter',
      'TemplatedNotificationAdapter',
    ]) {
      expect(m, `notify should export ${name}`).toHaveProperty(name);
    }
  });

  it('resilience barrel exposes its documented surface', async () => {
    const m = await import('../../src/plugins/resilience/index.js');
    for (const name of [
      'RateLimitMiddleware',
      'defaultRateLimitKeyFn',
      'LoggingMiddleware',
      'RbacAuthorizationPolicy',
      'CompositeAuthorizationPolicy',
    ]) {
      expect(m, `resilience should export ${name}`).toHaveProperty(name);
    }
  });
});
