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

  it('getInstancesByApprover returns only pending instances on the approver current level', async () => {
    const adapter = new MemoryAdapter();
    await adapter.saveInstance(makeInstance({ id: 'i1', status: 'pending' }));
    await adapter.saveInstance(makeInstance({ id: 'i2', status: 'approved' }));
    await adapter.saveInstance(
      makeInstance({
        id: 'i3',
        status: 'pending',
        currentLevel: 2,
        levels: [makeLevel({ level: 1 }), makeLevel({ level: 2, approverIds: ['carol'] })],
      }),
    );
    const result = await adapter.getInstancesByApprover('t1', 'bob');
    expect(result.items.map((i) => i.id)).toEqual(['i1']);
    expect(result.total).toBe(1);
  });

  it('getIdempotentInstance finds only the matching tenant/key pair', async () => {
    const adapter = new MemoryAdapter();
    await adapter.saveInstance(makeInstance({ id: 'i1', idempotencyKey: 'k1' }));
    await adapter.saveInstance(makeInstance({ id: 'i2', tenantId: 't2', idempotencyKey: 'k1' }));
    await expect(adapter.getIdempotentInstance('t1', 'k1')).resolves.toMatchObject({ id: 'i1' });
    await expect(adapter.getIdempotentInstance('t1', 'k2')).resolves.toBeNull();
  });
});
