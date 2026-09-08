import { describe, it, expect } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { OutOfOfficeProvider } from '../../src/engine/LevelResolver.js';

/**
 * On a weighted level the weight belongs to the seat, not the person. Replacing
 * an approver used to drop their weight to the default of 1, so a CFO carrying
 * weight 3 who was reassigned, delegated or covered while away left the level
 * unable to reach its threshold — and the next decision threw, leaving an
 * approval nobody could complete.
 */
describe('weighted levels keep the seat weight through a substitution', () => {
  const template = {
    name: 'W',
    documentType: 'w',
    levels: [
      {
        level: 1,
        name: 'Exec',
        mode: 'weighted' as const,
        threshold: 3,
        weights: { cfo: 3, mgr: 1 },
        approvers: [
          { type: 'user' as const, userId: 'cfo' },
          { type: 'user' as const, userId: 'mgr' },
        ],
      },
    ],
  };

  const build = async (ooo?: OutOfOfficeProvider) => {
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      ...(ooo ? { outOfOfficeProvider: ooo } : {}),
    });
    await engine.defineTemplate(template);
    const instance = await engine.submit({
      templateName: 'W',
      documentId: `w-${Math.random()}`,
      documentType: 'w',
      submittedBy: 'buyer',
      data: {},
    });
    return { engine, instance };
  };

  it('a reassigned approver carries the weight', async () => {
    const { engine, instance } = await build();
    await engine.reassign(instance.id, {
      reassignedBy: 'admin',
      fromApprover: 'cfo',
      toApprover: 'deputy',
      reason: 'left the company',
    });

    const done = await engine.approve(instance.id, { approverId: 'deputy' });
    expect(done.status).toBe('approved');
  });

  it('a delegate carries the weight', async () => {
    const { engine, instance } = await build();
    await engine.delegate(instance.id, {
      fromApprover: 'cfo',
      toApprover: 'deputy',
      reason: 'on holiday',
    });

    const done = await engine.approve(instance.id, { approverId: 'deputy' });
    expect(done.status).toBe('approved');
  });

  it('out-of-office cover carries the weight', async () => {
    const { engine, instance } = await build({
      getDelegateFor: (userId) => (userId === 'cfo' ? 'cfo-cover' : null),
    });
    expect(instance.levels[0]?.approverIds).toContain('cfo-cover');

    const done = await engine.approve(instance.id, { approverId: 'cfo-cover' });
    expect(done.status).toBe('approved');
  });

  it('a light approver alone still does not clear the threshold', async () => {
    const { engine, instance } = await build();
    const after = await engine.approve(instance.id, { approverId: 'mgr' });
    expect(after.status).toBe('pending');
  });

  it('delegating an approver with no explicit weight entry does not add one', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'W2',
      documentType: 'w',
      levels: [
        {
          level: 1,
          name: 'Exec',
          mode: 'weighted' as const,
          threshold: 3,
          weights: { cfo: 3 }, // mgr has no explicit entry, so falls back to the default weight
          approvers: [
            { type: 'user' as const, userId: 'cfo' },
            { type: 'user' as const, userId: 'mgr' },
          ],
        },
      ],
    });
    const instance = await engine.submit({
      templateName: 'W2',
      documentId: `w2-${Math.random()}`,
      documentType: 'w',
      submittedBy: 'buyer',
      data: {},
    });

    await engine.delegate(instance.id, {
      fromApprover: 'mgr',
      toApprover: 'temp-mgr',
      reason: 'on holiday',
    });

    const delegated = await engine.getInstance(instance.id);
    expect(delegated.levels[0]?.weights).toEqual({ cfo: 3 });

    const after = await engine.approve(instance.id, { approverId: 'temp-mgr' });
    expect(after.status).toBe('pending'); // default weight 1, still below threshold 3
  });

  it('does not invent a weight for someone who never had one', async () => {
    const { engine, instance } = await build();
    // Escalation adds an approver rather than replacing one; they get the
    // default weight, which must not clear a threshold on its own.
    await engine.reassign(instance.id, {
      reassignedBy: 'admin',
      fromApprover: 'mgr',
      toApprover: 'junior',
      reason: 'swap',
    });
    const after = await engine.approve(instance.id, { approverId: 'junior' });
    expect(after.status).toBe('pending');
  });

  it('keeps counting a vote already cast by the original approver', async () => {
    const { engine, instance } = await build();
    await engine.approve(instance.id, { approverId: 'mgr' }); // weight 1 so far
    await engine.reassign(instance.id, {
      reassignedBy: 'admin',
      fromApprover: 'cfo',
      toApprover: 'deputy',
      reason: 'left',
    });
    const done = await engine.approve(instance.id, { approverId: 'deputy' });
    expect(done.status).toBe('approved');
  });

  it('transferring a queue does not brick a weighted approval', async () => {
    const { engine, instance } = await build();
    const result = await engine.transferApprovals({
      fromApprover: 'cfo',
      toApprover: 'deputy',
      transferredBy: 'admin',
      reason: 'left the company',
    });
    expect(result.transferred).toHaveLength(1);

    const done = await engine.approve(instance.id, { approverId: 'deputy' });
    expect(done.status).toBe('approved');
  });
});
