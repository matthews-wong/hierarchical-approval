/**
 * Statistical summary of a set of timing samples.
 *
 * For an empty sample set every field is `0` (never `NaN`).
 */
export interface TimingStats {
  /** Number of samples observed. */
  count: number;
  /** Sum of all samples. */
  sum: number;
  /** Smallest observed sample (`0` when empty). */
  min: number;
  /** Largest observed sample (`0` when empty). */
  max: number;
  /** Arithmetic mean, `sum / count` (`0` when empty). */
  avg: number;
  /** 50th percentile (median) via the nearest-rank method (`0` when empty). */
  p50: number;
  /** 95th percentile via the nearest-rank method (`0` when empty). */
  p95: number;
}

/**
 * Compute a percentile using the **nearest-rank** method on a pre-sorted
 * ascending array.
 *
 * The nearest-rank rank is `ceil(p/100 * N)`, clamped to `[1, N]`; the result
 * is the sample at that 1-based rank. This method:
 *
 * - returns an actual observed sample (no interpolation between samples);
 * - for a single sample yields that sample for every percentile (so
 *   `p50 === p95 === value`);
 * - is exact and deterministic for small fixed sample sets, which makes it
 *   straightforward to assert in unit tests.
 *
 * @param sortedAsc - Samples sorted ascending. Must be non-empty.
 * @param p - Percentile in the range `(0, 100]`.
 * @returns The sample value at the nearest rank.
 */
export function percentileNearestRank(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.ceil((p / 100) * n);
  const index = Math.min(Math.max(rank, 1), n) - 1;
  return sortedAsc[index] as number;
}

/**
 * Compute a full {@link TimingStats} summary from raw, unsorted samples.
 *
 * Percentiles use {@link percentileNearestRank}. An empty input yields all-zero
 * stats so callers never have to special-case `NaN`.
 *
 * @param samples - Raw timing samples (already sanitized: finite, `>= 0`).
 * @returns The computed statistics.
 */
export function computeTimingStats(samples: readonly number[]): TimingStats {
  const count = samples.length;
  if (count === 0) {
    return { count: 0, sum: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (const s of sorted) sum += s;
  const min = sorted[0] as number;
  const max = sorted[count - 1] as number;
  return {
    count,
    sum,
    min,
    max,
    avg: sum / count,
    p50: percentileNearestRank(sorted, 50),
    p95: percentileNearestRank(sorted, 95),
  };
}
