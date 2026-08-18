import type { MetricName } from '../../adapters/IMetricsAdapter.js';

/**
 * Shared, dependency-free helpers used by the metrics adapters.
 *
 * These functions are intentionally pure and synchronous so that every adapter
 * stays unit-testable with no real I/O.
 *
 * @internal
 */

/** A normalized, order-independent representation of a single label set. */
export type NormalizedLabels = ReadonlyArray<readonly [string, string]>;

/**
 * Normalize a label map into a deterministic, sorted list of `[key, value]`
 * pairs. Labels are sorted lexicographically by key so that the same logical
 * label set always produces the same series key regardless of the order the
 * caller supplied the keys in.
 *
 * `undefined`/`null` label values are dropped. All values are coerced to
 * strings (the adapters only ever receive `Record<string, string>`, but this
 * keeps the helper robust).
 *
 * @param labels - The raw labels passed to `increment`/`timing`.
 * @returns A sorted, frozen array of `[key, value]` tuples.
 * @internal
 */
export function normalizeLabels(labels?: Record<string, string>): NormalizedLabels {
  if (!labels) return [];
  const pairs: Array<[string, string]> = [];
  for (const key of Object.keys(labels)) {
    const value = labels[key];
    if (value === undefined || value === null) continue;
    pairs.push([key, String(value)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs;
}

// ASCII unit/record separators. These never appear in normal label data, so
// they make safe, collision-resistant delimiters for the internal series key.
const UNIT_SEP = '';
const RECORD_SEP = '';

/**
 * Build a stable, unique series key from a metric name and a normalized label
 * set. Distinct label sets produce distinct keys; identical label sets (in any
 * input order) produce identical keys.
 *
 * The key uses ASCII unit/record separators as delimiters and escapes any
 * literal separators/backslashes in the label content so that, e.g.,
 * `{a:"b" + sep + "c"}` and `{a:"b", c:""}` never collide.
 *
 * @param metric - The fixed `MetricName`.
 * @param labels - A normalized label set (see {@link normalizeLabels}).
 * @returns A deterministic string usable as a `Map`/object key.
 * @internal
 */
export function seriesKey(metric: MetricName, labels: NormalizedLabels): string {
  if (labels.length === 0) return metric;
  const parts = labels.map(([k, v]) => `${escapeKeyPart(k)}${UNIT_SEP}${escapeKeyPart(v)}`);
  return `${metric}${RECORD_SEP}${parts.join(RECORD_SEP)}`;
}

function escapeKeyPart(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .split(UNIT_SEP)
    .join('\\u001f')
    .split(RECORD_SEP)
    .join('\\u001e');
}

/**
 * Escape a label value per the Prometheus text exposition format rules:
 * backslash, double-quote and newline must be escaped. See
 * https://prometheus.io/docs/instrumenting/exposition_formats/.
 *
 * @param value - The raw label value.
 * @returns The escaped value, suitable for embedding inside `key="value"`.
 * @internal
 */
export function escapePromLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Render a normalized label set as a Prometheus label block, e.g.
 * `{tenantId="acme",operation="submit"}`. Returns an empty string when there
 * are no labels. Extra labels (such as a histogram `le` bucket) can be appended
 * by the caller via {@link renderPromLabelsWith}.
 *
 * @param labels - A normalized label set.
 * @returns The rendered `{...}` block, or `''` when empty.
 * @internal
 */
export function renderPromLabels(labels: NormalizedLabels): string {
  return renderPromLabelsWith(labels, []);
}

/**
 * Render a normalized label set plus additional pre-built label pairs (already
 * in render order) as a Prometheus label block. Used to append the histogram
 * `le` label without re-sorting it into the user labels.
 *
 * @param labels - A normalized label set (values escaped here).
 * @param extra - Additional `[key, value]` pairs appended verbatim after the
 *   user labels; values are escaped, keys are emitted as-is.
 * @returns The rendered `{...}` block, or `''` when both inputs are empty.
 * @internal
 */
export function renderPromLabelsWith(
  labels: NormalizedLabels,
  extra: ReadonlyArray<readonly [string, string]>,
): string {
  const all = [
    ...labels.map(([k, v]) => `${k}="${escapePromLabelValue(v)}"`),
    ...extra.map(([k, v]) => `${k}="${escapePromLabelValue(v)}"`),
  ];
  if (all.length === 0) return '';
  return `{${all.join(',')}}`;
}

/**
 * Convert a `MetricName` (which contains `.` characters) into a valid
 * Prometheus metric family name by replacing `.` with `_`. Prometheus metric
 * names must match `[a-zA-Z_:][a-zA-Z0-9_:]*`.
 *
 * @param metric - The fixed `MetricName`.
 * @returns A Prometheus-safe metric family name.
 * @internal
 */
export function promMetricName(metric: MetricName): string {
  return metric.replace(/\./g, '_');
}

/**
 * Sanitize a duration passed to `timing()`. The defined rule is:
 *
 * - `NaN`, `Infinity`/`-Infinity` and non-numbers are rejected (returns
 *   `null`, meaning the sample is dropped).
 * - Negative values are rejected (returns `null`).
 * - Otherwise the finite, non-negative value is accepted as-is (fractional
 *   values are preserved, including `0`).
 *
 * This guarantees that no `NaN` can ever leak into a snapshot or scrape.
 *
 * @param durationMs - The raw duration supplied by the caller.
 * @returns The accepted duration, or `null` if it must be dropped.
 * @internal
 */
export function sanitizeDuration(durationMs: number): number | null {
  if (typeof durationMs !== 'number') return null;
  if (!Number.isFinite(durationMs)) return null;
  if (durationMs < 0) return null;
  return durationMs;
}
