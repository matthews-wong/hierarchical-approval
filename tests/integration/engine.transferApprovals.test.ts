import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';

const user = (n: number, name: string, userId: string, group?: string) => ({
  level: n,
  name,
  approvers: [{ type: 'user' as const, userId }],
  mode: 'any' as const,
  ...(group ? { group } : {}),
});

describe('transferApprovals', () => {
  let engine: ApprovalEngine;

  beforeEach(async () => {
    engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [user(1, 'Manager', 'alice'), user(2, 'Finance', 'fin')],
    });
    await engine.defineTemplate({
      name: 'INV',
      documentType: 'invoice',
      levels: [user(1, 'Manager', 'alice')],
    });
  });

  const submit = (template: string, documentType: string, id: string) =>
    engine.submit({
      templateName: template,
      documentId: id,
      documentType,
      submittedBy: 'buyer',
      data: {},
    });

  const transfer = (over: Record<string, unknown> = {}) =>
    engine.transferApprovals({
      fromApprover: 'alice',
      toApprover: 'bob',
      transferredBy: 'admin',
      reason: 'Alice left the company',
      ...over,
    });

  it('moves every pending approval to the new approver', async () => {
    const a = await submit('PO', 'purchase_order', 'po-1');
    const b = await submit('PO', 'purchase_order', 'po-2');

    const result = await transfer();
    expect(result.transferred).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.scanned).toBe(2);

    expect((await engine.getInstance(a.id)).levels[0]?.approverIds).toEqual(['bob']);
    expect((await engine.getInstance(b.id)).levels[0]?.approverIds).toEqual(['bob']);
  });

  it('leaves approvals belonging to other people alone', async () => {
    const mine = await submit('PO', 'purchase_order', 'po-1');
    await engine.approve(mine.id, { approverId: 'alice' }); // now at Finance/fin

    const result = await transfer();
    expect(result.transferred).toHaveLength(0);
    expect((await engine.getInstance(mine.id)).levels[1]?.approverIds).toEqual(['fin']);
  });

  it('scopes to one document type when asked', async () => {
    await submit('PO', 'purchase_order', 'po-1');
    const inv = await submit('INV', 'invoice', 'inv-1');

    const result = await transfer({ documentType: 'invoice' });
    expect(result.scanned).toBe(1);
    expect(result.transferred).toHaveLength(1);
    expect((await engine.getInstance(inv.id)).levels[0]?.approverIds).toEqual(['bob']);
  });

  it('dryRun reports what would move without changing anything', async () => {
    const a = await submit('PO', 'purchase_order', 'po-1');

    const result = await transfer({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.transferred).toHaveLength(1);
    expect(result.transferred[0]?.documentId).toBe('po-1');
    // Nothing was written.
    expect((await engine.getInstance(a.id)).levels[0]?.approverIds).toEqual(['alice']);
  });

  it('moves each open branch of a parallel group separately', async () => {
    await engine.defineTemplate({
      name: 'PAR',
      documentType: 'contract',
      levels: [user(1, 'Finance', 'alice', 'review'), user(2, 'Legal', 'alice', 'review')],
    });
    const i = await submit('PAR', 'contract', 'c-1');
    expect(i.levels.filter((l) => l.status === 'pending')).toHaveLength(2);

    const result = await transfer();
    expect(result.transferred.map((t) => t.level).sort()).toEqual([1, 2]);

    const after = await engine.getInstance(i.id);
    expect(after.levels[0]?.approverIds).toEqual(['bob']);
    expect(after.levels[1]?.approverIds).toEqual(['bob']);
  });

  it('records a reassigned audit entry per move, with the reason', async () => {
    const a = await submit('PO', 'purchase_order', 'po-1');
    await transfer();

    const history = await engine.getHistory(a.id);
    const entry = history.find((h) => h.action === 'reassigned');
    expect(entry?.actorId).toBe('admin');
    expect(entry?.reason).toBe('Alice left the company');
  });

  it('reports per-instance failures instead of aborting the sweep', async () => {
    // bob already approves po-1's level, so reassigning alice -> bob duplicates.
    await engine.defineTemplate({
      name: 'DUP',
      documentType: 'dup',
      levels: [
        {
          level: 1,
          name: 'Pair',
          mode: 'any',
          approvers: [
            { type: 'user', userId: 'alice' },
            { type: 'user', userId: 'bob' },
          ],
        },
      ],
    });
    const bad = await submit('DUP', 'dup', 'dup-1');
    const good = await submit('PO', 'purchase_order', 'po-1');

    const result = await transfer();
    expect(result.failed.map((f) => f.instanceId)).toContain(bad.id);
    // The healthy one still moved — a partial transfer is the useful outcome.
    expect((await engine.getInstance(good.id)).levels[0]?.approverIds).toEqual(['bob']);
  });

  it('refuses a transfer to the same person', async () => {
    await expect(transfer({ toApprover: 'alice' })).rejects.toThrow(
      /different fromApprover and toApprover/,
    );
  });

  it('returns an empty result when the queue is empty', async () => {
    const result = await engine.transferApprovals({
      fromApprover: 'nobody',
      toApprover: 'bob',
      transferredBy: 'admin',
      reason: 'x',
    });
    expect(result).toMatchObject({ transferred: [], failed: [], scanned: 0, dryRun: false });
  });

  it('honours the safety limit', async () => {
    await submit('PO', 'purchase_order', 'po-1');
    await submit('PO', 'purchase_order', 'po-2');
    await submit('PO', 'purchase_order', 'po-3');

    const result = await transfer({ limit: 2 });
    expect(result.scanned).toBe(2);
  });
});
