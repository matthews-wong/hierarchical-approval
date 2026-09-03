import type {
  ApprovalTemplate,
  ApprovalInstance,
  AuditEntry,
  ApprovalStatus,
} from '../types/index.js';

export interface PaginationOpts {
  limit: number;
  offset: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
}

/** Opaque cursor: base64(updatedAt_iso:id). Use the value from nextCursor/prevCursor. */
export interface CursorPaginationOpts {
  cursor?: string;
  limit: number;
  direction?: 'forward' | 'backward';
}

export interface CursorPaginatedResult<T> {
  items: T[];
  nextCursor?: string;
  prevCursor?: string;
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

export interface IStorageAdapter {
  // Templates
  saveTemplate(template: ApprovalTemplate): Promise<void>;
  getTemplate(tenantId: string, name: string): Promise<ApprovalTemplate | null>;
  listTemplates(tenantId: string): Promise<ApprovalTemplate[]>;

  // Instances
  saveInstance(instance: ApprovalInstance): Promise<void>;
  /** Conditional update — throws ApprovalConflictError if stored version !== expectedVersion. */
  updateInstance(instance: ApprovalInstance, expectedVersion: number): Promise<void>;
  getInstance(tenantId: string, id: string): Promise<ApprovalInstance | null>;
  getInstancesByApprover(
    tenantId: string,
    approverId: string,
    opts?: PaginationOpts,
  ): Promise<PaginatedResult<ApprovalInstance>>;
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
  getOverdueInstances(
    tenantId: string,
    asOf: Date,
    filter?: InstanceFilter,
  ): Promise<ApprovalInstance[]>;
  getIdempotentInstance(tenantId: string, idempotencyKey: string): Promise<ApprovalInstance | null>;

  // Audit (append-only)
  appendAuditEntry(tenantId: string, instanceId: string, entry: AuditEntry): Promise<void>;
}
