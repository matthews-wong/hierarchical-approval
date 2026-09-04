import type {
  IStorageAdapter,
  PaginationOpts,
  PaginatedResult,
  InstanceFilter,
  CursorPaginationOpts,
  CursorPaginatedResult,
} from './IStorageAdapter.js';
import type { ApprovalTemplate, ApprovalInstance, AuditEntry } from '../types/index.js';
import { ApprovalConflictError } from '../errors.js';

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Restore every `Date` the JSON clone flattened to a string.
 *
 * Every date-bearing field must be listed here. Missing one leaves a value the
 * type says is a `Date` holding a string, which `PostgresAdapter` revives
 * correctly — so the two adapters disagree and the bug only shows up under one
 * of them. That is how `attachments[].addedAt` and `infoRequest.askedAt` came
 * to read back as strings.
 */
function reviveDates(instance: ApprovalInstance): ApprovalInstance {
  return {
    ...instance,
    createdAt: new Date(instance.createdAt),
    updatedAt: new Date(instance.updatedAt),
    expiresAt: instance.expiresAt ? new Date(instance.expiresAt) : undefined,
    slaDeadlineAt: instance.slaDeadlineAt ? new Date(instance.slaDeadlineAt) : undefined,
    slaBreachedAt: instance.slaBreachedAt ? new Date(instance.slaBreachedAt) : undefined,
    auditLog: instance.auditLog.map((e) => ({ ...e, timestamp: new Date(e.timestamp) })),
    infoRequest: instance.infoRequest
      ? { ...instance.infoRequest, askedAt: new Date(instance.infoRequest.askedAt) }
      : undefined,
    attachments: instance.attachments
      ? instance.attachments.map((a) => ({ ...a, addedAt: new Date(a.addedAt) }))
      : undefined,
    comments: instance.comments
      ? instance.comments.map((c) => ({ ...c, createdAt: new Date(c.createdAt) }))
      : undefined,
    levels: instance.levels.map((l) => {
      const level: typeof l = { ...l };
      if (l.escalationDueAt) level.escalationDueAt = new Date(l.escalationDueAt);
      if (l.delegatedUntil) level.delegatedUntil = new Date(l.delegatedUntil);
      if (l.reminderDueAt) level.reminderDueAt = new Date(l.reminderDueAt);
      if (l.openedAt) level.openedAt = new Date(l.openedAt);
      return level;
    }),
  };
}

function reviveTemplateDates(template: ApprovalTemplate): ApprovalTemplate {
  return { ...template, createdAt: new Date(template.createdAt) };
}

/**
 * Read a dot-path from a document, over **own** properties only.
 *
 * Mirrors how conditions resolve field paths, so a filter and a condition
 * written against the same path agree about what that path means — and an
 * inherited prototype member can never make an instance match a query.
 */
function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => {
    if (obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)) {
      return (obj as Record<string, unknown>)[key];
    }
    return undefined;
  }, data);
}

/** Structural equality, so a filter can match an object or array value. */
function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function applyFilter(instance: ApprovalInstance, filter: InstanceFilter): boolean {
  if (filter.status && instance.status !== filter.status) return false;
  if (filter.documentType && instance.documentType !== filter.documentType) return false;
  if (filter.submittedBy && instance.submittedBy !== filter.submittedBy) return false;
  if (filter.templateName && instance.templateName !== filter.templateName) return false;
  // Stored instances carry string dates (deepClone JSON round-trip), so wrap before comparing.
  if (filter.fromDate && new Date(instance.createdAt) < filter.fromDate) return false;
  if (filter.toDate && new Date(instance.createdAt) > filter.toDate) return false;
  if (filter.data) {
    for (const [path, expected] of Object.entries(filter.data)) {
      if (!deepEquals(readPath(instance.data ?? {}, path), expected)) return false;
    }
  }
  return true;
}

export class MemoryAdapter implements IStorageAdapter {
  // keyed by `${tenantId}:${template.name}`
  private templates = new Map<string, ApprovalTemplate>();
  // keyed by `${tenantId}:${instance.id}`
  private instances = new Map<string, ApprovalInstance>();

  async saveTemplate(template: ApprovalTemplate): Promise<void> {
    this.templates.set(`${template.tenantId}:${template.name}`, deepClone(template));
  }

  async getTemplate(tenantId: string, name: string): Promise<ApprovalTemplate | null> {
    const template = this.templates.get(`${tenantId}:${name}`);
    return template ? reviveTemplateDates(deepClone(template)) : null;
  }

  async listTemplates(tenantId: string): Promise<ApprovalTemplate[]> {
    const result: ApprovalTemplate[] = [];
    for (const [key, template] of this.templates) {
      if (key.startsWith(`${tenantId}:`)) {
        result.push(reviveTemplateDates(deepClone(template)));
      }
    }
    return result;
  }

  async saveInstance(instance: ApprovalInstance): Promise<void> {
    this.instances.set(`${instance.tenantId}:${instance.id}`, deepClone(instance));
  }

  async updateInstance(instance: ApprovalInstance, expectedVersion: number): Promise<void> {
    const key = `${instance.tenantId}:${instance.id}`;
    const stored = this.instances.get(key);
    if (!stored) throw new ApprovalConflictError(instance.id);
    if (stored.version !== expectedVersion) throw new ApprovalConflictError(instance.id);
    const updated = deepClone(instance);
    updated.version = expectedVersion + 1;
    this.instances.set(key, updated);
  }

  async getInstance(tenantId: string, id: string): Promise<ApprovalInstance | null> {
    const raw = this.instances.get(`${tenantId}:${id}`);
    if (!raw) return null;
    return reviveDates(deepClone(raw));
  }

  async getInstancesByApprover(
    tenantId: string,
    approverId: string,
    opts?: PaginationOpts,
  ): Promise<PaginatedResult<ApprovalInstance>> {
    const all = [...this.instances.values()].filter((i) => {
      if (i.tenantId !== tenantId || i.status !== 'pending') return false;
      // Use .find() by level number, not array index (level numbers may not be consecutive)
      const currentLevel = i.levels.find((l) => l.level === i.currentLevel);
      return currentLevel?.approverIds.includes(approverId) ?? false;
    });
    return paginate(
      all.map((i) => reviveDates(deepClone(i))),
      opts,
    );
  }

  async getInstancesByFilter(
    tenantId: string,
    filter: InstanceFilter,
    opts?: PaginationOpts,
  ): Promise<PaginatedResult<ApprovalInstance>> {
    const all = [...this.instances.values()].filter(
      (i) => i.tenantId === tenantId && applyFilter(i, filter),
    );
    return paginate(
      all.map((i) => reviveDates(deepClone(i))),
      opts,
    );
  }

  async getOverdueInstances(
    tenantId: string,
    asOf: Date,
    filter: InstanceFilter = {},
  ): Promise<ApprovalInstance[]> {
    return [...this.instances.values()]
      .filter((i) => {
        if (i.tenantId !== tenantId || i.status !== 'pending') return false;
        if (filter.documentType && i.documentType !== filter.documentType) return false;
        if (filter.submittedBy && i.submittedBy !== filter.submittedBy) return false;
        // Escalation overdue on ANY open branch. Filtering to i.currentLevel
        // would miss the upper branches of a parallel group entirely, and left
        // this adapter disagreeing with PostgresAdapter, which already scans
        // every level.
        const hasOverdueEscalation = i.levels.some(
          (l) => l.escalationDueAt != null && new Date(l.escalationDueAt) <= asOf,
        );
        // Instance deadline expired
        const isExpired = i.expiresAt != null && new Date(i.expiresAt) <= asOf;
        // SLA breach (not yet recorded)
        const hasSLABreach =
          i.slaDeadlineAt != null && new Date(i.slaDeadlineAt) <= asOf && !i.slaBreachedAt;
        // Delegation expiry on any pending level
        const hasDelegationExpiry = i.levels.some(
          (l) =>
            l.status === 'pending' &&
            l.delegatedUntil != null &&
            new Date(l.delegatedUntil) <= asOf &&
            l.delegatedFrom != null,
        );
        // Reminder due on any open branch. Without this the scheduler never
        // sees the instance and no reminder is ever sent.
        const hasDueReminder = i.levels.some(
          (l) =>
            l.status === 'pending' && l.reminderDueAt != null && new Date(l.reminderDueAt) <= asOf,
        );
        return (
          hasOverdueEscalation || isExpired || hasSLABreach || hasDelegationExpiry || hasDueReminder
        );
      })
      .map((i) => reviveDates(deepClone(i)));
  }

  async deleteInstance(tenantId: string, id: string): Promise<boolean> {
    const key = `${tenantId}:${id}`;
    // The audit trail lives on the instance in this adapter, so removing the
    // instance removes it too — matching PostgresAdapter, which cascades.
    return this.instances.delete(key);
  }

  async countInstances(tenantId: string, filter: InstanceFilter): Promise<number> {
    let count = 0;
    for (const instance of this.instances.values()) {
      if (instance.tenantId === tenantId && applyFilter(instance, filter)) count++;
    }
    return count;
  }

  async getInstancesByCursor(
    tenantId: string,
    filter: InstanceFilter,
    opts: CursorPaginationOpts,
  ): Promise<CursorPaginatedResult<ApprovalInstance>> {
    const all = [...this.instances.values()]
      .filter((i) => i.tenantId === tenantId && applyFilter(i, filter))
      .map((i) => reviveDates(deepClone(i)))
      .sort((a, b) => {
        const ta = a.updatedAt.getTime();
        const tb = b.updatedAt.getTime();
        return ta !== tb ? ta - tb : a.id.localeCompare(b.id);
      });

    const { cursor, limit, direction = 'forward' } = opts;
    let startIdx = 0;

    if (cursor) {
      const [ts, id] = decodeCursor(cursor);
      const idx = all.findIndex(
        (i) => i.updatedAt.getTime() > ts || (i.updatedAt.getTime() === ts && i.id > id),
      );
      startIdx = idx === -1 ? all.length : idx;
    }

    if (direction === 'backward' && startIdx > 0) {
      startIdx = Math.max(0, startIdx - limit - 1);
    }

    const slice = all.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < all.length;
    const nextCursor = hasMore ? encodeCursor(slice[slice.length - 1]!) : undefined;
    const prevCursor = startIdx > 0 ? encodeCursor(all[startIdx - 1]!) : undefined;

    return { items: slice, nextCursor, prevCursor, hasMore };
  }

  async getIdempotentInstance(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ApprovalInstance | null> {
    for (const instance of this.instances.values()) {
      if (instance.tenantId === tenantId && instance.idempotencyKey === idempotencyKey) {
        return reviveDates(deepClone(instance));
      }
    }
    return null;
  }

  async appendAuditEntry(
    _tenantId: string,
    _instanceId: string,
    _entry: AuditEntry,
  ): Promise<void> {
    // No-op by design. The engine already pushes each entry onto instance.auditLog
    // and persists the whole instance via saveInstance()/updateInstance(), so the
    // embedded log is the source of truth for this adapter. Pushing here too would
    // duplicate every entry (as a dedicated, append-only audit table would in
    // PostgresAdapter, this method exists to satisfy that separate-sink contract).
  }

  /** Test helper — total stored instances across all tenants. */
  get size(): number {
    return this.instances.size;
  }
}

function paginate<T>(items: T[], opts?: PaginationOpts): PaginatedResult<T> {
  const total = items.length;
  if (!opts) return { items, total };
  return { items: items.slice(opts.offset, opts.offset + opts.limit), total };
}

function encodeCursor(instance: ApprovalInstance): string {
  return Buffer.from(`${instance.updatedAt.getTime()}|${instance.id}`).toString('base64');
}

function decodeCursor(cursor: string): [number, string] {
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const pipeIdx = decoded.indexOf('|');
  return [Number(decoded.slice(0, pipeIdx)), decoded.slice(pipeIdx + 1)];
}
