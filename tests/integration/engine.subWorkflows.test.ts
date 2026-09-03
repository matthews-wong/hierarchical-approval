import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { SubWorkflowEvent } from '../../src/types/index.js';

const u = (n: number, name: string, userId: string) => ({
  level: n,
  name,
  approvers: [{ type: 'user' as const, userId }],
  mode: 'any' as const,
});

describe('sub-workflows', () => {
  let engine: ApprovalEngine;

  beforeEach(async () => {
    engine = new ApprovalEngine({ adapter: new MemoryAdapter() });

    // The child: a small board approval.
    await engine.defineTemplate({
      name: 'BOARD',
      documentType: 'capital_request',
      levels: [u(1, 'Board', 'chair')],
    });

    // The parent: manager -> board sub-workflow -> CEO.
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        u(1, 'Manager', 'mgr'),
        {
          level: 2,
          name: 'Board approval',
          mode: 'any',
          approvers: [],
          subWorkflow: { templateName: 'BOARD' },
        },
        u(3, 'CEO', 'ceo'),
      ],
    });
  });

  const submit = () =>
    engine.submit({
      templateName: 'PO',
      documentId: 'po-1',
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: { amount: 2_000_000 },
    });

  const childOf = async (parentId: string, level = 2) => {
    const parent = await engine.getInstance(parentId);
    const id = parent.levels.find((l) => l.level === level)?.childInstanceId;
    return id ? engine.getInstance(id) : null;
  };

  it('does not spawn the child until the level is reached', async () => {
    const i = await submit();
    expect(await childOf(i.id)).toBeNull();
  });

  it('spawns a child when the sub-workflow level opens', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });

    const child = await childOf(i.id);
    expect(child).not.toBeNull();
    expect(child?.templateName).toBe('BOARD');
    expect(child?.parentInstanceId).toBe(i.id);
    expect(child?.parentLevel).toBe(2);
    expect(child?.subWorkflowDepth).toBe(1);
    expect(child?.status).toBe('pending');
  });

  it('carries the parent document data into the child', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    expect((await childOf(i.id))?.data['amount']).toBe(2_000_000);
  });

  it('leaves the parent level with no direct approvers', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    const parent = await engine.getInstance(i.id);
    const level = parent.levels.find((l) => l.level === 2);
    expect(level?.status).toBe('pending');
    expect(level?.approverIds).toEqual([]);
  });

  it('holds the parent while the child is undecided', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    const parent = await engine.getInstance(i.id);
    expect(parent.status).toBe('pending');
    expect(parent.levels.find((l) => l.level === 3)?.status).toBe('waiting');
  });

  it('advances the parent when the child is approved', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    const child = await childOf(i.id);
    await engine.approve(child!.id, { approverId: 'chair' });

    const parent = await engine.getInstance(i.id);
    expect(parent.levels.find((l) => l.level === 2)?.status).toBe('approved');
    expect(parent.levels.find((l) => l.level === 3)?.status).toBe('pending');
    expect(parent.status).toBe('pending');
  });

  it('completes the parent chain end to end', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    const child = await childOf(i.id);
    await engine.approve(child!.id, { approverId: 'chair' });
    const done = await engine.approve(i.id, { approverId: 'ceo' });
    expect(done.status).toBe('approved');
  });

  it('rejects the parent when the child is rejected', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    const child = await childOf(i.id);
    await engine.reject(child!.id, { approverId: 'chair', reason: 'over budget' });

    const parent = await engine.getInstance(i.id);
    expect(parent.status).toBe('rejected');
    expect(parent.levels.find((l) => l.level === 2)?.status).toBe('rejected');
  });

  it('rejects the parent when the child is cancelled, rather than carrying on', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    const child = await childOf(i.id);
    await engine.cancel(child!.id, { cancelledBy: 'buyer', reason: 'withdrawn' });

    // A cancelled child means the approval the parent waited for never happened.
    const parent = await engine.getInstance(i.id);
    expect(parent.status).toBe('rejected');
  });

  it('emits started and completed events', async () => {
    const started: SubWorkflowEvent[] = [];
    const completed: SubWorkflowEvent[] = [];
    engine.on('approval:subworkflow_started', (e) => started.push(e));
    engine.on('approval:subworkflow_completed', (e) => completed.push(e));

    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    const child = await childOf(i.id);
    await engine.approve(child!.id, { approverId: 'chair' });

    expect(started[0]).toMatchObject({ level: 2, childTemplateName: 'BOARD' });
    expect(completed[0]).toMatchObject({ level: 2, outcome: 'approved' });
  });

  it('records the hand-off in the parent audit trail', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });
    const child = await childOf(i.id);
    await engine.approve(child!.id, { approverId: 'chair' });

    const history = await engine.getHistory(i.id);
    const entry = history.find((h) => h.action === 'subworkflow_completed');
    expect(entry?.actorId).toBe('system');
    expect(entry?.newValue?.['outcome']).toBe('approved');
    expect(entry?.newValue?.['childInstanceId']).toBe(child!.id);
  });

  it('spawns a leading sub-workflow level at submit', async () => {
    await engine.defineTemplate({
      name: 'LEAD',
      documentType: 'lead',
      levels: [
        {
          level: 1,
          name: 'Board first',
          mode: 'any',
          approvers: [],
          subWorkflow: { templateName: 'BOARD' },
        },
        u(2, 'CEO', 'ceo'),
      ],
    });
    const i = await engine.submit({
      templateName: 'LEAD',
      documentId: 'lead-1',
      documentType: 'lead',
      submittedBy: 'buyer',
      data: {},
    });
    const child = await childOf(i.id, 1);
    expect(child?.templateName).toBe('BOARD');
  });

  it('nests two levels deep', async () => {
    await engine.defineTemplate({
      name: 'MID',
      documentType: 'mid',
      levels: [
        {
          level: 1,
          name: 'Board',
          mode: 'any',
          approvers: [],
          subWorkflow: { templateName: 'BOARD' },
        },
      ],
    });
    await engine.defineTemplate({
      name: 'TOP',
      documentType: 'top',
      levels: [
        { level: 1, name: 'Mid', mode: 'any', approvers: [], subWorkflow: { templateName: 'MID' } },
      ],
    });

    const top = await engine.submit({
      templateName: 'TOP',
      documentId: 'top-1',
      documentType: 'top',
      submittedBy: 'buyer',
      data: {},
    });
    const mid = await childOf(top.id, 1);
    expect(mid?.subWorkflowDepth).toBe(1);
    const board = await childOf(mid!.id, 1);
    expect(board?.subWorkflowDepth).toBe(2);

    await engine.approve(board!.id, { approverId: 'chair' });
    expect((await engine.getInstance(mid!.id)).status).toBe('approved');
    expect((await engine.getInstance(top.id)).status).toBe('approved');
  });

  describe('validation', () => {
    const withLevel = (level: Record<string, unknown>) => ({
      name: 'X',
      documentType: 'x',
      levels: [{ level: 1, name: 'L', mode: 'any' as const, approvers: [], ...level }],
    });

    it('allows a sub-workflow level with no approvers', () => {
      expect(
        engine.validateTemplate(withLevel({ subWorkflow: { templateName: 'BOARD' } })).valid,
      ).toBe(true);
    });

    it('still requires approvers on an ordinary level', () => {
      expect(engine.validateTemplate(withLevel({})).valid).toBe(false);
    });

    it('rejects a template that would spawn itself', () => {
      const r = engine.validateTemplate(withLevel({ subWorkflow: { templateName: 'X' } }));
      expect(r.valid).toBe(false);
      expect(r.errors.map((e) => e.message).join(' ')).toMatch(/cannot terminate/);
    });

    it('rejects a level that sets both approvers and subWorkflow', () => {
      const r = engine.validateTemplate(
        withLevel({
          approvers: [{ type: 'user', userId: 'x' }],
          subWorkflow: { templateName: 'BOARD' },
        }),
      );
      expect(r.valid).toBe(false);
      expect(r.errors.map((e) => e.message).join(' ')).toMatch(/would never be asked/);
    });
  });
});
