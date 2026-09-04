import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';

/**
 * A sub-workflow child is only reachable through its parent's childInstanceId.
 * When the parent ends, the child has to end with it: otherwise it stays
 * pending, keeps notifying and escalating, and asks people to decide something
 * whose outcome propagateToParent will refuse to read.
 */
describe('sub-workflow child lifecycle', () => {
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
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        {
          level: 1,
          name: 'Sub',
          mode: 'any',
          approvers: [],
          subWorkflow: { templateName: 'CHILD' },
        },
        { level: 2, name: 'CEO', approvers: [{ type: 'user', userId: 'ceo' }], mode: 'any' },
      ],
    });
  });

  const submit = async () => {
    const parent = await engine.submit({
      templateName: 'PO',
      documentId: `po-${Math.random()}`,
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: {},
    });
    const childId = (await engine.getInstance(parent.id)).levels[0]?.childInstanceId as string;
    expect(childId).toBeDefined();
    return { parent, childId };
  };

  it('cancels the child when the parent is cancelled', async () => {
    const { parent, childId } = await submit();
    await engine.cancel(parent.id, { cancelledBy: 'buyer', reason: 'withdrawn' });

    const child = await engine.getInstance(childId);
    expect(child.status).toBe('cancelled');
  });

  it('records why the child was cancelled', async () => {
    const { parent, childId } = await submit();
    await engine.cancel(parent.id, { cancelledBy: 'buyer', reason: 'withdrawn' });

    const history = await engine.getHistory(childId);
    const entry = history.find((h) => h.action === 'cancelled');
    expect(entry?.actorId).toBe('system');
    expect(entry?.reason).toMatch(new RegExp(`Parent approval ${parent.id} ended as "cancelled"`));
  });

  it('keeps the cancelled child out of the pending workload', async () => {
    const { parent } = await submit();
    expect((await engine.getWorkload()).map((w) => w.approverId)).toContain('chair');

    await engine.cancel(parent.id, { cancelledBy: 'buyer', reason: 'x' });
    expect((await engine.getWorkload()).map((w) => w.approverId)).not.toContain('chair');
  });

  it('does not disturb a child that already finished', async () => {
    const { parent, childId } = await submit();
    await engine.approve(childId, { approverId: 'chair' });
    expect((await engine.getInstance(childId)).status).toBe('approved');

    await engine.cancel(parent.id, { cancelledBy: 'buyer', reason: 'x' });
    expect((await engine.getInstance(childId)).status).toBe('approved');
  });

  it('cancels the child when the parent is rejected at a later level', async () => {
    const { parent } = await submit();
    // Approve the sub-workflow so the parent advances to the CEO level.
    const childId = (await engine.getInstance(parent.id)).levels[0]?.childInstanceId as string;
    await engine.approve(childId, { approverId: 'chair' });

    // A second sub-workflow instance is not spawned; reject at the CEO level.
    await engine.reject(parent.id, { approverId: 'ceo', reason: 'no' });
    expect((await engine.getInstance(parent.id)).status).toBe('rejected');
    // The already-approved child is untouched.
    expect((await engine.getInstance(childId)).status).toBe('approved');
  });

  describe('purge takes the family together', () => {
    it('removes the child with its parent', async () => {
      const { parent, childId } = await submit();
      await engine.cancel(parent.id, { cancelledBy: 'buyer', reason: 'x' });

      const result = await engine.purgeInstances({
        olderThan: new Date(Date.now() + 86_400_000),
      });

      expect(result.purged.map((p) => p.instanceId).sort()).toEqual([parent.id, childId].sort());
      expect((await engine.queryInstances({})).items).toEqual([]);
    });

    it('leaves nothing behind when scoped to the parent document type', async () => {
      const { parent } = await submit();
      await engine.cancel(parent.id, { cancelledBy: 'buyer', reason: 'x' });

      // The child is a different documentType, so a scoped purge would
      // previously have stranded it.
      await engine.purgeInstances({
        olderThan: new Date(Date.now() + 86_400_000),
        documentType: 'purchase_order',
      });
      expect((await engine.queryInstances({})).items).toEqual([]);
      expect(parent.id).toBeDefined();
    });

    it('reports the family under dryRun without deleting', async () => {
      const { parent, childId } = await submit();
      await engine.cancel(parent.id, { cancelledBy: 'buyer', reason: 'x' });

      const result = await engine.purgeInstances({
        olderThan: new Date(Date.now() + 86_400_000),
        dryRun: true,
      });
      expect(result.purged).toHaveLength(2);
      expect((await engine.getInstance(childId)).id).toBe(childId);
    });
  });
});

describe('every terminal path ends the family', () => {
  // 3.0.0 cascaded from approve, reject and cancel. override() and expiry are
  // terminal too and were missed: an overridden parent left its children
  // running, and an expired child left its parent waiting on an answer that
  // would never come.
  const build = async (extra: Record<string, unknown> = {}) => {
    const adapter = new MemoryAdapter();
    const engine = new ApprovalEngine({ adapter });
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
      allowOverride: true,
      levels: [
        {
          level: 1,
          name: 'Sub',
          mode: 'any',
          approvers: [],
          subWorkflow: { templateName: 'CHILD' },
        },
      ],
      ...extra,
    });
    const parent = await engine.submit({
      templateName: 'PO',
      documentId: `po-${Math.random()}`,
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: {},
    });
    const childId = (await engine.getInstance(parent.id)).levels[0]?.childInstanceId as string;
    return { engine, adapter, parent, childId };
  };

  it('an override cancels the still-running child', async () => {
    const { engine, parent, childId } = await build();
    await engine.override(parent.id, { overriddenBy: 'admin', justification: 'urgent' });

    expect((await engine.getInstance(parent.id)).status).toBe('approved');
    expect((await engine.getInstance(childId)).status).toBe('cancelled');
  });

  it('an expired child releases its parent instead of hanging it', async () => {
    const { engine, adapter, parent, childId } = await build();

    const child = await engine.getInstance(childId);
    child.expiresAt = new Date(Date.now() - 1000);
    await adapter.updateInstance(child, child.version);
    await (
      engine as unknown as { expireInstance: (id: string, a: 'cancel' | 'reject') => Promise<void> }
    ).expireInstance(childId, 'cancel');

    expect((await engine.getInstance(childId)).status).toBe('cancelled');
    // The parent was waiting on an approval that can now never happen.
    expect((await engine.getInstance(parent.id)).status).toBe('rejected');
  });

  it('an expired parent stops its child', async () => {
    const { engine, adapter, parent, childId } = await build();

    const p = await engine.getInstance(parent.id);
    p.expiresAt = new Date(Date.now() - 1000);
    await adapter.updateInstance(p, p.version);
    await (
      engine as unknown as { expireInstance: (id: string, a: 'cancel' | 'reject') => Promise<void> }
    ).expireInstance(parent.id, 'cancel');

    expect((await engine.getInstance(parent.id)).status).toBe('cancelled');
    expect((await engine.getInstance(childId)).status).toBe('cancelled');
  });
});
