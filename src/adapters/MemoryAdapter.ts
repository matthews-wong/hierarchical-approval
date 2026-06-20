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

function reviveDates(instance: ApprovalInstance): ApprovalInstance {
  return {
    ...instance,
    createdAt: new Date(instance.createdAt),
    updatedAt: new Date(instance.updatedAt),
    expiresAt: instance.expiresAt ? new Date(instance.expiresAt) : undefined,
    slaDeadlineAt: instance.slaDeadlineAt ? new Date(instance.slaDeadlineAt) : undefined,
    slaBreachedAt: instance.slaBreachedAt ? new Date(instance.slaBreachedAt) : undefined,
    auditLog: instance.auditLog.map((e) => ({ ...e, timestamp: new Date(e.timestamp) })),
    levels: instance.levels.map((l) => {
      const level: typeof l = { ...l };
      if (l.escalationDueAt) level.escalationDueAt = new Date(l.escalationDueAt);
      if (l.delegatedUntil) level.delegatedUntil = new Date(l.delegatedUntil);
      return level;
    }),
  };
}

function applyFilter(instance: ApprovalInstance, filter: InstanceFilter): boolean {
  if (filter.status && instance.status !== filter.status) return false;
  if (filter.documentType && instance.documentType !== filter.documentType) return false;
  if (filter.submittedBy && instance.submittedBy !== filter.submittedBy) return false;
  if (filter.fromDate && instance.createdAt < filter.fromDate) return false;
  if (filter.toDate && instance.createdAt > filter.toDate) return false;
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
    return deepClone(this.templates.get(`${tenantId}:${name}`) ?? null);
  }

  async listTemplates(tenantId: string): Promise<ApprovalTemplate[]> {
    const result: ApprovalTemplate[] = [];
    for (const [key, template] of this.templates) {
      if (key.startsWith(`${tenantId}:`)) {
        result.push(deepClone(template));
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
    return paginate(all.map((i) => reviveDates(deepClone(i))), opts);
  }

  async getInstancesByFilter(
    tenantId: string,
    filter: InstanceFilter,
    opts?: PaginationOpts,
  ): Promise<PaginatedResult<ApprovalInstance>> {
    const all = [...this.instances.values()].filter(
      (i) => i.tenantId === tenantId && applyFilter(i, filter),
    );
    return paginate(all.map((i) => reviveDates(deepClone(i))), opts);
  }

  async getOverdueInstances(tenantId: string, asOf: Date): Promise<ApprovalInstance[]> {
    return [...this.instances.values()]
      .filter((i) => {
        if (i.tenantId !== tenantId || i.status !== 'pending') return false;
        // Escalation overdue
        const currentLevel = i.levels.find((l) => l.level === i.currentLevel);
        const hasOverdueEscalation =
          currentLevel?.escalationDueAt != null && new Date(currentLevel.escalationDueAt) <= asOf;
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
        return hasOverdueEscalation || isExpired || hasSLABreach || hasDelegationExpiry;
      })
      .map((i) => reviveDates(deepClone(i)));
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

  async appendAuditEntry(tenantId: string, instanceId: string, entry: AuditEntry): Promise<void> {
    const key = `${tenantId}:${instanceId}`;
    const instance = this.instances.get(key);
    if (!instance) return;
    instance.auditLog.push(deepClone(entry));
    instance.updatedAt = new Date(entry.timestamp);
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
