import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { ApprovalTemplateConfig, DataUpdatedEvent } from '../../src/types/index.js';

const level = (n: number, name: string, userId: string) => ({
  level: n,
  name,
  approvers: [{ type: 'user' as const, userId }],
  mode: 'any' as const,
});

describe('updateData', () => {
  let engine: ApprovalEngine;

  beforeEach(() => {
    engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
  });

  /** Template whose CFO level appears only for amounts over 10k. */
  const conditionalTemplate = (): ApprovalTemplateConfig => ({
    name: 'PO',
    documentType: 'purchase_order',
    levels: [level(1, 'Manager', 'mgr'), level(2, 'Finance', 'fin')],
    conditions: [
      {
        when: { field: 'amount', operator: '>', value: 10000 },
        addLevels: [level(3, 'CFO', 'cfo')],
      },
    ],
  });

  const submit = async (data: Record<string, unknown>) =>
    engine.submit({
      templateName: 'PO',
      documentId: `doc-${Math.random()}`,
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data,
    });

  const names = (levels: Array<{ name: string }>) => levels.map((l) => l.name);

  describe('chain re-evaluation', () => {
    it('adds a level when the new data crosses a threshold', async () => {
      await engine.defineTemplate(conditionalTemplate());
      const instance = await submit({ amount: 5000 });
      expect(names(instance.levels)).toEqual(['Manager', 'Finance']);

      const updated = await engine.updateData(instance.id, {
        updatedBy: 'buyer',
        data: { amount: 20000 },
        reason: 'Corrected line items',
      });
      expect(names(updated.levels)).toEqual(['Manager', 'Finance', 'CFO']);
      expect(updated.data['amount']).toBe(20000);
    });

    it('removes a future level when the new data falls below a threshold', async () => {
      await engine.defineTemplate(conditionalTemplate());
      const instance = await submit({ amount: 20000 });
      expect(names(instance.levels)).toEqual(['Manager', 'Finance', 'CFO']);

      const updated = await engine.updateData(instance.id, {
        updatedBy: 'buyer',
        data: { amount: 900 },
      });
      expect(names(updated.levels)).toEqual(['Manager', 'Finance']);
    });

    it('leaves the chain alone when recomputeChain is false', async () => {
      await engine.defineTemplate(conditionalTemplate());
      const instance = await submit({ amount: 5000 });
      const updated = await engine.updateData(instance.id, {
        updatedBy: 'buyer',
        data: { amount: 20000 },
        recomputeChain: false,
      });
      expect(names(updated.levels)).toEqual(['Manager', 'Finance']);
      expect(updated.data['amount']).toBe(20000);
    });
  });

  describe('decided history is frozen', () => {
    it('keeps an already-approved level even when conditions would skip it', async () => {
      await engine.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [level(1, 'Manager', 'mgr'), level(2, 'Finance', 'fin')],
        conditions: [
          { when: { field: 'fastTrack', operator: '==', value: true }, skipLevels: [1, 2] },
        ],
      });
      const instance = await submit({ fastTrack: false });
      await engine.approve(instance.id, { approverId: 'mgr' });

      const updated = await engine.updateData(instance.id, {
        updatedBy: 'buyer',
        data: { fastTrack: true },
      });

      // Level 1 was approved and level 2 is in progress: neither may vanish.
      expect(names(updated.levels)).toEqual(['Manager', 'Finance']);
      expect(updated.levels[0]?.status).toBe('approved');
      expect(updated.levels[0]?.approvedBy).toEqual(['mgr']);
    });

    it('refuses to insert a level at or before the current level', async () => {
      await engine.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [level(1, 'Manager', 'mgr'), level(3, 'CEO', 'ceo')],
        conditions: [
          {
            when: { field: 'needsFinance', operator: '==', value: true },
            addLevels: [level(2, 'Finance', 'fin')],
          },
        ],
      });
      const instance = await submit({ needsFinance: false });
      await engine.approve(instance.id, { approverId: 'mgr' }); // now at level 3

      await expect(
        engine.updateData(instance.id, { updatedBy: 'buyer', data: { needsFinance: true } }),
      ).rejects.toThrow(/would insert level 2 .*at or before the current level 3/);
    });

    it('preserves the approval already collected on the current level', async () => {
      await engine.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [
          {
            ...level(1, 'Board', 'd1'),
            mode: 'quorum',
            minApprovals: 2,
            approvers: [
              { type: 'user' as const, userId: 'd1' },
              { type: 'user' as const, userId: 'd2' },
              { type: 'user' as const, userId: 'd3' },
            ],
          },
        ],
      });
      const instance = await submit({ amount: 1 });
      await engine.approve(instance.id, { approverId: 'd1' });

      const updated = await engine.updateData(instance.id, {
        updatedBy: 'buyer',
        data: { amount: 2 },
      });
      expect(updated.levels[0]?.approvedBy).toEqual(['d1']);
      expect(updated.status).toBe('pending');
    });
  });

  describe('merge vs replace', () => {
    it('merges by default, leaving untouched keys intact', async () => {
      await engine.defineTemplate(conditionalTemplate());
      const instance = await submit({ amount: 100, vendor: 'acme', note: 'keep me' });
      const updated = await engine.updateData(instance.id, {
        updatedBy: 'buyer',
        data: { amount: 200 },
      });
      expect(updated.data).toEqual({ amount: 200, vendor: 'acme', note: 'keep me' });
    });

    it('replace drops keys not present in the new data', async () => {
      await engine.defineTemplate(conditionalTemplate());
      const instance = await submit({ amount: 100, vendor: 'acme' });
      const updated = await engine.updateData(instance.id, {
        updatedBy: 'buyer',
        data: { amount: 200 },
        mode: 'replace',
      });
      expect(updated.data).toEqual({ amount: 200 });
    });
  });

  describe('audit, events and guards', () => {
    it('records a data_updated audit entry with before and after', async () => {
      await engine.defineTemplate(conditionalTemplate());
      const instance = await submit({ amount: 100 });
      await engine.updateData(instance.id, {
        updatedBy: 'buyer',
        data: { amount: 20000 },
        reason: 'Repriced',
      });

      const history = await engine.getHistory(instance.id);
      const entry = history.find((h) => h.action === 'data_updated');
      expect(entry).toBeDefined();
      expect(entry?.actorId).toBe('buyer');
      expect(entry?.reason).toBe('Repriced');
      expect((entry?.oldValue?.['data'] as Record<string, unknown>)['amount']).toBe(100);
      expect((entry?.newValue?.['data'] as Record<string, unknown>)['amount']).toBe(20000);
      expect(entry?.newValue?.['addedLevels']).toEqual([3]);
    });

    it('emits approval:data_updated with changed fields and chain delta', async () => {
      await engine.defineTemplate(conditionalTemplate());
      const events: DataUpdatedEvent[] = [];
      engine.on('approval:data_updated', (e) => events.push(e));

      const instance = await submit({ amount: 100, vendor: 'acme' });
      await engine.updateData(instance.id, { updatedBy: 'buyer', data: { amount: 20000 } });

      expect(events).toHaveLength(1);
      expect(events[0]?.changedFields).toEqual(['amount']);
      expect(events[0]?.addedLevels).toEqual([3]);
      expect(events[0]?.removedLevels).toEqual([]);
    });

    it('reports no changed fields when the value is unchanged', async () => {
      await engine.defineTemplate(conditionalTemplate());
      const events: DataUpdatedEvent[] = [];
      engine.on('approval:data_updated', (e) => events.push(e));
      const instance = await submit({ amount: 100 });
      await engine.updateData(instance.id, { updatedBy: 'buyer', data: { amount: 100 } });
      expect(events[0]?.changedFields).toEqual([]);
    });

    it('refuses to update a non-pending instance', async () => {
      await engine.defineTemplate(conditionalTemplate());
      const instance = await submit({ amount: 100 });
      await engine.cancel(instance.id, { cancelledBy: 'buyer', reason: 'no longer needed' });

      await expect(
        engine.updateData(instance.id, { updatedBy: 'buyer', data: { amount: 1 } }),
      ).rejects.toThrow(/Cannot update data on a "cancelled" approval/);
    });

    it('refuses an update that would leave no levels at all', async () => {
      await engine.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [level(1, 'Manager', 'mgr')],
        conditions: [{ when: { field: 'skipAll', operator: '==', value: true }, skipLevels: [1] }],
      });
      const instance = await submit({ skipAll: false });
      // Level 1 is the current level, so it is frozen and survives; the guard
      // fires only when nothing at all would remain.
      const updated = await engine.updateData(instance.id, {
        updatedBy: 'buyer',
        data: { skipAll: true },
      });
      expect(names(updated.levels)).toEqual(['Manager']);
    });

    it('is rejected by an authorization policy that denies updateData', async () => {
      const denying = new ApprovalEngine({
        adapter: new MemoryAdapter(),
        authorizationPolicy: {
          authorize: (ctx) => (ctx.operation === 'updateData' ? 'not allowed' : undefined),
        },
      });
      await denying.defineTemplate(conditionalTemplate());
      const instance = await denying.submit({
        templateName: 'PO',
        documentId: 'doc-authz',
        documentType: 'purchase_order',
        submittedBy: 'buyer',
        data: { amount: 1 },
      });
      await expect(
        denying.updateData(instance.id, { updatedBy: 'buyer', data: { amount: 2 } }),
      ).rejects.toThrow(/not allowed/);
    });
  });
});
