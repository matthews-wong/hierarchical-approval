import { describe, it, expect } from 'vitest';
import { percentileNearestRank, computeTimingStats } from '../../../src/plugins/metrics/index.js';

describe('percentileNearestRank', () => {
  it('returns 0 for empty array', () => {
    expect(percentileNearestRank([], 50)).toBe(0);
  });

  it('correctly handles single item', () => {
    expect(percentileNearestRank([10], 50)).toBe(10);
    expect(percentileNearestRank([10], 95)).toBe(10);
  });

  it('calculates p50 for multiple items', () => {
    // sorted: [10, 20, 30]
    // p50: ceil(0.5 * 3) = ceil(1.5) = 2. Index 1 -> 20
    expect(percentileNearestRank([10, 20, 30], 50)).toBe(20);
  });

  it('calculates p100 for multiple items', () => {
    // sorted: [10, 20, 30]
    // p100: ceil(1.0 * 3) = 3. Index 2 -> 30
    expect(percentileNearestRank([10, 20, 30], 100)).toBe(30);
  });

  it('calculates p95 for multiple items', () => {
    // sorted: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    // p95: ceil(0.95 * 10) = 10 -> 100
    expect(percentileNearestRank([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBe(100);
  });

  it('clamps tiny percentiles up to the first sample', () => {
    // p1: ceil(0.01 * 3) = 1 -> index 0 -> 10 (never below the min)
    expect(percentileNearestRank([10, 20, 30], 1)).toBe(10);
  });

});

describe('computeTimingStats', () => {
  it('returns all-zero stats for an empty sample set (never NaN)', () => {
    expect(computeTimingStats([])).toEqual({
      count: 0, sum: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0,
    });
  });

  it('computes min/max/sum/avg and percentiles for a single sample', () => {
    expect(computeTimingStats([42])).toEqual({
      count: 1, sum: 42, min: 42, max: 42, avg: 42, p50: 42, p95: 42,
    });
  });

  it('computes the full summary for unsorted multi-sample input', () => {
    // sorted: [10, 20, 30, 40, 50]
    const stats = computeTimingStats([50, 10, 30, 40, 20]);
    expect(stats.count).toBe(5);
    expect(stats.sum).toBe(150);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(50);
    expect(stats.avg).toBe(30);
    expect(stats.p50).toBe(30); // ceil(0.5 * 5) = 3 -> index 2
    expect(stats.p95).toBe(50); // ceil(0.95 * 5) = 5 -> index 4
  });
});
