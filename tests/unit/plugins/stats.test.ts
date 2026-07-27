import { describe, it, expect } from 'vitest';
import { percentileNearestRank } from '../../../src/plugins/metrics/index.js';

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
});
