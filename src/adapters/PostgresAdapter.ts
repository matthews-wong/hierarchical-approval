/**
 * PostgreSQL adapter for hierarchical-approval.
 *
 * Peer dependency: `pg` >= 8
 *
 * Run the bundled migration before using:
 *   const adapter = new PostgresAdapter({ connectionString: '...' });
 *   await adapter.migrate();
 *
 * For PostgreSQL Row Level Security, call:
 *   await adapter.enableRLS();
 */
import type {
  IStorageAdapter,
  PaginationOpts,
  PaginatedResult,
  InstanceFilter,
  CursorPaginationOpts,
  CursorPaginatedResult,
} from './IStorageAdapter.js';
import type { ApprovalTemplate, ApprovalInstance, AuditEntry } from '../types/index.js';
import { ApprovalConflictError, ApprovalValidationError } from '../errors.js';

export interface PostgresAdapterOptions {
  connectionString?: string;
  /** Bring your own pre-configured pg.Pool instead of a connectionString. */
  pool?: import('pg').Pool;
  tablePrefix?: string;
  /** PostgreSQL schema to use (default: 'public'). */
  schema?: string;
  /** Statement timeout in milliseconds applied to every query (default: none). */
  statementTimeoutMs?: number;
  ssl?: import('tls').ConnectionOptions;
}

const TABLE_PREFIX_RE = /^[a-z][a-z0-9_]*$/;

export class PostgresAdapter implements IStorageAdapter {
  private _pool: import('pg').Pool | null = null;
  private readonly prefix: string;
  private readonly schema: string;
  private readonly statementTimeoutMs?: number;
  private readonly externalPool: import('pg').Pool | undefined;

  constructor(private readonly opts: PostgresAdapterOptions) {
    const prefix = opts.tablePrefix ?? 'ha';
    if (!TABLE_PREFIX_RE.test(prefix)) {
      throw new ApprovalValidationError(
        `PostgresAdapter: tablePrefix "${prefix}" is invalid. Must match /^[a-z][a-z0-9_]*$/. Only lowercase letters, digits, and underscores are allowed.`,
      );
    }
    this.prefix = prefix;
    this.schema = opts.schema ?? 'public';
    this.statementTimeoutMs = opts.statementTimeoutMs;
    this.externalPool = opts.pool;
  }

  private async getPool(): Promise<import('pg').Pool> {
    if (this.externalPool) return this.externalPool;
    if (this._pool) return this._pool;
    const { default: pg } = await import('pg');
    this._pool = new pg.Pool({
      connectionString: this.opts.connectionString,
      ssl: this.opts.ssl,
    });
    return this._pool;
  }

  private get p() {
    return `${this.schema}.${this.prefix}`;
  }

  async migrate(): Promise<void> {
    const pool = await this.getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.p}_templates (
        tenant_id   TEXT NOT NULL,
        name        TEXT NOT NULL,
        data        JSONB NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, name)
      );

      CREATE TABLE IF NOT EXISTS ${this.p}_instances (
        id                  TEXT NOT NULL,
        tenant_id           TEXT NOT NULL,
        template_name       TEXT NOT NULL,
        document_id         TEXT NOT NULL,
        document_type       TEXT NOT NULL,
        submitted_by        TEXT NOT NULL,
        status              TEXT NOT NULL,
        current_level       INT  NOT NULL,
        version             INT  NOT NULL DEFAULT 1,
        idempotency_key     TEXT,
        data                JSONB NOT NULL DEFAULT '{}',
        metadata            JSONB NOT NULL DEFAULT '{}',
        levels              JSONB NOT NULL DEFAULT '[]',
        parent_instance_id  TEXT,
        expires_at          TIMESTAMPTZ,
        deadline_action     TEXT,
        sla_deadline_at     TIMESTAMPTZ,
        sla_breached_at     TIMESTAMPTZ,
        template_snapshot   JSONB,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id),
        UNIQUE (tenant_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS ${this.p}_audit_log (
        id               BIGSERIAL PRIMARY KEY,
        tenant_id        TEXT NOT NULL,
        instance_id      TEXT NOT NULL,
        action           TEXT NOT NULL,
        actor_id         TEXT NOT NULL,
        actor_role       TEXT,
        actor_ip         TEXT,
        actor_user_agent TEXT,
        trace_id         TEXT,
        level            INT  NOT NULL,
        timestamp        TIMESTAMPTZ NOT NULL,
        old_value        JSONB,
        new_value        JSONB,
        comment          TEXT,
        reason           TEXT,
        delegate_to      TEXT
      );

      CREATE INDEX IF NOT EXISTS ${this.p}_instances_tenant_status
        ON ${this.p}_instances (tenant_id, status);

      CREATE INDEX IF NOT EXISTS ${this.p}_instances_tenant_updated
        ON ${this.p}_instances (tenant_id, updated_at);

      CREATE INDEX IF NOT EXISTS ${this.p}_audit_log_instance
        ON ${this.p}_audit_log (tenant_id, instance_id);

      -- Add new columns to existing tables (idempotent for upgrades)
      ALTER TABLE IF EXISTS ${this.p}_instances ADD COLUMN IF NOT EXISTS parent_instance_id TEXT;
      ALTER TABLE IF EXISTS ${this.p}_instances ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
      ALTER TABLE IF EXISTS ${this.p}_instances ADD COLUMN IF NOT EXISTS deadline_action TEXT;
      ALTER TABLE IF EXISTS ${this.p}_instances ADD COLUMN IF NOT EXISTS sla_deadline_at TIMESTAMPTZ;
      ALTER TABLE IF EXISTS ${this.p}_instances ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMPTZ;
      ALTER TABLE IF EXISTS ${this.p}_instances ADD COLUMN IF NOT EXISTS template_snapshot JSONB;
    `);
  }

  /** Enable PostgreSQL Row Level Security for the instances and audit_log tables. */
  async enableRLS(): Promise<void> {
    const pool = await this.getPool();
    await pool.query(`
      ALTER TABLE ${this.p}_instances ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${this.p}_audit_log ENABLE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS ${this.p}_tenant_isolation ON ${this.p}_instances;
      CREATE POLICY ${this.p}_tenant_isolation ON ${this.p}_instances
        USING (tenant_id = current_setting('rls.tenant_id', TRUE));

      DROP POLICY IF EXISTS ${this.p}_audit_tenant_isolation ON ${this.p}_audit_log;
      CREATE POLICY ${this.p}_audit_tenant_isolation ON ${this.p}_audit_log
        USING (tenant_id = current_setting('rls.tenant_id', TRUE));
    `);
  }

  // ─── Templates ────────────────────────────────────────────────────────────

  async saveTemplate(template: ApprovalTemplate): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.p}_templates (tenant_id, name, data, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, name) DO UPDATE SET data = EXCLUDED.data`,
      [template.tenantId, template.name, JSON.stringify(template), template.createdAt.toISOString()],
    );
  }

  async getTemplate(tenantId: string, name: string): Promise<ApprovalTemplate | null> {
    const pool = await this.getPool();
    const result = await pool.query<{ data: ApprovalTemplate }>(
      `SELECT data FROM ${this.p}_templates WHERE tenant_id = $1 AND name = $2`,
      [tenantId, name],
    );
    return result.rows[0]?.data ?? null;
  }

  async listTemplates(tenantId: string): Promise<ApprovalTemplate[]> {
    const pool = await this.getPool();
    const result = await pool.query<{ data: ApprovalTemplate }>(
      `SELECT data FROM ${this.p}_templates WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [tenantId],
    );
    return result.rows.map((r) => r.data);
  }

  // ─── Instances ────────────────────────────────────────────────────────────

  async saveInstance(instance: ApprovalInstance): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.p}_instances
         (id, tenant_id, template_name, document_id, document_type, submitted_by,
          status, current_level, version, idempotency_key,
          data, metadata, levels,
          parent_instance_id, expires_at, deadline_action,
          sla_deadline_at, sla_breached_at, template_snapshot,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [
        instance.id,
        instance.tenantId,
        instance.templateName,
        instance.documentId,
        instance.documentType,
        instance.submittedBy,
        instance.status,
        instance.currentLevel,
        instance.version,
        instance.idempotencyKey ?? null,
        JSON.stringify(instance.data),
        JSON.stringify(instance.metadata),
        JSON.stringify(instance.levels),
        instance.parentInstanceId ?? null,
        instance.expiresAt?.toISOString() ?? null,
        instance.deadlineAction ?? null,
        instance.slaDeadlineAt?.toISOString() ?? null,
        instance.slaBreachedAt?.toISOString() ?? null,
        instance.templateSnapshot ? JSON.stringify(instance.templateSnapshot) : null,
        instance.createdAt.toISOString(),
        instance.updatedAt.toISOString(),
      ],
    );
  }

  async updateInstance(instance: ApprovalInstance, expectedVersion: number): Promise<void> {
    const pool = await this.getPool();
    const result = await pool.query(
      `UPDATE ${this.p}_instances SET
         status           = $4,
         current_level    = $5,
         version          = $6 + 1,
         levels           = $7,
         sla_breached_at  = $8,
         updated_at       = $9
       WHERE tenant_id = $1 AND id = $2 AND version = $3
       RETURNING id`,
      [
        instance.tenantId,
        instance.id,
        expectedVersion,
        instance.status,
        instance.currentLevel,
        expectedVersion,
        JSON.stringify(instance.levels),
        instance.slaBreachedAt?.toISOString() ?? null,
        instance.updatedAt.toISOString(),
      ],
    );
    if (result.rowCount === 0) throw new ApprovalConflictError(instance.id);
  }

  async getInstance(tenantId: string, id: string): Promise<ApprovalInstance | null> {
    const pool = await this.getPool();
    const result = await pool.query(
      `SELECT * FROM ${this.p}_instances WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.rowToInstance(row as Record<string, unknown>);
  }

  async getInstancesByApprover(
    tenantId: string,
    approverId: string,
    opts?: PaginationOpts,
  ): Promise<PaginatedResult<ApprovalInstance>> {
    const pool = await this.getPool();
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;

    const result = await pool.query(
      `SELECT *, COUNT(*) OVER() AS total_count
       FROM ${this.p}_instances
       WHERE tenant_id = $1
         AND status = 'pending'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(levels) AS lvl
           WHERE lvl->>'status' = 'pending'
             AND lvl->'approverIds' @> $2::jsonb
         )
       ORDER BY updated_at ASC
       LIMIT $3 OFFSET $4`,
      [tenantId, JSON.stringify([approverId]), limit, offset],
    );

    const total = result.rows[0] ? Number((result.rows[0] as Record<string, unknown>)['total_count']) : 0;
    return {
      items: result.rows.map((r) => this.rowToInstance(r as Record<string, unknown>)),
      total,
    };
  }

  async getInstancesByFilter(
    tenantId: string,
    filter: InstanceFilter,
    opts?: PaginationOpts,
  ): Promise<PaginatedResult<ApprovalInstance>> {
    const pool = await this.getPool();
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let idx = 2;

    if (filter.status) { conditions.push(`status = $${idx++}`); params.push(filter.status); }
    if (filter.documentType) { conditions.push(`document_type = $${idx++}`); params.push(filter.documentType); }
    if (filter.submittedBy) { conditions.push(`submitted_by = $${idx++}`); params.push(filter.submittedBy); }
    if (filter.fromDate) { conditions.push(`created_at >= $${idx++}`); params.push(filter.fromDate.toISOString()); }
    if (filter.toDate) { conditions.push(`created_at <= $${idx++}`); params.push(filter.toDate.toISOString()); }

    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    params.push(limit, offset);

    const sql = `SELECT *, COUNT(*) OVER() AS total_count
                 FROM ${this.p}_instances
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY created_at DESC
                 LIMIT $${idx++} OFFSET $${idx}`;

    const result = await pool.query(sql, params);
    const total = result.rows[0] ? Number((result.rows[0] as Record<string, unknown>)['total_count']) : 0;
    return {
      items: result.rows.map((r) => this.rowToInstance(r as Record<string, unknown>)),
      total,
    };
  }

  async getOverdueInstances(tenantId: string, asOf: Date): Promise<ApprovalInstance[]> {
    const pool = await this.getPool();
    const result = await pool.query(
      `SELECT * FROM ${this.p}_instances
       WHERE tenant_id = $1
         AND status = 'pending'
         AND (
           EXISTS (
             SELECT 1 FROM jsonb_array_elements(levels) AS lvl
             WHERE (lvl->>'escalationDueAt') IS NOT NULL
               AND (lvl->>'escalationDueAt')::timestamptz <= $2
           )
           OR (expires_at IS NOT NULL AND expires_at <= $2)
           OR (sla_deadline_at IS NOT NULL AND sla_deadline_at <= $2 AND sla_breached_at IS NULL)
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(levels) AS lvl
             WHERE lvl->>'status' = 'pending'
               AND (lvl->>'delegatedUntil') IS NOT NULL
               AND (lvl->>'delegatedUntil')::timestamptz <= $2
               AND (lvl->>'delegatedFrom') IS NOT NULL
           )
         )`,
      [tenantId, asOf.toISOString()],
    );
    return result.rows.map((r) => this.rowToInstance(r as Record<string, unknown>));
  }

  async getIdempotentInstance(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ApprovalInstance | null> {
    const pool = await this.getPool();
    const result = await pool.query(
      `SELECT * FROM ${this.p}_instances WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.rowToInstance(row as Record<string, unknown>);
  }

  // ─── Audit (append-only) ──────────────────────────────────────────────────

  async appendAuditEntry(tenantId: string, instanceId: string, entry: AuditEntry): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.p}_audit_log
         (tenant_id, instance_id, action, actor_id, actor_role, actor_ip,
          actor_user_agent, trace_id, level, timestamp,
          old_value, new_value, comment, reason, delegate_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        tenantId,
        instanceId,
        entry.action,
        entry.actorId,
        entry.actorRole ?? null,
        entry.actorIp ?? null,
        entry.actorUserAgent ?? null,
        entry.traceId ?? null,
        entry.level,
        entry.timestamp.toISOString(),
        entry.oldValue ? JSON.stringify(entry.oldValue) : null,
        entry.newValue ? JSON.stringify(entry.newValue) : null,
        entry.comment ?? null,
        entry.reason ?? null,
        entry.delegateTo ?? null,
      ],
    );
  }

  async getInstancesByCursor(
    tenantId: string,
    filter: InstanceFilter,
    opts: CursorPaginationOpts,
  ): Promise<CursorPaginatedResult<ApprovalInstance>> {
    const pool = await this.getPool();
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let idx = 2;

    if (filter.status) { conditions.push(`status = $${idx++}`); params.push(filter.status); }
    if (filter.documentType) { conditions.push(`document_type = $${idx++}`); params.push(filter.documentType); }
    if (filter.submittedBy) { conditions.push(`submitted_by = $${idx++}`); params.push(filter.submittedBy); }

    const { cursor, limit, direction = 'forward' } = opts;

    if (cursor) {
      const decoded = Buffer.from(cursor, 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      const ts = decoded.slice(0, colonIdx);
      const id = decoded.slice(colonIdx + 1);
      if (direction === 'forward') {
        conditions.push(`(updated_at, id) > ($${idx++}::timestamptz, $${idx++})`);
        params.push(ts, id);
      } else {
        conditions.push(`(updated_at, id) < ($${idx++}::timestamptz, $${idx++})`);
        params.push(ts, id);
      }
    }

    params.push(limit + 1);
    const order = direction === 'backward' ? 'DESC' : 'ASC';
    const sql = `SELECT * FROM ${this.p}_instances
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY updated_at ${order}, id ${order}
                 LIMIT $${idx}`;

    const result = await pool.query(sql, params);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map((r) => this.rowToInstance(r as Record<string, unknown>));

    const nextCursor = hasMore
      ? Buffer.from(`${rows[rows.length - 1]!['updated_at']}:${rows[rows.length - 1]!['id']}`).toString('base64')
      : undefined;

    return { items, nextCursor, hasMore };
  }

  async end(): Promise<void> {
    await this._pool?.end();
    this._pool = null;
  }

  private rowToInstance(row: Record<string, unknown>): ApprovalInstance {
    return {
      id: row['id'] as string,
      tenantId: row['tenant_id'] as string,
      templateId: '',
      templateName: row['template_name'] as string,
      documentId: row['document_id'] as string,
      documentType: row['document_type'] as string,
      submittedBy: row['submitted_by'] as string,
      status: row['status'] as ApprovalInstance['status'],
      currentLevel: row['current_level'] as number,
      version: row['version'] as number,
      idempotencyKey: (row['idempotency_key'] as string | null) ?? undefined,
      data: row['data'] as Record<string, unknown>,
      metadata: row['metadata'] as Record<string, unknown>,
      levels: row['levels'] as ApprovalInstance['levels'],
      auditLog: [],
      parentInstanceId: (row['parent_instance_id'] as string | null) ?? undefined,
      expiresAt: row['expires_at'] ? new Date(row['expires_at'] as string) : undefined,
      deadlineAction: (row['deadline_action'] as 'cancel' | 'reject' | null) ?? undefined,
      slaDeadlineAt: row['sla_deadline_at'] ? new Date(row['sla_deadline_at'] as string) : undefined,
      slaBreachedAt: row['sla_breached_at'] ? new Date(row['sla_breached_at'] as string) : undefined,
      templateSnapshot: (row['template_snapshot'] as ApprovalInstance['templateSnapshot'] | null) ?? undefined,
      createdAt: new Date(row['created_at'] as string),
      updatedAt: new Date(row['updated_at'] as string),
    };
  }
}
