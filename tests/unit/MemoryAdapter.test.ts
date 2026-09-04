import { describe, it, expect } from 'vitest';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { ApprovalConflictError } from '../../src/errors.js';
import type { ApprovalInstance, ApprovalLevelInstance } from '../../src/types/index.js';

function makeLevel(overrides: Partial<ApprovalLevelInstance> = {}): ApprovalLevelInstance {
  return {
    level: 1,
    name: 'Level 1',
    mode: 'any',
    approverConfigs: [{ type: 'user', userId: 'bob' }],
    approverIds: ['bob'],
    approvedBy: [],
    rejectedBy: [],
    status: 'pending',
    ...overrides,
  };
}

function makeInstance(overrides: Partial<ApprovalInstance> = {}): ApprovalInstance {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: 'inst-1',
    tenantId: 't1',
    templateId: 'tpl-1',
    templateName: 'purchase',
    documentId: 'doc-1',
    documentType: 'po',
    submittedBy: 'alice',
    status: 'pending',
    currentLevel: 1,
    version: 1,
    levels: [makeLevel()],
    auditLog: [],
    data: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('MemoryAdapter', () => {
  it('getInstance returns null for a missing instance', async () => {
    const adapter = new MemoryAdapter();
    await expect(adapter.getInstance('t1', 'nope')).resolves.toBeNull();
  });

  it('updateInstance throws ApprovalConflictError when the instance is missing', async () => {
    const adapter = new MemoryAdapter();
    await expect(adapter.updateInstance(makeInstance(), 1)).rejects.toThrow(ApprovalConflictError);
  });

  it('updateInstance throws ApprovalConflictError on version mismatch', async () => {
    const adapter = new MemoryAdapter();
    await adapter.saveInstance(makeInstance({ version: 3 }));
    await expect(adapter.updateInstance(makeInstance(), 2)).rejects.toThrow(ApprovalConflictError);
  });

  it('updateInstance bumps the version when the expected version matches', async () => {
    const adapter = new MemoryAdapter();
    await adapter.saveInstance(makeInstance());
    await adapter.updateInstance(makeInstance(), 1);
    await expect(adapter.getInstance('t1', 'inst-1')).resolves.toMatchObject({ version: 2 });
  });

  it('getInstancesByFilter matches each filter field', async () => {
    const adapter = new MemoryAdapter();
    await adapter.saveInstance(makeInstance({ id: 'i1', status: 'pending' }));
    await adapter.saveInstance(
      makeInstance({ id: 'i2', status: 'approved', documentType: 'invoice' }),
    );

    const byStatus = await adapter.getInstancesByFilter('t1', { status: 'approved' });
    expect(byStatus.items.map((i) => i.id)).toEqual(['i2']);
    expect(byStatus.total).toBe(1);

    const byType = await adapter.getInstancesByFilter('t1', { documentType: 'invoice' });
    expect(byType.items.map((i) => i.id)).toEqual(['i2']);

    const bySubmitter = await adapter.getInstancesByFilter('t1', { submittedBy: 'alice' });
    expect(bySubmitter.total).toBe(2);

    const byTemplate = await adapter.getInstancesByFilter('t1', { templateName: 'purchase' });
    expect(byTemplate.total).toBe(2);

    const noMatch = await adapter.getInstancesByFilter('t1', { templateName: 'travel' });
    expect(noMatch.items).toHaveLength(0);
  });

  it('getInstancesByFilter respects fromDate/toDate bounds', async () => {
    const adapter = new MemoryAdapter();
    await adapter.saveInstance(
      makeInstance({ id: 'i1', createdAt: new Date('2026-06-01T00:00:00.000Z') }),
    );
    expect(
      (await adapter.getInstancesByFilter('t1', { fromDate: new Date('2026-07-01') })).items,
    ).toHaveLength(0);
    expect(
      (await adapter.getInstancesByFilter('t1', { toDate: new Date('2026-05-01') })).items,
    ).toHaveLength(0);
    expect(
      (
        await adapter.getInstancesByFilter('t1', {
          fromDate: new Date('2026-06-01'),
          toDate: new Date('2026-06-01'),
        })
      ).items,
    ).toHaveLength(1);
  });

  it('getInstancesByFilter paginates with offset/limit', async () => {
    const adapter = new MemoryAdapter();
    for (const id of ['i1', 'i2', 'i3']) {
      await adapter.saveInstance(makeInstance({ id }));
    }
    const page = await adapter.getInstancesByFilter('t1', {}, { offset: 1, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
    expect((await adapter.getInstancesByFilter('t1', {})).items).toHaveLength(3);
  });

  it('getInstancesByApprover returns pending instances on any open level', async () => {
    const adapter = new MemoryAdapter();
    await adapter.saveInstance(makeInstance({ id: 'i1', status: 'pending' }));
    await adapter.saveInstance(makeInstance({ id: 'i2', status: 'approved' }));
    // Bob's level is closed and the open one belongs to carol, so bob is done here.
    await adapter.saveInstance(
      makeInstance({
        id: 'i3',
        status: 'pending',
        currentLevel: 2,
        levels: [
          makeLevel({ level: 1, status: 'approved', approvedBy: ['bob'] }),
          makeLevel({ level: 2, approverIds: ['carol'] }),
        ],
      }),
    );
    const result = await adapter.getInstancesByApprover('t1', 'bob');
    expect(result.items.map((i) => i.id)).toEqual(['i1']);
    expect(result.total).toBe(1);
  });

  it('getInstancesByApprover finds an approver on an upper parallel branch', async () => {
    // currentLevel names one level, so matching against it alone hid every
    // branch of a parallel group above the lowest — an approver assigned there
    // saw an empty inbox. PostgresAdapter already matched any open level.
    const adapter = new MemoryAdapter();
    await adapter.saveInstance(
      makeInstance({
        id: 'par',
        status: 'pending',
        currentLevel: 1,
        levels: [
          makeLevel({ level: 1, group: 'review', approverIds: ['bob'] }),
          makeLevel({ level: 2, group: 'review', approverIds: ['carol'] }),
        ],
      }),
    );

    await expect(adapter.getInstancesByApprover('t1', 'carol')).resolves.toMatchObject({
      total: 1,
    });
    await expect(adapter.getInstancesByApprover('t1', 'bob')).resolves.toMatchObject({ total: 1 });
  });

  it('getIdempotentInstance finds only the matching tenant/key pair', async () => {
    const adapter = new MemoryAdapter();
    await adapter.saveInstance(makeInstance({ id: 'i1', idempotencyKey: 'k1' }));
    await adapter.saveInstance(makeInstance({ id: 'i2', tenantId: 't2', idempotencyKey: 'k1' }));
    await expect(adapter.getIdempotentInstance('t1', 'k1')).resolves.toMatchObject({ id: 'i1' });
    await expect(adapter.getIdempotentInstance('t1', 'k2')).resolves.toBeNull();
  });

  describe('getOverdueInstances', () => {
    const asOf = new Date('2026-06-10T00:00:00.000Z');

    it('includes escalation overdue, expired, SLA-breached, and delegation-expired instances', async () => {
      const adapter = new MemoryAdapter();
      await adapter.saveInstance(
        makeInstance({
          id: 'esc',
          levels: [makeLevel({ escalationDueAt: new Date('2026-06-05T00:00:00.000Z') })],
        }),
      );
      await adapter.saveInstance(
        makeInstance({ id: 'exp', expiresAt: new Date('2026-06-05T00:00:00.000Z') }),
      );
      await adapter.saveInstance(
        makeInstance({ id: 'sla', slaDeadlineAt: new Date('2026-06-05T00:00:00.000Z') }),
      );
      await adapter.saveInstance(
        makeInstance({
          id: 'del',
          levels: [
            makeLevel({
              status: 'pending',
              delegatedUntil: new Date('2026-06-05T00:00:00.000Z'),
              delegatedFrom: 'bob',
              delegatedTo: 'carol',
            }),
          ],
        }),
      );
      const result = await adapter.getOverdueInstances('t1', asOf);
      expect(result.map((i) => i.id).sort()).toEqual(['del', 'esc', 'exp', 'sla']);
    });

    it('excludes non-pending, future-dated, and already-breached instances', async () => {
      const adapter = new MemoryAdapter();
      await adapter.saveInstance(
        makeInstance({ id: 'approved', status: 'approved', expiresAt: new Date('2026-06-05') }),
      );
      await adapter.saveInstance(
        makeInstance({
          id: 'future',
          levels: [makeLevel({ escalationDueAt: new Date('2026-06-15T00:00:00.000Z') })],
        }),
      );
      await adapter.saveInstance(
        makeInstance({
          id: 'breached',
          slaDeadlineAt: new Date('2026-06-05T00:00:00.000Z'),
          slaBreachedAt: new Date('2026-06-06T00:00:00.000Z'),
        }),
      );
      await adapter.saveInstance(
        makeInstance({
          id: 'delegated-away',
          levels: [
            makeLevel({
              status: 'approved',
              delegatedUntil: new Date('2026-06-05T00:00:00.000Z'),
              delegatedFrom: 'bob',
              delegatedTo: 'carol',
            }),
          ],
        }),
      );
      expect(await adapter.getOverdueInstances('t1', asOf)).toHaveLength(0);
    });

    it('matches an escalation due exactly at asOf and applies the extra filter', async () => {
      const adapter = new MemoryAdapter();
      await adapter.saveInstance(
        makeInstance({
          id: 'boundary',
          levels: [makeLevel({ escalationDueAt: asOf })],
        }),
      );
      await adapter.saveInstance(
        makeInstance({
          id: 'other-type',
          documentType: 'invoice',
          expiresAt: new Date('2026-06-05T00:00:00.000Z'),
        }),
      );
      const all = await adapter.getOverdueInstances('t1', asOf);
      expect(all.map((i) => i.id).sort()).toEqual(['boundary', 'other-type']);
      const filtered = await adapter.getOverdueInstances('t1', asOf, { documentType: 'po' });
      expect(filtered.map((i) => i.id)).toEqual(['boundary']);
    });
  });

  describe('getInstancesByCursor', () => {
    async function saveFive(adapter: MemoryAdapter): Promise<void> {
      const dates = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'];
      for (const [i, day] of dates.entries()) {
        await adapter.saveInstance(
          makeInstance({
            id: `i${i + 1}`,
            createdAt: new Date(`${day}T00:00:00.000Z`),
            updatedAt: new Date(`${day}T00:00:00.000Z`),
          }),
        );
      }
    }

    it('walks forward page by page via nextCursor', async () => {
      const adapter = new MemoryAdapter();
      await saveFive(adapter);

      const page1 = await adapter.getInstancesByCursor('t1', {}, { limit: 2 });
      expect(page1.items.map((i) => i.id)).toEqual(['i1', 'i2']);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeTruthy();
      expect(page1.prevCursor).toBeUndefined();

      const page2 = await adapter.getInstancesByCursor(
        't1',
        {},
        {
          limit: 2,
          cursor: page1.nextCursor,
        },
      );
      expect(page2.items.map((i) => i.id)).toEqual(['i3', 'i4']);
      expect(page2.hasMore).toBe(true);

      const page3 = await adapter.getInstancesByCursor(
        't1',
        {},
        {
          limit: 2,
          cursor: page2.nextCursor,
        },
      );
      expect(page3.items.map((i) => i.id)).toEqual(['i5']);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeUndefined();
    });

    it('walks backward from a page boundary via prevCursor', async () => {
      const adapter = new MemoryAdapter();
      await saveFive(adapter);

      // Page starting at i3 has prevCursor pointing at i2.
      const page = await adapter.getInstancesByCursor('t1', {}, { limit: 2, cursor: undefined });
      const second = await adapter.getInstancesByCursor(
        't1',
        {},
        {
          limit: 2,
          cursor: page.nextCursor,
        },
      );
      expect(second.items.map((i) => i.id)).toEqual(['i3', 'i4']);
      expect(second.prevCursor).toBeTruthy();

      const backward = await adapter.getInstancesByCursor(
        't1',
        {},
        {
          limit: 2,
          cursor: second.prevCursor,
          direction: 'backward',
        },
      );
      expect(backward.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    });

    it('sorts by updatedAt then id and applies the filter', async () => {
      const adapter = new MemoryAdapter();
      await adapter.saveInstance(
        makeInstance({
          id: 'b',
          status: 'approved',
          createdAt: new Date('2026-06-03T00:00:00.000Z'),
          updatedAt: new Date('2026-06-03T00:00:00.000Z'),
        }),
      );
      await adapter.saveInstance(
        makeInstance({
          id: 'a',
          createdAt: new Date('2026-06-03T00:00:00.000Z'),
          updatedAt: new Date('2026-06-03T00:00:00.000Z'),
        }),
      );
      await adapter.saveInstance(
        makeInstance({
          id: 'older',
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
          updatedAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
      );
      const all = await adapter.getInstancesByCursor('t1', {}, { limit: 10 });
      expect(all.items.map((i) => i.id)).toEqual(['older', 'a', 'b']);
      const pending = await adapter.getInstancesByCursor(
        't1',
        { status: 'pending' },
        { limit: 10 },
      );
      expect(pending.items.map((i) => i.id)).toEqual(['older', 'a']);
    });

    it('returns an empty page with no cursors when nothing matches', async () => {
      const adapter = new MemoryAdapter();
      const result = await adapter.getInstancesByCursor('t1', {}, { limit: 5 });
      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
      expect(result.prevCursor).toBeUndefined();
    });
  });
});
