import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';

/**
 * resubmit() rebuilds the chain from scratch. It was a third hand-written copy
 * of level construction — after submit() and recomputeFutureChain() — and the
 * only one that decided what to open by ARRAY INDEX rather than by group.
 */
describe('resubmit rebuilds a complete chain', () => {
  let engine: ApprovalEngine;

  beforeEach(async () => {
    engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'CHILD',
      documentType: 'child',
      levels: [
        { level: 1, name: 'Board', approvers: [{ type: 'user', userId: 'chair' }], mode: 'any' },
      ],
    });
    await engine.defineTemplate({
      name: 'PAR',
      documentType: 'contract',
      levels: [
        {
          level: 1,
          name: 'Finance',
          group: 'rev',
          approvers: [{ type: 'user', userId: 'fin' }],
          mode: 'any',
          escalationAfterHours: 4,
          reminderAfterDays: 2,
          maxReminders: 5,
        },
        {
          level: 2,
          name: 'Legal',
          group: 'rev',
          approvers: [{ type: 'user', userId: 'legal' }],
          mode: 'any',
        },
        {
          level: 3,
          name: 'Board approval',
          mode: 'any',
          approvers: [],
          subWorkflow: { templateName: 'CHILD' },
        },
      ],
    });
  });

  const rejectedThenResubmit = async () => {
    const i = await engine.submit({
      templateName: 'PAR',
      documentId: `c-${Math.random()}`,
      documentType: 'contract',
      submittedBy: 'buyer',
      data: {},
    });
    await engine.reject(i.id, { approverId: 'fin', reason: 'rework' });
    return engine.resubmit(i.id, { resubmittedBy: 'buyer' });
  };

  it('opens the whole leading parallel group, not just its first level', async () => {
    const re = await rejectedThenResubmit();
    expect(
      re.levels
        .filter((l) => l.status === 'pending')
        .map((l) => l.name)
        .sort(),
    ).toEqual(['Finance', 'Legal']);
  });

  it('carries the group, deadline and reminder configuration across', async () => {
    const re = await rejectedThenResubmit();
    const fin = re.levels.find((l) => l.name === 'Finance');
    expect(fin?.group).toBe('rev');
    expect(fin?.escalationAfterHours).toBe(4);
    expect(fin?.reminderAfterDays).toBe(2);
    expect(fin?.maxReminders).toBe(5);
    expect(re.levels.find((l) => l.name === 'Legal')?.group).toBe('rev');
  });

  it('keeps the sub-workflow binding, so the chain can still finish', async () => {
    const re = await rejectedThenResubmit();
    expect(re.levels.find((l) => l.level === 3)?.subWorkflowTemplate).toBe('CHILD');

    await engine.approve(re.id, { approverId: 'fin' });
    await engine.approve(re.id, { approverId: 'legal' });

    // Previously this threw "No approvers resolved for this level" and the
    // resubmitted approval could never advance.
    const reached = await engine.getInstance(re.id);
    expect(reached.levels.find((l) => l.level === 3)?.childInstanceId).toBeDefined();
  });

  it('runs the resubmitted approval through to completion', async () => {
    const re = await rejectedThenResubmit();
    await engine.approve(re.id, { approverId: 'fin' });
    await engine.approve(re.id, { approverId: 'legal' });

    const childId = (await engine.getInstance(re.id)).levels.find((l) => l.level === 3)
      ?.childInstanceId as string;
    await engine.approve(childId, { approverId: 'chair' });

    const done = await engine.getInstance(re.id);
    expect(done.status).toBe('approved');
  });

  it('records openedAt on the levels it opens', async () => {
    const re = await rejectedThenResubmit();
    expect(re.levels.find((l) => l.name === 'Finance')?.openedAt).toBeInstanceOf(Date);
    expect(re.levels.find((l) => l.level === 3)?.openedAt).toBeUndefined();
  });

  it('still resubmits a plain sequential template', async () => {
    await engine.defineTemplate({
      name: 'SEQ',
      documentType: 'seq',
      levels: [
        { level: 1, name: 'One', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' },
        { level: 2, name: 'Two', approvers: [{ type: 'user', userId: 'b' }], mode: 'any' },
      ],
    });
    const i = await engine.submit({
      templateName: 'SEQ',
      documentId: 's-1',
      documentType: 'seq',
      submittedBy: 'buyer',
      data: {},
    });
    await engine.reject(i.id, { approverId: 'a', reason: 'no' });
    const re = await engine.resubmit(i.id, { resubmittedBy: 'buyer' });

    expect(re.levels.map((l) => l.status)).toEqual(['pending', 'waiting']);
    expect(re.levels[0]?.approverIds).toEqual(['a']);
    expect(re.parentInstanceId).toBe(i.id);
  });

  it('carries an hour-based SLA deadline onto the resubmitted instance', async () => {
    await engine.defineTemplate({
      name: 'SLAHOURS',
      documentType: 'memo',
      slaDeadlineHours: 4,
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
      ],
    });
    const i = await engine.submit({
      templateName: 'SLAHOURS',
      documentId: `slah-${Math.random()}`,
      documentType: 'memo',
      submittedBy: 'buyer',
      data: {},
    });
    await engine.reject(i.id, { approverId: 'mgr', reason: 'no' });
    const re = await engine.resubmit(i.id, { resubmittedBy: 'buyer' });

    expect(re.slaDeadlineAt).toBeInstanceOf(Date);
    expect(re.slaDeadlineAt!.getTime()).toBeGreaterThan(re.createdAt.getTime());
  });

  it('carries a day-based SLA deadline onto the resubmitted instance', async () => {
    await engine.defineTemplate({
      name: 'SLADAYS',
      documentType: 'memo',
      slaDeadlineDays: 2,
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
      ],
    });
    const i = await engine.submit({
      templateName: 'SLADAYS',
      documentId: `slad-${Math.random()}`,
      documentType: 'memo',
      submittedBy: 'buyer',
      data: {},
    });
    await engine.reject(i.id, { approverId: 'mgr', reason: 'no' });
    const re = await engine.resubmit(i.id, { resubmittedBy: 'buyer' });

    expect(re.slaDeadlineAt).toBeInstanceOf(Date);
    expect(re.slaDeadlineAt!.getTime()).toBeGreaterThan(re.createdAt.getTime());
  });

  it('refuses a resubmit whose updated data skips every level', async () => {
    await engine.defineTemplate({
      name: 'SKIPALL',
      documentType: 'memo',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
      ],
      conditions: [{ when: { field: 'skipAll', operator: '==', value: true }, skipLevels: [1] }],
    });
    const i = await engine.submit({
      templateName: 'SKIPALL',
      documentId: `sk-${Math.random()}`,
      documentType: 'memo',
      submittedBy: 'buyer',
      data: { skipAll: false },
    });
    await engine.reject(i.id, { approverId: 'mgr', reason: 'rework' });

    await expect(
      engine.resubmit(i.id, { resubmittedBy: 'buyer', updatedData: { skipAll: true } }),
    ).rejects.toThrow(/no active levels/);
  });

  it('refuses a resubmit whose updated data introduces a duplicate level number', async () => {
    // Neither addLevels[level:2] conflicts with the static level (1) or its own
    // rule's skipLevels, so defineTemplate accepts this — the collision between
    // the two conditions' added levels only surfaces once both rules match.
    await engine.defineTemplate({
      name: 'DUPNUM',
      documentType: 'memo',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
      ],
      conditions: [
        {
          when: { field: 'addA', operator: '==', value: true },
          addLevels: [
            { level: 2, name: 'ExtraA', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' },
          ],
        },
        {
          when: { field: 'addB', operator: '==', value: true },
          addLevels: [
            { level: 2, name: 'ExtraB', approvers: [{ type: 'user', userId: 'b' }], mode: 'any' },
          ],
        },
      ],
    });
    const i = await engine.submit({
      templateName: 'DUPNUM',
      documentId: `dn-${Math.random()}`,
      documentType: 'memo',
      submittedBy: 'buyer',
      data: { addA: false, addB: false },
    });
    await engine.reject(i.id, { approverId: 'mgr', reason: 'rework' });

    await expect(
      engine.resubmit(i.id, { resubmittedBy: 'buyer', updatedData: { addA: true, addB: true } }),
    ).rejects.toThrow(/Duplicate level numbers/);
  });

  it('leaves approverIds empty for a sub-workflow level that opens immediately on resubmit', async () => {
    // Regression guard for the same bug this file's header describes: a
    // sub-workflow level has no approvers of its own, so resubmit()'s rebuild
    // loop must special-case it too, not just when the level opens later.
    await engine.defineTemplate({
      name: 'CHILDFIRST',
      documentType: 'memo',
      levels: [
        { level: 1, name: 'Board approval', mode: 'any', approvers: [], subWorkflow: { templateName: 'CHILD' } },
      ],
    });
    const i = await engine.submit({
      templateName: 'CHILDFIRST',
      documentId: `cf-${Math.random()}`,
      documentType: 'memo',
      submittedBy: 'buyer',
      data: {},
    });
    const childId = (await engine.getInstance(i.id)).levels[0]?.childInstanceId as string;
    await engine.reject(childId, { approverId: 'chair', reason: 'rework' });
    expect((await engine.getInstance(i.id)).status).toBe('rejected');

    const re = await engine.resubmit(i.id, { resubmittedBy: 'buyer' });
    expect(re.levels[0]?.status).toBe('pending');
    expect(re.levels[0]?.approverIds).toEqual([]);
  });
});
