/**
 * Deterministic canonical JSON serialization for hashing.
 *
 * Guarantees a stable, reproducible string for the same logical value regardless
 * of key insertion order, so the same record always produces the same hash:
 *  - Object keys are emitted in lexicographic order (recursively).
 *  - `Date` values are serialized to their ISO-8601 string.
 *  - `undefined` properties (and `undefined` array elements) are encoded as `null`
 *    so that presence/position is preserved deterministically.
 *  - `bigint` is encoded as its decimal string; functions/symbols are encoded as `null`.
 *  - Circular references are detected and rejected (the caller decides how to react),
 *    rather than throwing the native, unstable `TypeError` deep inside JSON.stringify.
 *
 * This module performs no I/O and has no dependencies; it is pure and unit-testable.
 */

/** Thrown by {@link canonicalize} when a circular reference is encountered. */
export class CircularReferenceError extends Error {
  constructor(path: string) {
    super(`Circular reference detected during canonicalization at path "${path}".`);
    this.name = 'CircularReferenceError';
  }
}

/**
 * Produce a deterministic JSON string for `value`.
 *
 * @param value - Any JavaScript value. Plain objects, arrays, strings, numbers,
 *   booleans, `null`, `undefined`, `Date`, and `bigint` are supported.
 * @returns A stable string suitable for hashing.
 * @throws {CircularReferenceError} If the value graph contains a cycle.
 */
export function canonicalize(value: unknown): string {
  const seen = new Set<object>();

  const encode = (v: unknown, path: string): string => {
    if (v === null || v === undefined) return 'null';

    const t = typeof v;
    if (t === 'number') return Number.isFinite(v as number) ? String(v) : 'null';
    if (t === 'boolean') return (v as boolean) ? 'true' : 'false';
    if (t === 'bigint') return JSON.stringify((v as bigint).toString());
    if (t === 'string') return JSON.stringify(v);
    if (t === 'function' || t === 'symbol') return 'null';

    if (v instanceof Date) return JSON.stringify(v.toISOString());

    if (Array.isArray(v)) {
      if (seen.has(v)) throw new CircularReferenceError(path);
      seen.add(v);
      const parts = v.map((item, i) => encode(item, `${path}[${i}]`));
      seen.delete(v);
      return `[${parts.join(',')}]`;
    }

    if (t === 'object') {
      const obj = v as Record<string, unknown>;
      if (seen.has(obj)) throw new CircularReferenceError(path);
      seen.add(obj);
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const child = obj[key];
        // Mirror JSON.stringify: skip keys whose value is undefined inside objects.
        if (child === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${encode(child, `${path}.${key}`)}`);
      }
      seen.delete(obj);
      return `{${parts.join(',')}}`;
    }

    return 'null';
  };

  return encode(value, '$');
}
