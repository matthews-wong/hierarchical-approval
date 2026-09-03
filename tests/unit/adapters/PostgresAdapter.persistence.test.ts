import { describe, it, expect } from 'vitest';
import { PostgresAdapter } from '../../../src/adapters/PostgresAdapter.js';
import { FakePool } from './_fakePg.js';
import type { ApprovalInstance } from '../../../src/types/index.js';

const fresh = () => {
  const pool = new FakePool();
  return { pool, adapter: new PostgresAdapter({ pool: pool.asPool() }) };
};

const makeInstance = (over: Partial<ApprovalInstance> = {}): ApprovalInstance => ({
  id: 'inst-1',
  tenantId: 't1',
  templateId: 'tpl-1',
  templateName: 'PO',
  documentId: 'doc-1',
  documentType: 'purchase_order',
  submittedBy: 'buyer',
  status: 'pending',
  currentLevel: 1,
  version: 1,
  levels: [],
  auditLog: [],
  data: {},
  metadata: {},
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

/**
 * Regression guards for state that engine operations mutate but updateInstance
 * did not write. Listing only a subset of columns silently dropped those
 * writes: on PostgreSQL updateData() left `data` unchanged, requestInfo() lost
 * the hold entirely, and provideInfo()'s deadline shifts never landed — all
 * while MemoryAdapter, which stores whole objects, behaved correctly.
 */
describe('PostgresAdapter persists every mutable field', () => {
  const lastUpdate = (pool: FakePool) =>
    [...pool.queries].reverse().find((q) => q.sql.includes('UPDATE'));

  it('writes data on update, so updateData() survives a round trip', async () => {
    const { pool, adapter } = fresh();
    pool.queueResult({ rows: [{ id: 'inst-1' }], rowCount: 1 });
    await adapter.updateInstance(makeInstance({ data: { amount: 20000 } }), 1);

    const q = lastUpdate(pool);
    expect(q?.sql).toMatch(/data\s+=\s+\$/);
    expect(q?.params).toContain('{"amount":20000}');
  });

  it('writes metadata on update', async () => {
    const { pool, adapter } = fresh();
    pool.queueResult({ rows: [{ id: 'inst-1' }], rowCount: 1 });
    await adapter.updateInstance(makeInstance({ metadata: { source: 'erp' } }), 1);
    expect(lastUpdate(pool)?.params).toContain('{"source":"erp"}');
  });

  it('writes info_request, so a hold survives a round trip', async () => {
    const { pool, adapter } = fresh();
    pool.queueResult({ rows: [{ id: 'inst-1' }], rowCount: 1 });
    await adapter.updateInstance(
      makeInstance({
        infoRequest: {
          askedBy: 'mgr',
          question: 'Which cost centre?',
          askedAt: new Date('2026-01-02T00:00:00Z'),
          level: 1,
        },
      }),
      1,
    );

    const q = lastUpdate(pool);
    expect(q?.sql).toMatch(/info_request\s+=\s+\$/);
    expect(q?.params.some((p) => String(p).includes('Which cost centre?'))).toBe(true);
  });

  it('clears info_request to null when the hold is released', async () => {
    const { pool, adapter } = fresh();
    pool.queueResult({ rows: [{ id: 'inst-1' }], rowCount: 1 });
    await adapter.updateInstance(makeInstance({ infoRequest: undefined }), 1);
    expect(lastUpdate(pool)?.params).toContain(null);
  });

  it('writes the deadline columns, so provideInfo()"s shifts land', async () => {
    const { pool, adapter } = fresh();
    pool.queueResult({ rows: [{ id: 'inst-1' }], rowCount: 1 });
    await adapter.updateInstance(
      makeInstance({
        expiresAt: new Date('2026-03-01T00:00:00Z'),
        slaDeadlineAt: new Date('2026-02-01T00:00:00Z'),
        deadlineAction: 'reject',
      }),
      1,
    );

    const q = lastUpdate(pool);
    expect(q?.sql).toMatch(/expires_at\s+=\s+\$/);
    expect(q?.sql).toMatch(/sla_deadline_at\s+=\s+\$/);
    expect(q?.params).toContain('2026-03-01T00:00:00.000Z');
    expect(q?.params).toContain('2026-02-01T00:00:00.000Z');
    expect(q?.params).toContain('reject');
  });

  it('still guards on version, so optimistic concurrency is intact', async () => {
    const { pool, adapter } = fresh();
    pool.queueResult({ rows: [{ id: 'inst-1' }], rowCount: 1 });
    await adapter.updateInstance(makeInstance(), 7);
    const q = lastUpdate(pool);
    expect(q?.sql).toContain('AND version = $3');
    expect(q?.params[2]).toBe(7);
  });

  it('inserts info_request on create', async () => {
    const { pool, adapter } = fresh();
    await adapter.saveInstance(
      makeInstance({
        infoRequest: { askedBy: 'mgr', question: 'Q?', askedAt: new Date(), level: 1 },
      }),
    );
    const insert = pool.queries.find((q) => q.sql.includes('INSERT INTO'));
    expect(insert?.sql).toContain('info_request');
  });

  it('adds the column for existing deployments in migrate()', async () => {
    const { pool, adapter } = fresh();
    await adapter.migrate();
    const sql = pool.queries.map((q) => q.sql).join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS info_request JSONB');
  });

  it('revives info_request.askedAt as a Date on read', async () => {
    const { pool, adapter } = fresh();
    pool.queueResult({
      rows: [
        {
          id: 'inst-1',
          tenant_id: 't1',
          template_id: 'tpl-1',
          template_name: 'PO',
          document_id: 'doc-1',
          document_type: 'purchase_order',
          submitted_by: 'buyer',
          status: 'pending',
          current_level: 1,
          version: 1,
          data: {},
          metadata: {},
          levels: [],
          info_request: {
            askedBy: 'mgr',
            question: 'Q?',
            askedAt: '2026-01-02T00:00:00.000Z',
            level: 1,
          },
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      rowCount: 1,
    });

    const read = await adapter.getInstance('t1', 'inst-1');
    expect(read?.infoRequest?.askedAt).toBeInstanceOf(Date);
    expect(read?.infoRequest?.askedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(read?.infoRequest?.question).toBe('Q?');
  });
});
