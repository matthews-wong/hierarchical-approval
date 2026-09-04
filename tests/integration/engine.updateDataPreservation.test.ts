import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';

/**
 * updateData() rebuilds the not-yet-reached part of the chain. Every field the
 * template configured on those levels has to survive that rebuild: a level that
 * silently loses its parallel group runs sequentially, and one that loses its
 * sub-workflow binding tries to resolve approvers it does not have.
 */
describe('updateData preserves level configuration', () => {
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
  });

  const submitPO = (data: Record<string, unknown>) =>
    engine.submit({
      templateName: 'PO',
      documentId: `po-${Math.random()}`,
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data,
    });

  it('keeps the parallel group on a future level', async () => {
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
        {
          level: 2,
          name: 'Finance',
          group: 'review',
          approvers: [{ type: 'user', userId: 'fin' }],
          mode: 'any',
        },
        {
          level: 3,
          name: 'Legal',
          group: 'review',
          approvers: [{ type: 'user', userId: 'legal' }],
          mode: 'any',
        },
      ],
    });

    const i = await submitPO({ amount: 1 });
    await engine.updateData(i.id, { updatedBy: 'buyer', data: { amount: 2 } });

    const after = await engine.getInstance(i.id);
    expect(after.levels.find((l) => l.level === 2)?.group).toBe('review');
    expect(after.levels.find((l) => l.level === 3)?.group).toBe('review');

    // The group must still open both branches together.
    await engine.approve(i.id, { approverId: 'mgr' });
    const open = (await engine.getInstance(i.id)).levels.filter((l) => l.status === 'pending');
    expect(open.map((l) => l.name).sort()).toEqual(['Finance', 'Legal']);
  });

  it('keeps the sub-workflow binding on a future level', async () => {
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
        {
          level: 2,
          name: 'Board approval',
          mode: 'any',
          approvers: [],
          subWorkflow: { templateName: 'CHILD' },
        },
      ],
    });

    const i = await submitPO({ amount: 1 });
    await engine.updateData(i.id, { updatedBy: 'buyer', data: { amount: 2 } });

    const after = await engine.getInstance(i.id);
    expect(after.levels.find((l) => l.level === 2)?.subWorkflowTemplate).toBe('CHILD');

    // Reaching it must spawn a child, not throw for want of approvers.
    await engine.approve(i.id, { approverId: 'mgr' });
    const reached = await engine.getInstance(i.id);
    expect(reached.levels.find((l) => l.level === 2)?.childInstanceId).toBeDefined();
  });

  it('keeps hour-based escalation on a future level', async () => {
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
        {
          level: 2,
          name: 'Finance',
          approvers: [{ type: 'user', userId: 'fin' }],
          mode: 'any',
          escalationAfterHours: 4,
        },
      ],
    });

    const i = await submitPO({ amount: 1 });
    await engine.updateData(i.id, { updatedBy: 'buyer', data: { amount: 2 } });

    const after = await engine.getInstance(i.id);
    expect(after.levels.find((l) => l.level === 2)?.escalationAfterHours).toBe(4);
  });

  it('keeps reminder configuration on a future level', async () => {
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
        {
          level: 2,
          name: 'Finance',
          approvers: [{ type: 'user', userId: 'fin' }],
          mode: 'any',
          reminderAfterDays: 2,
          reminderEveryDays: 1,
          maxReminders: 5,
        },
      ],
    });

    const i = await submitPO({ amount: 1 });
    await engine.updateData(i.id, { updatedBy: 'buyer', data: { amount: 2 } });

    const lvl = (await engine.getInstance(i.id)).levels.find((l) => l.level === 2);
    expect(lvl?.reminderAfterDays).toBe(2);
    expect(lvl?.reminderEveryDays).toBe(1);
    expect(lvl?.maxReminders).toBe(5);
  });
});

describe('a level added by a condition is built like any other', () => {
  // Regression guard: recomputeFutureChain hand-built its level objects and was
  // missing group, subWorkflowTemplate, escalationAfterHours and the reminder
  // fields. A condition-added parallel group therefore ran sequentially, and a
  // condition-added sub-workflow level lost its binding and then failed to
  // resolve approvers it never had.
  const buildEngine = async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'CHILD',
      documentType: 'child',
      levels: [
        { level: 1, name: 'Board', approvers: [{ type: 'user', userId: 'chair' }], mode: 'any' },
      ],
    });
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
      ],
      conditions: [
        {
          when: { field: 'amount', operator: '>', value: 100 },
          addLevels: [
            {
              level: 2,
              name: 'Finance',
              group: 'review',
              approvers: [{ type: 'user', userId: 'fin' }],
              mode: 'any',
              escalationAfterHours: 4,
              reminderAfterDays: 2,
              reminderEveryDays: 1,
              maxReminders: 5,
            },
            {
              level: 3,
              name: 'Legal',
              group: 'review',
              approvers: [{ type: 'user', userId: 'legal' }],
              mode: 'any',
            },
            {
              level: 4,
              name: 'Board approval',
              mode: 'any',
              approvers: [],
              subWorkflow: { templateName: 'CHILD' },
            },
          ],
        },
      ],
    });
    return engine;
  };

  const escalate = async (engine: ApprovalEngine) => {
    const i = await engine.submit({
      templateName: 'PO',
      documentId: `po-${Math.random()}`,
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: { amount: 1 },
    });
    expect(i.levels).toHaveLength(1);
    return engine.updateData(i.id, { updatedBy: 'buyer', data: { amount: 500 } });
  };

  it('carries every configured field onto the added levels', async () => {
    const engine = await buildEngine();
    const after = await escalate(engine);

    const fin = after.levels.find((l) => l.level === 2);
    expect(fin?.group).toBe('review');
    expect(fin?.escalationAfterHours).toBe(4);
    expect(fin?.reminderAfterDays).toBe(2);
    expect(fin?.reminderEveryDays).toBe(1);
    expect(fin?.maxReminders).toBe(5);
    expect(after.levels.find((l) => l.level === 3)?.group).toBe('review');
    expect(after.levels.find((l) => l.level === 4)?.subWorkflowTemplate).toBe('CHILD');
  });

  it('runs the added parallel group concurrently, not one at a time', async () => {
    const engine = await buildEngine();
    const after = await escalate(engine);
    await engine.approve(after.id, { approverId: 'mgr' });

    const open = (await engine.getInstance(after.id)).levels.filter((l) => l.status === 'pending');
    expect(open.map((l) => l.name).sort()).toEqual(['Finance', 'Legal']);
  });

  it('spawns the added sub-workflow instead of failing for want of approvers', async () => {
    const engine = await buildEngine();
    const after = await escalate(engine);

    await engine.approve(after.id, { approverId: 'mgr' });
    await engine.approve(after.id, { approverId: 'fin' });
    await engine.approve(after.id, { approverId: 'legal' });

    const reached = await engine.getInstance(after.id);
    const subLevel = reached.levels.find((l) => l.level === 4);
    expect(subLevel?.status).toBe('pending');
    expect(subLevel?.childInstanceId).toBeDefined();
  });
});
