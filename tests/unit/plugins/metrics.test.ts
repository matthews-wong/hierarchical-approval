import { describe, it, expect, vi } from 'vitest';
import {
  PrometheusMetricsAdapter,
  DEFAULT_TIMING_BUCKETS_MS,
  InMemoryMetricsAdapter,
  CompositeMetricsAdapter,
  computeTimingStats,
  percentileNearestRank,
} from '../../../src/plugins/metrics/index.js';
import {
  normalizeLabels,
  seriesKey,
  escapePromLabelValue,
  promMetricName,
  sanitizeDuration,
} from '../../../src/plugins/metrics/internal.js';
import type { IMetricsAdapter } from '../../../src/adapters/IMetricsAdapter.js';
import { spyLogger } from './_helpers.js';

describe('internal helpers', () => {
  it('normalizeLabels sorts by key and drops null/undefined', () => {
    const norm = normalizeLabels({ b: '2', a: '1', c: undefined as unknown as string });
    expect(norm).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('normalizeLabels returns [] for undefined input', () => {
    expect(normalizeLabels(undefined)).toEqual([]);
  });

  it('seriesKey is order-independent for identical label sets', () => {
    const k1 = seriesKey('approval.submitted', normalizeLabels({ a: '1', b: '2' }));
    const k2 = seriesKey('approval.submitted', normalizeLabels({ b: '2', a: '1' }));
    expect(k1).toBe(k2);
  });

  it('seriesKey does not collide for distinct label sets', () => {
    const k1 = seriesKey('approval.submitted', normalizeLabels({ a: 'bc' }));
    const k2 = seriesKey('approval.submitted', normalizeLabels({ a: 'b', c: '' }));
    expect(k1).not.toBe(k2);
  });

  it('escapePromLabelValue escapes backslash, quote, newline', () => {
    expect(escapePromLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
  });

  it('promMetricName converts dots to underscores', () => {
    expect(promMetricName('approval.operation_duration_ms')).toBe('approval_operation_duration_ms');
  });

  it('sanitizeDuration rejects NaN/Infinity/negative, preserves 0 and fractional', () => {
    expect(sanitizeDuration(NaN)).toBeNull();
    expect(sanitizeDuration(Infinity)).toBeNull();
    expect(sanitizeDuration(-Infinity)).toBeNull();
    expect(sanitizeDuration(-1)).toBeNull();
    expect(sanitizeDuration(0)).toBe(0);
    expect(sanitizeDuration(2.5)).toBe(2.5);
  });
});

describe('stats', () => {
  it('computeTimingStats on empty input is all-zero (never NaN)', () => {
    const s = computeTimingStats([]);
    expect(s).toEqual({ count: 0, sum: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0 });
  });

  it('computeTimingStats computes avg/min/max correctly', () => {
    const s = computeTimingStats([10, 20, 30, 40]);
    expect(s.count).toBe(4);
    expect(s.sum).toBe(100);
    expect(s.min).toBe(10);
    expect(s.max).toBe(40);
    expect(s.avg).toBe(25);
  });

  it('single sample: p50 == p95 == value', () => {
    const s = computeTimingStats([7]);
    expect(s.p50).toBe(7);
    expect(s.p95).toBe(7);
  });

  it('percentileNearestRank is exact for a fixed set', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // rank = ceil(0.5*10)=5 -> index 4 -> 5
    expect(percentileNearestRank(sorted, 50)).toBe(5);
    // rank = ceil(0.95*10)=10 -> index 9 -> 10
    expect(percentileNearestRank(sorted, 95)).toBe(10);
  });

  it('percentileNearestRank clamps rank to [1,N]', () => {
    expect(percentileNearestRank([42], 95)).toBe(42);
    expect(percentileNearestRank([], 50)).toBe(0);
  });
});

describe('InMemoryMetricsAdapter', () => {
  it('counters accumulate across calls', () => {
    const m = new InMemoryMetricsAdapter();
    m.increment('approval.submitted', { tenantId: 'acme' });
    m.increment('approval.submitted', { tenantId: 'acme' });
    m.increment('approval.submitted', { tenantId: 'acme' });
    const snap = m.snapshot();
    expect(snap.counters['approval.submitted{tenantId="acme"}']).toBe(3);
  });

  it('distinct label sets produce distinct counter series', () => {
    const m = new InMemoryMetricsAdapter();
    m.increment('approval.submitted', { tenantId: 'a' });
    m.increment('approval.submitted', { tenantId: 'b' });
    const snap = m.snapshot();
    expect(snap.counters['approval.submitted{tenantId="a"}']).toBe(1);
    expect(snap.counters['approval.submitted{tenantId="b"}']).toBe(1);
  });

  it('label-order independence maps to the same series', () => {
    const m = new InMemoryMetricsAdapter();
    m.increment('approval.approved', { tenantId: 'x', operation: 'approve' });
    m.increment('approval.approved', { operation: 'approve', tenantId: 'x' });
    const snap = m.snapshot();
    const keys = Object.keys(snap.counters);
    expect(keys).toHaveLength(1);
    expect(snap.counters[keys[0]!]).toBe(2);
  });

  it('timing snapshot has statistically correct values', () => {
    const m = new InMemoryMetricsAdapter();
    for (const v of [10, 20, 30, 40, 50]) m.timing('approval.operation_duration_ms', v, { operation: 'submit' });
    const snap = m.snapshot();
    const stats = snap.timings['approval.operation_duration_ms{operation="submit"}']!;
    expect(stats.count).toBe(5);
    expect(stats.sum).toBe(150);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(50);
    expect(stats.avg).toBe(30);
    expect(stats.p50).toBe(30); // ceil(0.5*5)=3 -> idx2 -> 30
    expect(stats.p95).toBe(50); // ceil(0.95*5)=5 -> idx4 -> 50
  });

  it('0ms, fractional, and single-sample timings produce no NaN', () => {
    const m = new InMemoryMetricsAdapter();
    m.timing('approval.operation_duration_ms', 0, { operation: 'a' });
    const snap = m.snapshot();
    const s = snap.timings['approval.operation_duration_ms{operation="a"}']!;
    expect(s.count).toBe(1);
    expect(s.min).toBe(0);
    expect(s.avg).toBe(0);
    expect(Number.isNaN(s.p50)).toBe(false);
    expect(s.p50).toBe(0);
    expect(s.p95).toBe(0);
  });

  it('drops NaN/negative timing samples and never produces NaN', () => {
    const logger = spyLogger();
    const m = new InMemoryMetricsAdapter({ logger });
    m.timing('approval.operation_duration_ms', NaN, { operation: 'x' });
    m.timing('approval.operation_duration_ms', -5, { operation: 'x' });
    expect(m.snapshot().timings['approval.operation_duration_ms{operation="x"}']).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('aggregates reflect ALL samples even with a finite reservoir cap', () => {
    const m = new InMemoryMetricsAdapter({ maxSamplesPerSeries: 2 });
    for (const v of [10, 20, 30, 40]) m.timing('approval.operation_duration_ms', v, { operation: 'op' });
    const s = m.snapshot().timings['approval.operation_duration_ms{operation="op"}']!;
    expect(s.count).toBe(4);
    expect(s.sum).toBe(100);
    expect(s.min).toBe(10);
    expect(s.max).toBe(40);
    expect(s.avg).toBe(25);
  });

  it('reset clears everything', () => {
    const m = new InMemoryMetricsAdapter();
    m.increment('approval.submitted');
    m.reset();
    expect(m.snapshot().counters).toEqual({});
  });

  it('high cardinality keeps counts uncorrupted', () => {
    const m = new InMemoryMetricsAdapter();
    for (let i = 0; i < 500; i++) m.increment('approval.submitted', { tenantId: `t${i}` });
    const snap = m.snapshot();
    expect(Object.keys(snap.counters)).toHaveLength(500);
    expect(snap.counters['approval.submitted{tenantId="t499"}']).toBe(1);
  });

  it('increment and timing return void (synchronous)', () => {
    const m = new InMemoryMetricsAdapter();
    expect(m.increment('approval.submitted')).toBeUndefined();
    expect(m.timing('approval.operation_duration_ms', 1)).toBeUndefined();
  });
});

describe('PrometheusMetricsAdapter', () => {
  it('empty scrape returns empty string without throwing', () => {
    const m = new PrometheusMetricsAdapter();
    expect(m.scrape()).toBe('');
  });

  it('renders one HELP/TYPE per family, counter type, trailing newline', () => {
    const m = new PrometheusMetricsAdapter();
    m.increment('approval.submitted', { tenantId: 'acme' });
    m.increment('approval.submitted', { tenantId: 'acme' });
    const out = m.scrape();
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('# HELP approval_submitted Total approval instances submitted.');
    expect(out).toContain('# TYPE approval_submitted counter');
    expect(out).toContain('approval_submitted{tenantId="acme"} 2');
    // exactly one HELP/one TYPE line for the family
    expect(out.match(/# HELP approval_submitted /g)).toHaveLength(1);
    expect(out.match(/# TYPE approval_submitted /g)).toHaveLength(1);
  });

  it('renders histograms with cumulative buckets, +Inf == _count, plus _sum/_count', () => {
    const m = new PrometheusMetricsAdapter({ buckets: [10, 100] });
    m.timing('approval.operation_duration_ms', 5, { operation: 'submit' }); // <=10
    m.timing('approval.operation_duration_ms', 50, { operation: 'submit' }); // <=100
    m.timing('approval.operation_duration_ms', 500, { operation: 'submit' }); // +Inf only
    const out = m.scrape();
    expect(out).toContain('# TYPE approval_operation_duration_ms histogram');
    expect(out).toContain('approval_operation_duration_ms_bucket{operation="submit",le="10"} 1');
    expect(out).toContain('approval_operation_duration_ms_bucket{operation="submit",le="100"} 2');
    expect(out).toContain('approval_operation_duration_ms_bucket{operation="submit",le="+Inf"} 3');
    expect(out).toContain('approval_operation_duration_ms_sum{operation="submit"} 555');
    expect(out).toContain('approval_operation_duration_ms_count{operation="submit"} 3');
  });

  it('+Inf bucket always equals _count', () => {
    const m = new PrometheusMetricsAdapter({ buckets: [1] });
    for (let i = 0; i < 7; i++) m.timing('approval.operation_duration_ms', 1000, { operation: 'x' });
    const out = m.scrape();
    expect(out).toContain('le="+Inf"} 7');
    expect(out).toContain('_count{operation="x"} 7');
  });

  it('escapes label values per exposition rules', () => {
    const m = new PrometheusMetricsAdapter();
    m.increment('approval.submitted', { tenantId: 'a"b\\c\nd' });
    const out = m.scrape();
    expect(out).toContain('approval_submitted{tenantId="a\\"b\\\\c\\nd"} 1');
  });

  it('de-duplicates and sorts configured buckets', () => {
    const m = new PrometheusMetricsAdapter({ buckets: [100, 10, 10, 50] });
    m.timing('approval.operation_duration_ms', 1000, { operation: 'x' });
    const out = m.scrape();
    const order = [...out.matchAll(/le="(\d+)"/g)].map((mm) => Number(mm[1]));
    expect(order).toEqual([10, 50, 100]);
  });

  it('applies a namespace prefix', () => {
    const m = new PrometheusMetricsAdapter({ namespace: 'myapp' });
    m.increment('approval.submitted');
    expect(m.scrape()).toContain('myapp_approval_submitted 1');
  });

  it('default buckets are 12 entries spanning sub-ms to multi-second', () => {
    expect(DEFAULT_TIMING_BUCKETS_MS).toHaveLength(12);
    expect(DEFAULT_TIMING_BUCKETS_MS[0]).toBe(1);
  });

  it('drops invalid timing samples (no NaN in scrape)', () => {
    const logger = spyLogger();
    const m = new PrometheusMetricsAdapter({ logger });
    m.timing('approval.operation_duration_ms', NaN, { operation: 'x' });
    expect(m.scrape()).toBe('');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('reset clears all metrics', () => {
    const m = new PrometheusMetricsAdapter();
    m.increment('approval.submitted');
    m.reset();
    expect(m.scrape()).toBe('');
  });

  it('output is line-structured and parseable (every non-comment line has a value)', () => {
    const m = new PrometheusMetricsAdapter({ buckets: [10] });
    m.increment('approval.submitted', { tenantId: 'a' });
    m.timing('approval.operation_duration_ms', 5, { operation: 'b' });
    const lines = m.scrape().split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      // metric{labels} value  OR  metric value
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})? -?\d+(\.\d+)?$/);
    }
  });
});

describe('CompositeMetricsAdapter', () => {
  it('fans increment/timing to all children in order', () => {
    const calls: string[] = [];
    const mk = (name: string): IMetricsAdapter => ({
      increment: () => calls.push(`${name}:inc`),
      timing: () => calls.push(`${name}:tim`),
    });
    const c = new CompositeMetricsAdapter({ children: [mk('a'), mk('b')] });
    c.increment('approval.submitted');
    c.timing('approval.operation_duration_ms', 1);
    expect(calls).toEqual(['a:inc', 'b:inc', 'a:tim', 'b:tim']);
  });

  it('zero children is a no-op', () => {
    const c = new CompositeMetricsAdapter({ children: [] });
    expect(c.increment('approval.submitted')).toBeUndefined();
    expect(c.timing('approval.operation_duration_ms', 1)).toBeUndefined();
  });

  it('a throwing child is caught/logged and remaining children still receive the call', () => {
    const logger = spyLogger();
    const good = { increment: vi.fn(), timing: vi.fn() };
    const bad: IMetricsAdapter = {
      increment: () => {
        throw new Error('boom');
      },
      timing: () => {
        throw new Error('boom');
      },
    };
    const c = new CompositeMetricsAdapter({ children: [bad, good], logger });
    c.increment('approval.submitted');
    c.timing('approval.operation_duration_ms', 5);
    expect(good.increment).toHaveBeenCalledOnce();
    expect(good.timing).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('forwards the actual metric/labels to children, and to Prometheus + InMemory together', () => {
    const prom = new PrometheusMetricsAdapter();
    const mem = new InMemoryMetricsAdapter();
    const c = new CompositeMetricsAdapter({ children: [prom, mem] });
    c.increment('approval.submitted', { tenantId: 'acme' });
    expect(prom.scrape()).toContain('approval_submitted{tenantId="acme"} 1');
    expect(mem.snapshot().counters['approval.submitted{tenantId="acme"}']).toBe(1);
  });
});
