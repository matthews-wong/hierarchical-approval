import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { PostgresAdapter } from '../../src/adapters/PostgresAdapter.js';
import { FakePool } from '../unit/adapters/_fakePg.js';

/**
 * openLevels is the approval frontier. currentLevel names only its lowest
 * entry — enough for a sequential chain, and one branch of a parallel group.
 * Six defects across 3.x came from reading currentLevel as the whole frontier.
 */
describe('openLevels', () => {
  let engine: ApprovalEngine;

  beforeEach(async () => {
    engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'PAR',
      documentType: 'contract',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
        {
          level: 2,
          name: 'Finance',
          group: 'rev',
          approvers: [{ type: 'user', userId: 'fin' }],
          mode: 'any',
        },
        {
          level: 3,
          name: 'Legal',
          group: 'rev',
          approvers: [{ type: 'user', userId: 'legal' }],
          mode: 'any',
        },
      ],
    });
  });

  const submit = () =>
    engine.submit({
      templateName: 'PAR',
      documentId: `c-${Math.random()}`,
      documentType: 'contract',
      submittedBy: 'buyer',
      data: {},
    });

  it('names the single open level on a sequential step', async () => {
    const i = await submit();
    expect(i.openLevels).toEqual([1]);
    expect(i.currentLevel).toBe(1);
  });

  it('names every branch of a parallel group', async () => {
    const i = await submit();
    const after = await engine.approve(i.id, { approverId: 'mgr' });
    expect(after.openLevels).toEqual([2, 3]);
    // currentLevel is the lowest of them, which is why it was never enough.
    expect(after.currentLevel).toBe(2);
  });

  it('shrinks as branches close', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    const after = await engine.approve(i.id, { approverId: 'fin' });
    expect(after.openLevels).toEqual([3]);
    expect(after.currentLevel).toBe(3);
  });

  it('is empty once the instance is terminal', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    await engine.approve(i.id, { approverId: 'fin' });
    const done = await engine.approve(i.id, { approverId: 'legal' });
    expect(done.status).toBe('approved');
    expect(done.openLevels).toEqual([]);
    // currentLevel keeps its last value so the trail still shows where it ended.
    expect(done.currentLevel).toBe(3);
  });

  it('is empty on a cancelled instance', async () => {
    const i = await submit();
    await engine.cancel(i.id, { cancelledBy: 'buyer', reason: 'withdrawn' });
    expect((await engine.getInstance(i.id)).openLevels).toEqual([]);
  });

  it('getOpenLevels() reports the same frontier', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    expect(await engine.getOpenLevels(i.id)).toEqual([2, 3]);
  });

  it('agrees with the levels themselves after every operation', async () => {
    const i = await submit();
    const check = async () => {
      const inst = await engine.getInstance(i.id);
      const fromLevels = inst.levels
        .filter((l) => l.status === 'pending')
        .map((l) => l.level)
        .sort((a, b) => a - b);
      expect(inst.openLevels).toEqual(fromLevels);
    };

    await check();
    await engine.approve(i.id, { approverId: 'mgr' });
    await check();
    await engine.addComment(i.id, { actorId: 'fin', comment: 'noted' });
    await check();
    await engine.reassign(i.id, {
      reassignedBy: 'admin',
      fromApprover: 'legal',
      toApprover: 'legal-2',
      reason: 'swap',
    });
    await check();
    await engine.approve(i.id, { approverId: 'fin' });
    await check();
  });

  it('survives a storage round trip', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    expect((await engine.getInstance(i.id)).openLevels).toEqual([2, 3]);
  });

  describe('PostgresAdapter', () => {
    it('persists and reads back the frontier', async () => {
      const pool = new FakePool();
      const adapter = new PostgresAdapter({ pool: pool.asPool() });

      await adapter.migrate();
      expect(pool.queries.map((q) => q.sql).join('\n')).toContain(
        'ADD COLUMN IF NOT EXISTS open_levels',
      );

      pool.queueResult({ rows: [{ id: 'inst-1' }], rowCount: 1 });
      await adapter.updateInstance(
        {
          id: 'inst-1',
          tenantId: 't1',
          templateId: 'tpl',
          templateName: 'PAR',
          documentId: 'd',
          documentType: 'contract',
          submittedBy: 'buyer',
          status: 'pending',
          currentLevel: 2,
          openLevels: [2, 3],
          version: 1,
          levels: [],
          auditLog: [],
          data: {},
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        1,
      );

      const update = [...pool.queries].reverse().find((q) => q.sql.includes('UPDATE'));
      expect(update?.sql).toMatch(/open_levels\s+=\s+\$/);
      expect(update?.params).toContain('[2,3]');
    });
  });
});
