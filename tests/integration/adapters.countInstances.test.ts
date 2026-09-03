import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { PostgresAdapter } from '../../src/adapters/PostgresAdapter.js';
import { FakePool } from '../unit/adapters/_fakePg.js';

describe('countInstances', () => {
  describe('MemoryAdapter', () => {
    let adapter: MemoryAdapter;
    let engine: ApprovalEngine;

    beforeEach(async () => {
      adapter = new MemoryAdapter();
      engine = new ApprovalEngine({ adapter });
      await engine.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [
          { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
        ],
      });
    });

    const submit = (id: string, data: Record<string, unknown> = {}) =>
      engine.submit({
        templateName: 'PO',
        documentId: id,
        documentType: 'purchase_order',
        submittedBy: 'buyer',
        data,
      });

    it('counts nothing on an empty store', async () => {
      expect(await adapter.countInstances('default', {})).toBe(0);
    });

    it('counts all instances for a tenant', async () => {
      await submit('a');
      await submit('b');
      expect(await adapter.countInstances('default', {})).toBe(2);
    });

    it('is tenant-scoped', async () => {
      await submit('a');
      expect(await adapter.countInstances('other-tenant', {})).toBe(0);
    });

    it('honours the status filter', async () => {
      const a = await submit('a');
      await submit('b');
      await engine.cancel(a.id, { cancelledBy: 'buyer', reason: 'x' });

      expect(await adapter.countInstances('default', { status: 'pending' })).toBe(1);
      expect(await adapter.countInstances('default', { status: 'cancelled' })).toBe(1);
    });

    it('honours the data filter, matching getInstancesByFilter', async () => {
      await submit('a', { vendor: 'acme' });
      await submit('b', { vendor: 'globex' });

      const filter = { data: { vendor: 'acme' } };
      const counted = await adapter.countInstances('default', filter);
      const fetched = await adapter.getInstancesByFilter('default', filter, { limit: 50 });
      expect(counted).toBe(1);
      expect(counted).toBe(fetched.total);
    });

    it('agrees with getInstancesByFilter.total across filters', async () => {
      await submit('a', { region: 'EU' });
      await submit('b', { region: 'EU' });
      await submit('c', { region: 'US' });

      for (const filter of [
        {},
        { status: 'pending' as const },
        { documentType: 'purchase_order' },
        { data: { region: 'EU' } },
        { submittedBy: 'buyer' },
        { templateName: 'PO' },
      ]) {
        const counted = await adapter.countInstances('default', filter);
        const fetched = await adapter.getInstancesByFilter('default', filter, { limit: 100 });
        expect(counted, JSON.stringify(filter)).toBe(fetched.total);
      }
    });
  });

  describe('PostgresAdapter', () => {
    const fresh = () => {
      const pool = new FakePool();
      return { pool, adapter: new PostgresAdapter({ pool: pool.asPool() }) };
    };

    it('issues a bare COUNT(*) with no row payload', async () => {
      const { pool, adapter } = fresh();
      pool.queueResult({ rows: [{ count: '7' }], rowCount: 1 });

      const n = await adapter.countInstances('t1', { status: 'pending' });
      expect(n).toBe(7);

      const q = pool.queries.at(-1);
      expect(q?.sql).toContain('SELECT COUNT(*)');
      // The point of the new method: no rows, no window function.
      expect(q?.sql).not.toContain('SELECT *');
      expect(q?.sql).not.toContain('COUNT(*) OVER()');
      expect(q?.sql).not.toContain('LIMIT');
    });

    it('applies every filter, parameterised', async () => {
      const { pool, adapter } = fresh();
      pool.queueResult({ rows: [{ count: '0' }], rowCount: 1 });
      await adapter.countInstances('t1', {
        status: 'approved',
        documentType: 'purchase_order',
        submittedBy: 'buyer',
        templateName: 'PO',
        fromDate: new Date('2026-01-01T00:00:00Z'),
        toDate: new Date('2026-02-01T00:00:00Z'),
        data: { 'vendor.id': 'v1' },
      });

      const q = pool.queries.at(-1);
      expect(q?.sql).toContain('tenant_id = $1');
      expect(q?.sql).toContain('status = $2');
      expect(q?.sql).toContain('document_type = $3');
      expect(q?.sql).toContain('submitted_by = $4');
      expect(q?.sql).toContain('template_name = $5');
      expect(q?.sql).toContain('created_at >= $6');
      expect(q?.sql).toContain('created_at <= $7');
      expect(q?.sql).toContain('data #> $8');
      expect(q?.params[0]).toBe('t1');
      expect(q?.params).toContain('{"vendor","id"}');
    });

    it('returns 0 when the driver reports no row', async () => {
      const { pool, adapter } = fresh();
      pool.queueResult({ rows: [], rowCount: 0 });
      expect(await adapter.countInstances('t1', {})).toBe(0);
    });

    it('parses a bigint count returned as a string', async () => {
      const { pool, adapter } = fresh();
      pool.queueResult({ rows: [{ count: '4294967296' }], rowCount: 1 });
      expect(await adapter.countInstances('t1', {})).toBe(4294967296);
    });
  });

  describe('the engine uses it for reporting', () => {
    it('getStatistics no longer fetches rows just to read a count', async () => {
      const adapter = new MemoryAdapter();
      const engine = new ApprovalEngine({ adapter });
      await engine.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [
          { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
        ],
      });
      await engine.submit({
        templateName: 'PO',
        documentId: 'a',
        documentType: 'purchase_order',
        submittedBy: 'buyer',
        data: {},
      });

      // A fetch with limit 1 is the old count-only pattern: ask for a page of
      // rows purely to read `total` off it, and throw the row away.
      const countOnlyFetches: unknown[] = [];
      let countCalls = 0;
      const originalFetch = adapter.getInstancesByFilter.bind(adapter);
      adapter.getInstancesByFilter = async (tenantId, filter, opts) => {
        if (opts?.limit === 1) countOnlyFetches.push(filter);
        return originalFetch(tenantId, filter, opts);
      };
      const originalCount = adapter.countInstances.bind(adapter);
      adapter.countInstances = async (...args) => {
        countCalls++;
        return originalCount(...args);
      };

      const stats = await engine.getStatistics();
      expect(stats.total).toBe(1);
      expect(stats.byStatus.pending).toBe(1);
      // Counts now go through countInstances; rows are fetched only where the
      // computation genuinely needs them (the cycle-time sweep reads timestamps).
      expect(countOnlyFetches).toEqual([]);
      expect(countCalls).toBeGreaterThan(0);
    });
  });
});
