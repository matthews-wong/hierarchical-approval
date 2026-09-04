import { describe, it, expect } from 'vitest';
import { PostgresAdapter } from '../../../src/adapters/PostgresAdapter.js';
import { MemoryAdapter } from '../../../src/adapters/MemoryAdapter.js';
import { ApprovalConflictError, ApprovalValidationError } from '../../../src/errors.js';
import type { ApprovalInstance, ApprovalTemplate } from '../../../src/types/index.js';
import { makeInstance, makeEntry } from '../plugins/_helpers.js';
import { FakePool } from './_fakePg.js';

function makeTemplate(over: Partial<ApprovalTemplate> = {}): ApprovalTemplate {
  return {
    id: 'tpl-1',
    tenantId: 'tenant-1',
    name: 'tpl',
    documentType: 'invoice',
    levels: [],
    version: 1,
    createdAt: new Date('2026-06-26T09:00:00.000Z'),
    ...over,
  };
}

/** Fresh adapter wired to a fresh FakePool via the pool-injection option (never the `pg` dynamic import). */
function freshAdapter(opts: { tablePrefix?: string; schema?: string } = {}): {
  pool: FakePool;
  adapter: PostgresAdapter;
} {
  const pool = new FakePool();
  const adapter = new PostgresAdapter({ pool: pool.asPool(), ...opts });
  return { pool, adapter };
}

/**
 * Mirrors what a real `SELECT *` row would look like: JSONB columns already
 * parsed into JS values (node-postgres does this automatically) and
 * TIMESTAMPTZ columns as `Date` instances (node-postgres's default type
 * parser), not the JSON-stringified / ISO-string shapes `saveInstance` sends.
 */
function instanceToRow(instance: ApprovalInstance): Record<string, unknown> {
  return {
    id: instance.id,
    tenant_id: instance.tenantId,
    template_id: instance.templateId,
    template_name: instance.templateName,
    document_id: instance.documentId,
    document_type: instance.documentType,
    submitted_by: instance.submittedBy,
    status: instance.status,
    current_level: instance.currentLevel,
    version: instance.version,
    idempotency_key: instance.idempotencyKey ?? null,
    data: instance.data,
    metadata: instance.metadata,
    levels: instance.levels,
    parent_instance_id: instance.parentInstanceId ?? null,
    expires_at: instance.expiresAt ?? null,
    deadline_action: instance.deadlineAction ?? null,
    sla_deadline_at: instance.slaDeadlineAt ?? null,
    sla_breached_at: instance.slaBreachedAt ?? null,
    template_snapshot: instance.templateSnapshot ?? null,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
}

describe('PostgresAdapter — constructor validation', () => {
  it('accepts the defaults (prefix "ha", schema "public") without throwing', () => {
    expect(() => new PostgresAdapter({})).not.toThrow();
  });

  it('accepts a valid custom tablePrefix and schema', () => {
    expect(() => new PostgresAdapter({ tablePrefix: 'wf', schema: 'approvals' })).not.toThrow();
  });

  it('rejects an invalid tablePrefix', () => {
    expect(() => new PostgresAdapter({ tablePrefix: 'Ha-Bad!' })).toThrow(ApprovalValidationError);
    expect(() => new PostgresAdapter({ tablePrefix: '1leadingdigit' })).toThrow(
      ApprovalValidationError,
    );
  });

  it('rejects an invalid schema (DEFECT FIX: schema was previously interpolated into every query with no validation at all, unlike tablePrefix)', () => {
    expect(() => new PostgresAdapter({ schema: 'public; DROP TABLE ha_instances' })).toThrow(
      ApprovalValidationError,
    );
    expect(() => new PostgresAdapter({ schema: 'Public' })).toThrow(ApprovalValidationError);
    expect(() => new PostgresAdapter({ schema: '' })).toThrow(ApprovalValidationError);
  });
});

describe('PostgresAdapter — migrate()', () => {
  it('creates all three tables and their indexes with IF NOT EXISTS', async () => {
    const { pool, adapter } = freshAdapter();
    await adapter.migrate();
    const sql = pool.sqlAt(0);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.ha_templates');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.ha_instances');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.ha_audit_log');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS public.ha_instances_tenant_status');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS public.ha_instances_tenant_updated');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS public.ha_audit_log_instance');
  });

  it('DEFECT FIX regression guard: the instances table carries a template_id column, both in CREATE and the upgrade ALTER', async () => {
    const { pool, adapter } = freshAdapter();
    await adapter.migrate();
    const sql = pool.sqlAt(0);
    expect(sql).toMatch(/template_id\s+TEXT NOT NULL DEFAULT ''/);
    expect(sql).toContain(
      "ALTER TABLE IF EXISTS public.ha_instances ADD COLUMN IF NOT EXISTS template_id TEXT NOT NULL DEFAULT ''",
    );
  });

  it('is idempotent: calling it twice issues the same DDL both times with no error', async () => {
    const { pool, adapter } = freshAdapter();
    await adapter.migrate();
    await adapter.migrate();
    expect(pool.queries).toHaveLength(2);
    expect(pool.queries[0]!.sql).toBe(pool.queries[1]!.sql);
    // Every CREATE/ALTER is guarded so re-running never fails against existing objects.
    expect(pool.sqlAt(0)).not.toMatch(/CREATE TABLE(?! IF NOT EXISTS)/);
    expect(pool.sqlAt(0)).not.toMatch(/ADD COLUMN(?! IF NOT EXISTS)/);
  });

  it('honors a custom tablePrefix and schema in the generated DDL', async () => {
    const { pool, adapter } = freshAdapter({ tablePrefix: 'wf', schema: 'approvals' });
    await adapter.migrate();
    expect(pool.sqlAt(0)).toContain('approvals.wf_instances');
    expect(pool.sqlAt(0)).not.toContain('public.ha_instances');
  });
});

describe('PostgresAdapter — enableRLS()', () => {
  it('enables row-level security and creates a tenant_id policy on instances and audit_log', async () => {
    const { pool, adapter } = freshAdapter();
    await adapter.enableRLS();
    const sql = pool.sqlAt(0);
    expect(sql).toContain('ALTER TABLE public.ha_instances ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE public.ha_audit_log ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE POLICY public.ha_tenant_isolation ON public.ha_instances');
    expect(sql).toContain('CREATE POLICY public.ha_audit_tenant_isolation ON public.ha_audit_log');
    expect(sql).toContain("current_setting('rls.tenant_id', TRUE)");
  });
});

describe('PostgresAdapter — tenant isolation', () => {
  const TENANT = 'acme-corp';

  it.each([
    ['getTemplate', (a: PostgresAdapter) => a.getTemplate(TENANT, 'tpl')],
    ['listTemplates', (a: PostgresAdapter) => a.listTemplates(TENANT)],
    ['getInstance', (a: PostgresAdapter) => a.getInstance(TENANT, 'inst-1')],
    ['getInstancesByApprover', (a: PostgresAdapter) => a.getInstancesByApprover(TENANT, 'user-1')],
    ['getInstancesByFilter', (a: PostgresAdapter) => a.getInstancesByFilter(TENANT, {})],
    ['getOverdueInstances', (a: PostgresAdapter) => a.getOverdueInstances(TENANT, new Date())],
    ['getIdempotentInstance', (a: PostgresAdapter) => a.getIdempotentInstance(TENANT, 'key-1')],
    [
      'getInstancesByCursor',
      (a: PostgresAdapter) => a.getInstancesByCursor(TENANT, {}, { limit: 10 }),
    ],
  ] as const)(
    '%s scopes its query to tenant_id = $1 = tenantId — a missing filter here is a cross-tenant data leak',
    async (_name, run) => {
      const { pool, adapter } = freshAdapter();
      pool.queueResult({ rows: [] });
      await run(adapter);
      expect(pool.sqlAt(0)).toMatch(/tenant_id\s*=\s*\$1/);
      expect(pool.queries[0]!.params[0]).toBe(TENANT);
    },
  );

  it('saveTemplate persists tenant_id', async () => {
    const { pool, adapter } = freshAdapter();
    await adapter.saveTemplate(makeTemplate({ tenantId: TENANT }));
    expect(pool.sqlAt(0)).toContain('tenant_id');
    expect(pool.queries[0]!.params[0]).toBe(TENANT);
  });

  it('saveInstance persists tenant_id', async () => {
    const { pool, adapter } = freshAdapter();
    await adapter.saveInstance(makeInstance({ tenantId: TENANT }));
    expect(pool.sqlAt(0)).toContain('tenant_id');
    expect(pool.queries[0]!.params[1]).toBe(TENANT);
  });

  it('updateInstance scopes its WHERE clause to tenant_id = $1', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [{ id: 'inst-1' }], rowCount: 1 });
    await adapter.updateInstance(makeInstance({ tenantId: TENANT }), 1);
    expect(pool.sqlAt(0)).toMatch(/WHERE tenant_id = \$1/);
    expect(pool.queries[0]!.params[0]).toBe(TENANT);
  });

  it('appendAuditEntry persists tenant_id', async () => {
    const { pool, adapter } = freshAdapter();
    await adapter.appendAuditEntry(TENANT, 'inst-1', makeEntry());
    expect(pool.sqlAt(0)).toContain('tenant_id');
    expect(pool.queries[0]!.params[0]).toBe(TENANT);
  });
});

describe('PostgresAdapter — parameterization (no interpolated literals)', () => {
  // Deliberately SQL-injection-shaped so a leak into the query TEXT is unmistakable.
  const MARKER = `x'); DROP TABLE ha_instances; --`;

  it('every dynamic value flows through $n params — none land in the SQL text', async () => {
    const { pool, adapter } = freshAdapter();

    await adapter.saveTemplate(makeTemplate({ tenantId: MARKER, name: MARKER }));
    pool.queueResult({ rows: [] });
    await adapter.getTemplate(MARKER, MARKER);
    pool.queueResult({ rows: [] });
    await adapter.listTemplates(MARKER);
    await adapter.saveInstance(makeInstance({ tenantId: MARKER, id: MARKER, submittedBy: MARKER }));
    pool.queueResult({ rows: [{ id: 'x' }], rowCount: 1 });
    await adapter.updateInstance(makeInstance({ tenantId: MARKER, id: MARKER }), 1);
    pool.queueResult({ rows: [] });
    await adapter.getInstance(MARKER, MARKER);
    pool.queueResult({ rows: [] });
    await adapter.getInstancesByApprover(MARKER, MARKER);
    pool.queueResult({ rows: [] });
    await adapter.getInstancesByFilter(MARKER, {
      submittedBy: MARKER,
      documentType: MARKER,
      templateName: MARKER,
    });
    pool.queueResult({ rows: [] });
    await adapter.getOverdueInstances(MARKER, new Date());
    pool.queueResult({ rows: [] });
    await adapter.getIdempotentInstance(MARKER, MARKER);
    await adapter.appendAuditEntry(MARKER, MARKER, makeEntry({ actorId: MARKER, comment: MARKER }));
    pool.queueResult({ rows: [] });
    await adapter.getInstancesByCursor(MARKER, { submittedBy: MARKER }, { limit: 5 });

    for (const { sql } of pool.queries) {
      expect(sql).not.toContain(MARKER);
    }
    // Sanity check the marker really was sent somewhere — just never spliced into text.
    expect(pool.queries.some((q) => q.params.includes(MARKER))).toBe(true);
  });
});

describe('PostgresAdapter — round-trip mapping', () => {
  it('getInstance maps every column back to the same shape MemoryAdapter produces for the same domain instance (auditLog aside, which is a separate append-only sink)', async () => {
    const instance = makeInstance({
      templateId: 'tpl-99',
      idempotencyKey: 'idem-1',
      parentInstanceId: 'inst-parent',
      expiresAt: new Date('2026-07-01T00:00:00.000Z'),
      deadlineAction: 'reject',
      slaDeadlineAt: new Date('2026-07-02T00:00:00.000Z'),
      slaBreachedAt: new Date('2026-07-03T00:00:00.000Z'),
      templateSnapshot: { allowOverride: true, slaDeadlineDays: 3 },
      data: { amount: 500, nested: { ok: true } },
      metadata: { source: 'api' },
      levels: [
        {
          level: 1,
          name: 'Manager',
          mode: 'any',
          approverConfigs: [],
          approverIds: ['mgr-1'],
          approvedBy: [],
          rejectedBy: [],
          status: 'pending',
          escalationDueAt: new Date('2026-06-27T00:00:00.000Z'),
        },
      ],
      auditLog: [makeEntry()],
    });

    const memAdapter = new MemoryAdapter();
    await memAdapter.saveInstance(instance);
    const expected = await memAdapter.getInstance(instance.tenantId, instance.id);

    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [instanceToRow(instance)] });
    const actual = await adapter.getInstance(instance.tenantId, instance.id);

    // PostgresAdapter never embeds the audit log on the instance row (append-only
    // sink table); MemoryAdapter embeds it. Everything else must match exactly.
    expect(actual).toEqual({ ...expected, auditLog: [] });
  });

  it('maps NULL optional columns to undefined, not null, matching MemoryAdapter for an instance with no optional fields set', async () => {
    const instance = makeInstance({
      idempotencyKey: undefined,
      parentInstanceId: undefined,
      expiresAt: undefined,
      deadlineAction: undefined,
      slaDeadlineAt: undefined,
      slaBreachedAt: undefined,
      templateSnapshot: undefined,
    });

    const memAdapter = new MemoryAdapter();
    await memAdapter.saveInstance(instance);
    const expected = await memAdapter.getInstance(instance.tenantId, instance.id);

    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [instanceToRow(instance)] });
    const actual = await adapter.getInstance(instance.tenantId, instance.id);

    expect(actual).toEqual({ ...expected, auditLog: [] });
    expect(actual?.idempotencyKey).toBeUndefined();
    expect(actual?.parentInstanceId).toBeUndefined();
    expect(actual?.expiresAt).toBeUndefined();
    expect(actual?.deadlineAction).toBeUndefined();
    expect(actual?.slaDeadlineAt).toBeUndefined();
    expect(actual?.slaBreachedAt).toBeUndefined();
    expect(actual?.templateSnapshot).toBeUndefined();
  });

  it('getInstance returns null (not undefined) when no row matches', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [] });
    expect(await adapter.getInstance('tenant-1', 'missing')).toBeNull();
  });

  it('getTemplate round-trips the JSONB data column verbatim, or returns null when absent', async () => {
    const { pool, adapter } = freshAdapter();
    const tpl = makeTemplate();
    pool.queueResult({ rows: [{ data: tpl }] });
    expect(await adapter.getTemplate(tpl.tenantId, tpl.name)).toEqual(tpl);

    pool.queueResult({ rows: [] });
    expect(await adapter.getTemplate('tenant-1', 'missing')).toBeNull();
  });

  it('saveTemplate serializes the entire template object into the data param', async () => {
    const { pool, adapter } = freshAdapter();
    const tpl = makeTemplate();
    await adapter.saveTemplate(tpl);
    const { params } = pool.queries[0]!;
    // JSON.stringify serializes Date as an ISO string — everything else must
    // survive verbatim, proving the whole template is persisted, not a subset.
    expect(JSON.parse(params[2] as string)).toEqual({
      ...tpl,
      createdAt: tpl.createdAt.toISOString(),
    });
  });

  it('getIdempotentInstance returns null when no row matches the idempotency key', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [] });
    expect(await adapter.getIdempotentInstance('tenant-1', 'missing-key')).toBeNull();
  });

  it('getIdempotentInstance maps the matching row to an instance', async () => {
    const instance = makeInstance({ idempotencyKey: 'key-1' });
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [instanceToRow(instance)] });
    const found = await adapter.getIdempotentInstance(instance.tenantId, 'key-1');
    expect(found?.id).toBe(instance.id);
    expect(found?.idempotencyKey).toBe('key-1');
  });
});

describe('PostgresAdapter — updateInstance', () => {
  it('throws ApprovalConflictError when the version predicate matches no row', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [], rowCount: 0 });
    await expect(adapter.updateInstance(makeInstance(), 1)).rejects.toThrow(ApprovalConflictError);
  });

  it('bumps version from the expectedVersion param via SQL (version = $6 + 1), never trusting instance.version', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [{ id: 'inst-1' }], rowCount: 1 });
    await adapter.updateInstance(makeInstance({ version: 99 }), 4);
    const { sql, params } = pool.queries[0]!;
    expect(sql).toMatch(/version\s*=\s*\$6 \+ 1/);
    expect(params[2]).toBe(4); // WHERE version = $3
    expect(params[5]).toBe(4); // SET version = $6 + 1
  });
});

describe('PostgresAdapter — appendAuditEntry', () => {
  it('persists all AuditEntry fields, defaulting absent optional fields to null', async () => {
    const { pool, adapter } = freshAdapter();
    await adapter.appendAuditEntry('tenant-1', 'inst-1', makeEntry());
    const { sql, params } = pool.queries[0]!;
    expect(sql).toContain('INSERT INTO public.ha_audit_log');
    expect(params[3]).toBe('user-1'); // actorId
    expect(params[4]).toBeNull(); // actorRole
    expect(params[5]).toBeNull(); // actorIp
    expect(params[6]).toBeNull(); // actorUserAgent
    expect(params[7]).toBeNull(); // traceId
  });
});

describe('PostgresAdapter — getInstancesByApprover', () => {
  it('filters to pending status and JSONB approverIds containment, tenant-scoped', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [] });
    await adapter.getInstancesByApprover('tenant-1', 'mgr-1', { limit: 5, offset: 10 });
    const { sql, params } = pool.queries[0]!;
    expect(sql).toMatch(/tenant_id = \$1/);
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("lvl->'approverIds' @> $2::jsonb");
    expect(params).toEqual(['tenant-1', JSON.stringify(['mgr-1']), 5, 10]);
  });

  it('defaults to limit 50, offset 0 when opts is omitted', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [] });
    await adapter.getInstancesByApprover('tenant-1', 'mgr-1');
    expect(pool.queries[0]!.params.slice(-2)).toEqual([50, 0]);
  });

  it('reads total from the total_count window column', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({
      rows: [{ ...instanceToRow(makeInstance()), total_count: '3' }],
    });
    const result = await adapter.getInstancesByApprover('tenant-1', 'mgr-1');
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(1);
  });
});

describe('PostgresAdapter — getInstancesByFilter', () => {
  it('adds one condition + positional param per present filter field, tenant-scoped first, with params aligned to placeholders', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [] });
    await adapter.getInstancesByFilter(
      'tenant-1',
      {
        status: 'pending',
        documentType: 'invoice',
        submittedBy: 'alice',
        templateName: 'PO',
        fromDate: new Date('2026-01-01T00:00:00.000Z'),
        toDate: new Date('2026-02-01T00:00:00.000Z'),
      },
      { limit: 10, offset: 20 },
    );

    const { sql, params } = pool.queries[0]!;
    expect(sql).toMatch(/tenant_id = \$1/);
    expect(sql).toMatch(/status = \$2/);
    expect(sql).toMatch(/document_type = \$3/);
    expect(sql).toMatch(/submitted_by = \$4/);
    expect(sql).toMatch(/template_name = \$5/);
    expect(sql).toMatch(/created_at >= \$6/);
    expect(sql).toMatch(/created_at <= \$7/);
    expect(sql).toMatch(/LIMIT \$8 OFFSET \$9/);
    expect(params).toEqual([
      'tenant-1',
      'pending',
      'invoice',
      'alice',
      'PO',
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
      10,
      20,
    ]);
  });

  it('omits a condition entirely for a filter field that is not provided', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [] });
    await adapter.getInstancesByFilter('tenant-1', { status: 'approved' });
    const { sql, params } = pool.queries[0]!;
    expect(sql).not.toContain('document_type');
    expect(sql).not.toContain('submitted_by');
    expect(sql).not.toContain('template_name');
    expect(params).toEqual(['tenant-1', 'approved', 50, 0]);
  });

  it('defaults to limit 50, offset 0 when opts is omitted', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [] });
    await adapter.getInstancesByFilter('tenant-1', {});
    expect(pool.queries[0]!.params).toEqual(['tenant-1', 50, 0]);
  });

  it('reads total from the total_count window column, not rows.length, and is 0 when empty', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [{ ...instanceToRow(makeInstance()), total_count: '7' }] });
    const withRows = await adapter.getInstancesByFilter('tenant-1', {});
    expect(withRows.total).toBe(7);
    expect(withRows.items).toHaveLength(1);

    pool.queueResult({ rows: [] });
    const empty = await adapter.getInstancesByFilter('tenant-1', {});
    expect(empty.total).toBe(0);
  });
});

describe('PostgresAdapter — getOverdueInstances', () => {
  it('checks escalation, expiry, SLA breach, and delegation-expiry conditions, tenant-scoped', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [] });
    const asOf = new Date('2026-07-01T00:00:00.000Z');
    await adapter.getOverdueInstances('tenant-1', asOf);
    const { sql, params } = pool.queries[0]!;
    expect(sql).toMatch(/tenant_id = \$1/);
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('escalationDueAt');
    expect(sql).toContain('expires_at IS NOT NULL AND expires_at <= $2');
    expect(sql).toContain(
      'sla_deadline_at IS NOT NULL AND sla_deadline_at <= $2 AND sla_breached_at IS NULL',
    );
    expect(sql).toContain('delegatedUntil');
    expect(params).toEqual(['tenant-1', asOf.toISOString()]);
  });
});

describe('PostgresAdapter — getInstancesByCursor', () => {
  it('adds filter conditions before the cursor/limit params, tenant-scoped first', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [] });
    await adapter.getInstancesByCursor(
      'tenant-1',
      { status: 'pending', documentType: 'invoice', submittedBy: 'alice', templateName: 'PO' },
      { limit: 10 },
    );
    const { sql, params } = pool.queries[0]!;
    expect(sql).toMatch(/tenant_id = \$1/);
    expect(sql).toMatch(/status = \$2/);
    expect(sql).toMatch(/document_type = \$3/);
    expect(sql).toMatch(/submitted_by = \$4/);
    expect(sql).toMatch(/template_name = \$5/);
    expect(sql).toMatch(/LIMIT \$6/);
    expect(params).toEqual(['tenant-1', 'pending', 'invoice', 'alice', 'PO', 11]);
  });

  it('requests limit + 1 rows to detect hasMore, and trims items back to limit', async () => {
    const { pool, adapter } = freshAdapter();
    const rows = [
      instanceToRow(makeInstance({ id: 'a' })),
      instanceToRow(makeInstance({ id: 'b' })),
      instanceToRow(makeInstance({ id: 'c' })),
    ];
    pool.queueResult({ rows });
    const result = await adapter.getInstancesByCursor('tenant-1', {}, { limit: 2 });
    expect(pool.queries[0]!.params.at(-1)).toBe(3);
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
  });

  it('hasMore is false and nextCursor is undefined when fewer than limit + 1 rows come back', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({ rows: [instanceToRow(makeInstance())] });
    const result = await adapter.getInstancesByCursor('tenant-1', {}, { limit: 5 });
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  it('decodes a cursor into a (updated_at, id) comparison appended after filter params — forward direction uses > and ASC', async () => {
    const { pool, adapter } = freshAdapter();
    const cursor = Buffer.from('2026-06-26T09:00:00.000Z:inst-1').toString('base64');
    pool.queueResult({ rows: [] });
    await adapter.getInstancesByCursor('tenant-1', {}, { cursor, limit: 10, direction: 'forward' });
    const { sql, params } = pool.queries[0]!;
    expect(sql).toContain('(updated_at, id) > ($2::timestamptz, $3)');
    expect(sql).toMatch(/ORDER BY updated_at ASC, id ASC/);
    expect(params).toEqual(['tenant-1', '2026-06-26T09:00:00.000Z', 'inst-1', 11]);
  });

  it('backward direction uses < and DESC ordering', async () => {
    const { pool, adapter } = freshAdapter();
    const cursor = Buffer.from('2026-06-26T09:00:00.000Z:inst-1').toString('base64');
    pool.queueResult({ rows: [] });
    await adapter.getInstancesByCursor(
      'tenant-1',
      {},
      { cursor, limit: 10, direction: 'backward' },
    );
    const { sql, params } = pool.queries[0]!;
    expect(sql).toContain('(updated_at, id) < ($2::timestamptz, $3)');
    expect(sql).toMatch(/ORDER BY updated_at DESC, id DESC/);
    expect(params[1]).toBe('2026-06-26T09:00:00.000Z');
    expect(params[2]).toBe('inst-1');
  });

  it('DEFECT FIX regression guard: a cursor produced by this adapter decodes back to the exact same timestamp and id — no colon-splitting corruption', async () => {
    // The previous implementation split the decoded cursor on the FIRST colon
    // via `indexOf(':')`. The timestamp segment is an ISO-8601 string
    // ("2026-06-26T09:30:45.123Z"), which itself contains colons, so the old
    // code truncated the timestamp to "...T09" and corrupted the id with the
    // leftover fragment on every subsequent page fetch. This test proves a
    // cursor emitted by getInstancesByCursor decodes back to the untruncated
    // values when fed into the next call.
    const { pool, adapter } = freshAdapter();
    const lastRow = instanceToRow(
      makeInstance({ id: 'inst-xyz', updatedAt: new Date('2026-06-26T09:30:45.123Z') }),
    );
    // limit=1 with 2 rows queued -> hasMore=true, cursor built from the single
    // row kept after slicing to `limit`.
    const overflowRow = instanceToRow(makeInstance({ id: 'inst-overflow' }));
    pool.queueResult({ rows: [lastRow, overflowRow] });
    const page1 = await adapter.getInstancesByCursor('tenant-1', {}, { limit: 1 });
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    pool.queueResult({ rows: [] });
    await adapter.getInstancesByCursor('tenant-1', {}, { cursor: page1.nextCursor, limit: 1 });
    const { params } = pool.queries[1]!;
    expect(params[1]).toBe('2026-06-26T09:30:45.123Z');
    expect(params[2]).toBe('inst-xyz');
  });
});

describe('PostgresAdapter — transactions', () => {
  it('performs no multi-statement transactions — every write is already a single atomic statement', async () => {
    // saveInstance is one INSERT ... ON CONFLICT DO NOTHING; updateInstance is
    // one UPDATE ... WHERE version = $n RETURNING id. Neither needs BEGIN/COMMIT/
    // ROLLBACK, and the adapter never calls pool.connect() to check out a
    // PoolClient — every method goes through pool.query() directly. FakePool
    // intentionally does not implement connect()/release(), so this test also
    // guards against transaction usage being introduced without test coverage.
    const { pool, adapter } = freshAdapter();
    await adapter.saveInstance(makeInstance());
    pool.queueResult({ rows: [{ id: 'inst-1' }], rowCount: 1 });
    await adapter.updateInstance(makeInstance(), 1);
    expect((pool as unknown as { connect?: unknown }).connect).toBeUndefined();
  });
});

describe('PostgresAdapter — end()', () => {
  it('does not close a caller-supplied external pool — ownership stays with the caller', async () => {
    const { pool, adapter } = freshAdapter();
    await adapter.end();
    expect(pool.endCalls).toBe(0);
  });
});

describe('PostgresAdapter — template date revival', () => {
  // Templates are persisted with JSON.stringify, so `createdAt` comes back from
  // JSONB as an ISO string even though ApprovalTemplate types it as a Date.
  // Returning it unrevived made TemplateRegistry.update() thread the string into
  // the next saveTemplate(), which crashed on `createdAt.toISOString()` — so
  // engine.updateTemplate() failed 100% of the time against real Postgres while
  // passing against MemoryAdapter.
  it('getTemplate returns createdAt as a real Date, not the raw JSONB string', async () => {
    const { pool, adapter } = freshAdapter();
    const stored = {
      ...makeTemplate(),
      createdAt: '2026-06-26T09:00:00.000Z' as unknown as Date,
    };
    pool.queueResult({ rows: [{ data: stored }] });

    const template = await adapter.getTemplate('tenant-1', 'tpl');

    expect(template).not.toBeNull();
    expect(template?.createdAt).toBeInstanceOf(Date);
    expect(template?.createdAt.toISOString()).toBe('2026-06-26T09:00:00.000Z');
  });

  it('listTemplates revives createdAt on every row', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({
      rows: [
        { data: { ...makeTemplate(), createdAt: '2026-06-26T09:00:00.000Z' as unknown as Date } },
        {
          data: {
            ...makeTemplate({ name: 'other' }),
            createdAt: '2026-06-27T10:00:00.000Z' as unknown as Date,
          },
        },
      ],
    });

    const templates = await adapter.listTemplates('tenant-1');

    expect(templates).toHaveLength(2);
    for (const template of templates) {
      expect(template.createdAt).toBeInstanceOf(Date);
    }
  });

  it('a template round-tripped through getTemplate can be saved again', async () => {
    const { pool, adapter } = freshAdapter();
    pool.queueResult({
      rows: [
        { data: { ...makeTemplate(), createdAt: '2026-06-26T09:00:00.000Z' as unknown as Date } },
      ],
    });

    const template = await adapter.getTemplate('tenant-1', 'tpl');
    // This is the exact call shape TemplateRegistry.update() performs.
    await expect(
      adapter.saveTemplate({ ...template!, id: 'tpl-2', version: 2 }),
    ).resolves.toBeUndefined();
  });

  it('getTemplate still returns null when no row matches', async () => {
    const { adapter } = freshAdapter();
    await expect(adapter.getTemplate('tenant-1', 'missing')).resolves.toBeNull();
  });
});
