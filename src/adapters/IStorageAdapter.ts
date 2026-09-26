import type {
  ApprovalTemplate,
  ApprovalInstance,
  AuditEntry,
  ApprovalStatus,
} from '../types/index.js';

/** Offset-based pagination request. */
export interface PaginationOpts {
  /** Maximum number of items to return. */
  limit: number;
  /** Number of matching items to skip before the page starts. */
  offset: number;
}

/** Offset-based pagination response, including the total matching count. */
export interface PaginatedResult<T> {
  /** The requested page's items. */
  items: T[];
  /** Total number of items matching the query, across all pages. */
  total: number;
}

/** Opaque cursor: base64(updatedAt_iso:id). Use the value from nextCursor/prevCursor. */
export interface CursorPaginationOpts {
  /** Cursor from a previous page's `nextCursor`/`prevCursor`; omit to start from the first page. */
  cursor?: string;
  /** Maximum number of items to return. */
  limit: number;
  /** Which way to page from `cursor`. Defaults to `'forward'`. */
  direction?: 'forward' | 'backward';
}

/** Cursor-based pagination response. */
export interface CursorPaginatedResult<T> {
  /** The requested page's items. */
  items: T[];
  /** Pass as `cursor` with `direction: 'forward'` to fetch the next page, if any. */
  nextCursor?: string;
  /** Pass as `cursor` with `direction: 'backward'` to fetch the previous page, if any. */
  prevCursor?: string;
  /** Whether another page exists in the requested direction. */
  hasMore: boolean;
}

export interface InstanceFilter {
  status?: ApprovalStatus;
  documentType?: string;
  submittedBy?: string;
  templateName?: string;
  fromDate?: Date;
  toDate?: Date;
  /**
   * Match instances whose document `data` contains these field/value pairs —
   * "every purchase order for vendor ACME", without the caller fetching a page
   * at a time and filtering in application code.
   *
   * Keys are dot-paths (`vendor.id`), values compare by deep equality, and all
   * pairs must match. Matching is on **own** properties only, mirroring how
   * conditions resolve field paths.
   */
  data?: Record<string, unknown>;
}

/** The primary persistence contract `ApprovalEngine` reads and writes through — implement this to bring your own store. */
export interface IStorageAdapter {
  // Templates
  saveTemplate(template: ApprovalTemplate): Promise<void>;
  getTemplate(tenantId: string, name: string): Promise<ApprovalTemplate | null>;
  listTemplates(tenantId: string): Promise<ApprovalTemplate[]>;

  // Instances
  /** Create a new instance. Callers own uniqueness of `instance.id`. */
  saveInstance(instance: ApprovalInstance): Promise<void>;
  /** Conditional update — throws ApprovalConflictError if stored version !== expectedVersion. */
  updateInstance(instance: ApprovalInstance, expectedVersion: number): Promise<void>;
  /** Fetch one instance by id, scoped to a tenant. Returns null if absent. */
  getInstance(tenantId: string, id: string): Promise<ApprovalInstance | null>;
  /** Instances where `approverId` is a current approver on any pending level. */
  getInstancesByApprover(
    tenantId: string,
    approverId: string,
    opts?: PaginationOpts,
  ): Promise<PaginatedResult<ApprovalInstance>>;
  /** Instances matching an {@link InstanceFilter}. Ordering is adapter-specific. */
  getInstancesByFilter(
    tenantId: string,
    filter: InstanceFilter,
    opts?: PaginationOpts,
  ): Promise<PaginatedResult<ApprovalInstance>>;
  /** Optional cursor-based pagination — more efficient than offset at scale. */
  getInstancesByCursor?(
    tenantId: string,
    filter: InstanceFilter,
    opts: CursorPaginationOpts,
  ): Promise<CursorPaginatedResult<ApprovalInstance>>;
  /** Pending instances overdue as of `asOf` on any open level, not just the current one. */
  getOverdueInstances(
    tenantId: string,
    asOf: Date,
    filter?: InstanceFilter,
  ): Promise<ApprovalInstance[]>;
  /**
   * Count instances matching a filter, without fetching any of them.
   *
   * Reporting needs counts far more often than rows: `getStatistics()` alone
   * issues `4N + 5` of them for a tenant with N templates. Answering those
   * through `getInstancesByFilter` made the database compute the count *and*
   * serialise a full instance row — JSONB levels, document data and all — for
   * every one, only to discard it.
   *
   * A custom adapter with nothing better available can satisfy this in one line:
   *
   * ```ts
   * countInstances = (tenantId, filter) =>
   *   this.getInstancesByFilter(tenantId, filter, { limit: 1, offset: 0 })
   *       .then((r) => r.total);
   * ```
   *
   * @since 2.0.0 — required. See the release notes for the migration.
   */
  countInstances(tenantId: string, filter: InstanceFilter): Promise<number>;
  /**
   * Permanently remove one instance and its audit rows.
   *
   * **Optional.** An adapter that omits it simply cannot be purged, and
   * {@link ApprovalEngine.purgeInstances} says so rather than pretending to
   * have deleted anything. Left optional deliberately: for many deployments the
   * approval trail is the compliance record and the right answer is that
   * nothing is ever deleted, which an adapter expresses by not implementing
   * this at all.
   *
   * @returns true if a row was removed, false if there was nothing to remove.
   * @since 2.3.0
   */
  deleteInstance?(tenantId: string, id: string): Promise<boolean>;
  /** Look up an instance by `idempotencyKey`, unique within a tenant, not globally. */
  getIdempotentInstance(tenantId: string, idempotencyKey: string): Promise<ApprovalInstance | null>;

  // Audit (append-only)
  appendAuditEntry(tenantId: string, instanceId: string, entry: AuditEntry): Promise<void>;
}
