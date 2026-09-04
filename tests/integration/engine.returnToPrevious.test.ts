import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';

/**
 * Returning the chain to a previous level has to reset what came after it.
 * Leaving a rejected branch and its still-open sibling in place stranded both:
 * neither was `waiting`, so the engine saw nothing left to do and completed the
 * instance as approved — with one branch rejected and another never decided.
 */
describe('reject with returnTo: previous', () => {
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

  const start = async () => {
    const i = await engine.submit({
      templateName: 'PAR',
      documentId: `c-${Math.random()}`,
      documentType: 'contract',
      submittedBy: 'buyer',
      data: {},
    });
    await engine.approve(i.id, { approverId: 'mgr' });
    return i;
  };

  it('resets the whole group it returned through', async () => {
    const i = await start();
    const returned = await engine.reject(i.id, {
      approverId: 'legal',
      reason: 'needs rework',
      returnTo: 'previous',
    });

    expect(returned.status).toBe('pending');
    expect(returned.currentLevel).toBe(1);
    expect(returned.levels.map((l) => `${l.name}:${l.status}`)).toEqual([
      'Manager:pending',
      'Finance:waiting',
      'Legal:waiting',
    ]);
  });

  it('does not complete the approval with a branch undecided', async () => {
    const i = await start();
    await engine.reject(i.id, { approverId: 'legal', reason: 'rework', returnTo: 'previous' });

    // Re-approving level 1 must reopen the group, not finish the instance.
    const after = await engine.approve(i.id, { approverId: 'mgr' });
    expect(after.status).toBe('pending');
    expect(
      after.levels
        .filter((l) => l.status === 'pending')
        .map((l) => l.name)
        .sort(),
    ).toEqual(['Finance', 'Legal']);
  });

  it('completes only once every branch has actually approved', async () => {
    const i = await start();
    await engine.reject(i.id, { approverId: 'legal', reason: 'rework', returnTo: 'previous' });
    await engine.approve(i.id, { approverId: 'mgr' });

    await engine.approve(i.id, { approverId: 'fin' });
    expect((await engine.getInstance(i.id)).status).toBe('pending');

    const done = await engine.approve(i.id, { approverId: 'legal' });
    expect(done.status).toBe('approved');
    expect(done.levels.every((l) => l.status === 'approved')).toBe(true);
  });

  it('clears decisions recorded before the return', async () => {
    const i = await start();
    await engine.approve(i.id, { approverId: 'fin' }); // one branch approved
    await engine.reject(i.id, { approverId: 'legal', reason: 'rework', returnTo: 'previous' });

    const returned = await engine.getInstance(i.id);
    // Finance has to decide again — its approval was for a version that was sent back.
    expect(returned.levels.find((l) => l.name === 'Finance')?.approvedBy).toEqual([]);
    expect(returned.levels.find((l) => l.name === 'Finance')?.status).toBe('waiting');
  });

  it('still works on a sequential template', async () => {
    const seq = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await seq.defineTemplate({
      name: 'SEQ',
      documentType: 'seq',
      levels: [
        { level: 1, name: 'One', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' },
        { level: 2, name: 'Two', approvers: [{ type: 'user', userId: 'b' }], mode: 'any' },
      ],
    });
    const i = await seq.submit({
      templateName: 'SEQ',
      documentId: 's-1',
      documentType: 'seq',
      submittedBy: 'buyer',
      data: {},
    });
    await seq.approve(i.id, { approverId: 'a' });
    const returned = await seq.reject(i.id, {
      approverId: 'b',
      reason: 'rework',
      returnTo: 'previous',
    });
    expect(returned.currentLevel).toBe(1);
    expect(returned.levels.map((l) => l.status)).toEqual(['pending', 'waiting']);

    await seq.approve(i.id, { approverId: 'a' });
    const done = await seq.approve(i.id, { approverId: 'b' });
    expect(done.status).toBe('approved');
  });
});
