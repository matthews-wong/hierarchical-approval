import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { PostgresAdapter } from '../../src/adapters/PostgresAdapter.js';
import { FakePool } from '../unit/adapters/_fakePg.js';
import type { Clock } from '../../src/utils/Clock.js';

class TestClock implements Clock {
  constructor(private current = new Date('2026-01-01T00:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
}

describe('purgeInstances', () => {
  let clock: TestClock;
  let adapter: MemoryAdapter;
  let engine: ApprovalEngine;

  beforeEach(async () => {
    clock = new TestClock();
    adapter = new MemoryAdapter();
    engine = new ApprovalEngine({ adapter, clock });
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
      ],
    });
  });

  const submit = (id: string, documentType = 'purchase_order') =>
    engine.submit({
      templateName: 'PO',
      documentId: id,
      documentType,
      submittedBy: 'buyer',
      data: {},
    });

  const cutoff = () => new Date('2026-02-01T00:00:00Z');

  it('removes an old approved instance', async () => {
    const i = await submit('po-1');
    await engine.approve(i.id, { approverId: 'mgr' });

    clock.advanceDays(60);
    const result = await engine.purgeInstances({ olderThan: cutoff() });

    expect(result.purged.map((p) => p.instanceId)).toEqual([i.id]);
    await expect(engine.getInstance(i.id)).rejects.toThrow();
  });

  it('leaves a pending instance alone', async () => {
    const i = await submit('po-1');
    clock.advanceDays(60);

    const result = await engine.purgeInstances({ olderThan: cutoff() });
    expect(result.purged).toEqual([]);
    expect((await engine.getInstance(i.id)).status).toBe('pending');
  });

  it('leaves an instance newer than the cut-off alone', async () => {
    const i = await submit('po-1');
    await engine.approve(i.id, { approverId: 'mgr' });

    const result = await engine.purgeInstances({ olderThan: new Date('2025-01-01T00:00:00Z') });
    expect(result.purged).toEqual([]);
    expect((await engine.getInstance(i.id)).status).toBe('approved');
  });

  it('refuses to purge a non-terminal status', async () => {
    await expect(
      engine.purgeInstances({ olderThan: cutoff(), statuses: ['pending'] }),
    ).rejects.toThrow(/refuses non-terminal statuses \(pending\)/);
  });

  it('scopes to the requested terminal statuses', async () => {
    const approved = await submit('po-1');
    await engine.approve(approved.id, { approverId: 'mgr' });
    const cancelled = await submit('po-2');
    await engine.cancel(cancelled.id, { cancelledBy: 'buyer', reason: 'x' });

    clock.advanceDays(60);
    const result = await engine.purgeInstances({ olderThan: cutoff(), statuses: ['cancelled'] });

    expect(result.purged.map((p) => p.instanceId)).toEqual([cancelled.id]);
    expect((await engine.getInstance(approved.id)).status).toBe('approved');
  });

  it('scopes by document type', async () => {
    await engine.defineTemplate({
      name: 'INV',
      documentType: 'invoice',
      levels: [{ level: 1, name: 'AP', approvers: [{ type: 'user', userId: 'ap' }], mode: 'any' }],
    });
    const po = await submit('po-1');
    await engine.approve(po.id, { approverId: 'mgr' });
    const inv = await engine.submit({
      templateName: 'INV',
      documentId: 'inv-1',
      documentType: 'invoice',
      submittedBy: 'buyer',
      data: {},
    });
    await engine.approve(inv.id, { approverId: 'ap' });

    clock.advanceDays(60);
    const result = await engine.purgeInstances({ olderThan: cutoff(), documentType: 'invoice' });
    expect(result.purged.map((p) => p.documentId)).toEqual(['inv-1']);
  });

  it('dryRun reports without deleting', async () => {
    const i = await submit('po-1');
    await engine.approve(i.id, { approverId: 'mgr' });
    clock.advanceDays(60);

    const result = await engine.purgeInstances({ olderThan: cutoff(), dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.purged).toHaveLength(1);
    expect((await engine.getInstance(i.id)).status).toBe('approved');
  });

  it('honours the safety limit', async () => {
    for (const id of ['a', 'b', 'c']) {
      const i = await submit(id);
      await engine.approve(i.id, { approverId: 'mgr' });
    }
    clock.advanceDays(60);

    const result = await engine.purgeInstances({ olderThan: cutoff(), limit: 2 });
    expect(result.purged).toHaveLength(2);
  });

  it('rejects an invalid cut-off', async () => {
    await expect(engine.purgeInstances({ olderThan: new Date('nonsense') })).rejects.toThrow(
      /valid olderThan date/,
    );
  });

  it('refuses when the adapter cannot delete', async () => {
    // deleteInstance lives on the prototype, so shadow it rather than delete it.
    const noDelete = Object.assign(new MemoryAdapter(), { deleteInstance: undefined });
    const limited = new ApprovalEngine({ adapter: noDelete as unknown as MemoryAdapter, clock });
    await expect(limited.purgeInstances({ olderThan: cutoff() })).rejects.toThrow(
      /does not implement deleteInstance/,
    );
  });

  it('still reports under dryRun when the adapter cannot delete', async () => {
    const noDelete = Object.assign(new MemoryAdapter(), { deleteInstance: undefined });
    const limited = new ApprovalEngine({ adapter: noDelete as unknown as MemoryAdapter, clock });
    await expect(
      limited.purgeInstances({ olderThan: cutoff(), dryRun: true }),
    ).resolves.toMatchObject({ purged: [], dryRun: true });
  });

  describe('PostgresAdapter.deleteInstance', () => {
    it('removes audit rows before the instance row', async () => {
      const pool = new FakePool();
      const pg = new PostgresAdapter({ pool: pool.asPool() });
      pool.queueResult({ rows: [], rowCount: 1 });
      pool.queueResult({ rows: [{ id: 'inst-1' }], rowCount: 1 });

      const removed = await pg.deleteInstance('t1', 'inst-1');
      expect(removed).toBe(true);

      const [first, second] = pool.queries;
      // Orphaned audit rows beat audit rows outliving nothing.
      expect(first?.sql).toContain('_audit_log');
      expect(second?.sql).toContain('_instances');
      expect(first?.params).toEqual(['t1', 'inst-1']);
    });

    it('reports false when nothing matched', async () => {
      const pool = new FakePool();
      const pg = new PostgresAdapter({ pool: pool.asPool() });
      pool.queueResult({ rows: [], rowCount: 0 });
      pool.queueResult({ rows: [], rowCount: 0 });
      expect(await pg.deleteInstance('t1', 'missing')).toBe(false);
    });
  });
});
