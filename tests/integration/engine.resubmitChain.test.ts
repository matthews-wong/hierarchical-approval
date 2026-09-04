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
});
