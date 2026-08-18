import type { IAuditAdapter } from '../../adapters/IAuditAdapter.js';
import type { AuditEntry, ApprovalInstance } from '../../types/index.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';

/** Default token substituted in place of redacted values. */
export const DEFAULT_REDACTION_MASK = '[REDACTED]';

/** Constructor options for {@link RedactingAuditAdapter}. */
export interface RedactingAuditAdapterOptions {
  /**
   * The wrapped adapter that receives the redacted entry.
   */
  inner: IAuditAdapter;

  /**
   * Dot-delimited field paths to redact, scoped to the bag they live in.
   *
   * Paths target the structured value bags (`oldValue`, `newValue`) of an
   * {@link AuditEntry}. Prefix a path with `oldValue.` or `newValue.` to scope it,
   * or supply an unscoped path (e.g. `applicant.ssn`) to apply it to BOTH bags.
   *
   * A trailing `.*` wildcard redacts every direct child of the matched object
   * (e.g. `card.*` masks every field under `card`). A path that does not resolve
   * to an existing value is a no-op.
   *
   * @example ['newValue.applicant.ssn', 'card.*', 'oldValue.bankAccount']
   */
  fieldPaths?: string[];

  /**
   * Free-text top-level entry fields to redact wholesale (value replaced by the mask).
   * Defaults to `[]`. Common choices: `['comment', 'reason']`.
   */
  freeTextFields?: Array<'comment' | 'reason'>;

  /** Token used to replace redacted values. Defaults to {@link DEFAULT_REDACTION_MASK}. */
  mask?: string;

  /** Structured logger; defaults to a no-op logger. */
  logger?: Logger;
}

/** Deep-clone a value, preserving `Date` instances and dropping functions/symbols. */
function deepClone<T>(value: T): T {
  return cloneValue(value) as T;
}

function cloneValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map((v) => cloneValue(v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = cloneValue(v);
  }
  return out;
}

/** A field path scoped to one or both structured bags. */
interface ParsedPath {
  bag: 'oldValue' | 'newValue' | 'both';
  /** Remaining segments after the optional bag prefix. */
  segments: string[];
  /** True when the final segment is the `*` wildcard. */
  wildcard: boolean;
}

function parsePath(raw: string): ParsedPath | null {
  const parts = raw.split('.').filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  let bag: ParsedPath['bag'] = 'both';
  let segments = parts;
  if (parts[0] === 'oldValue' || parts[0] === 'newValue') {
    bag = parts[0];
    segments = parts.slice(1);
  }

  let wildcard = false;
  if (segments[segments.length - 1] === '*') {
    wildcard = true;
    segments = segments.slice(0, -1);
  }

  // A bare `oldValue.*` / `newValue.*` (wildcard with no remaining segments) masks
  // every direct child of that whole bag.
  if (segments.length === 0 && !wildcard) return null;
  return { bag, segments, wildcard };
}

/**
 * Apply one parsed path to a single bag object, masking in place. The bag has
 * already been deep-cloned by the caller, so mutation here is safe.
 */
function redactInBag(bag: Record<string, unknown>, path: ParsedPath, mask: string): void {
  // Walk to the parent of the target. Any non-object along the way means the path
  // does not resolve — leave the structure untouched.
  let cursor: unknown = bag;
  for (let i = 0; i < path.segments.length - (path.wildcard ? 0 : 1); i++) {
    const seg = path.segments[i]!;
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return;
    cursor = (cursor as Record<string, unknown>)[seg];
  }

  if (path.wildcard) {
    // After walking all segments, `cursor` is the object whose children we mask.
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return;
    const target = cursor as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      target[key] = mask;
    }
    return;
  }

  // Non-wildcard: `cursor` is the parent; mask the final key if it exists.
  if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return;
  const parent = cursor as Record<string, unknown>;
  const finalKey = path.segments[path.segments.length - 1]!;
  if (Object.prototype.hasOwnProperty.call(parent, finalKey)) {
    parent[finalKey] = mask;
  }
}

/**
 * An {@link IAuditAdapter} decorator that strips configured PII from each entry
 * before forwarding to a wrapped adapter. The caller's original `entry` and
 * `instance` are never mutated — redaction operates on a deep clone.
 *
 * Redaction targets the structured bags (`oldValue`, `newValue`) by dot-path,
 * supports a trailing `.*` wildcard to mask every child of an object, and can
 * blank out free-text fields (`comment`, `reason`). Paths that do not resolve,
 * or that point at `null`/array/primitive values, are no-ops that leave the
 * entry structurally intact.
 *
 * @example
 * ```ts
 * const audit = new RedactingAuditAdapter({
 *   inner: new HashChainAuditAdapter(),
 *   fieldPaths: ['newValue.applicant.ssn', 'card.*'],
 *   freeTextFields: ['comment', 'reason'],
 * });
 * ```
 */
export class RedactingAuditAdapter implements IAuditAdapter {
  private readonly inner: IAuditAdapter;
  private readonly parsedPaths: ParsedPath[];
  private readonly freeTextFields: ReadonlyArray<'comment' | 'reason'>;
  private readonly mask: string;
  private readonly logger: Logger;

  constructor(options: RedactingAuditAdapterOptions) {
    this.inner = options.inner;
    this.mask = options.mask ?? DEFAULT_REDACTION_MASK;
    this.freeTextFields = options.freeTextFields ?? [];
    this.logger = options.logger ?? noopLogger;
    this.parsedPaths = (options.fieldPaths ?? [])
      .map(parsePath)
      .filter((p): p is ParsedPath => p !== null);
  }

  /**
   * Deep-clone the entry, redact configured fields on the clone, then forward to
   * the wrapped adapter. The caller's `entry` reference and contents are unchanged.
   * Never throws (delegates the must-not-throw guarantee to the wrapped adapter and
   * swallows any unexpected local error).
   */
  async append(
    tenantId: string,
    instanceId: string,
    entry: AuditEntry,
    instance: Readonly<ApprovalInstance>,
  ): Promise<void> {
    let redacted: AuditEntry;
    try {
      redacted = this.redactEntry(entry);
    } catch (err) {
      // Redaction must never break the audit path. On the unexpected event that
      // cloning/redaction fails, log and forward the original entry unmodified so
      // the audit record is not silently dropped.
      this.logger.error('RedactingAuditAdapter: redaction failed; forwarding original entry', err, {
        tenantId,
        instanceId,
      });
      redacted = entry;
    }
    await this.inner.append(tenantId, instanceId, redacted, instance);
  }

  /** Produce a redacted deep clone of `entry` without touching the original. */
  private redactEntry(entry: AuditEntry): AuditEntry {
    const clone = deepClone(entry);

    // Free-text fields: blank the value wholesale if present and non-empty/defined.
    for (const field of this.freeTextFields) {
      if (clone[field] !== undefined) {
        clone[field] = this.mask;
      }
    }

    // Structured bags.
    for (const path of this.parsedPaths) {
      if ((path.bag === 'oldValue' || path.bag === 'both') && clone.oldValue) {
        redactInBag(clone.oldValue, path, this.mask);
      }
      if ((path.bag === 'newValue' || path.bag === 'both') && clone.newValue) {
        redactInBag(clone.newValue, path, this.mask);
      }
    }

    return clone;
  }
}
