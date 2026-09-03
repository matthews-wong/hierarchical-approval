import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

const lvl = (n: number, name: string, userId: string, group?: string) => ({
  level: n,
  name,
  approvers: [{ type: 'user' as const, userId }],
  mode: 'any' as const,
  ...(group ? { group } : {}),
});

describe('parallel branch groups', () => {
  let engine: ApprovalEngine;

  beforeEach(() => {
    engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
  });

  /** Manager -> (Finance || Legal) -> CEO */
  const forked = (): ApprovalTemplateConfig => ({
    name: 'PO',
    documentType: 'purchase_order',
    levels: [
      lvl(1, 'Manager', 'mgr'),
      lvl(2, 'Finance', 'fin', 'review'),
      lvl(3, 'Legal', 'legal', 'review'),
      lvl(4, 'CEO', 'ceo'),
    ],
  });

  const submit = async () =>
    engine.submit({
      templateName: 'PO',
      documentId: `doc-${Math.random()}`,
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: {},
    });

  const statuses = (i: { levels: Array<{ name: string; status: string }> }) =>
    Object.fromEntries(i.levels.map((l) => [l.name, l.status]));

  describe('activation', () => {
    it('opens both branches at once when the group is reached', async () => {
      await engine.defineTemplate(forked());
      const i = await submit();
      expect(statuses(i)).toEqual({
        Manager: 'pending',
        Finance: 'waiting',
        Legal: 'waiting',
        CEO: 'waiting',
      });

      const after = await engine.approve(i.id, { approverId: 'mgr' });
      expect(statuses(after)).toEqual({
        Manager: 'approved',
        Finance: 'pending',
        Legal: 'pending',
        CEO: 'waiting',
      });
    });

    it('opens a leading parallel group directly at submit', async () => {
      await engine.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [
          lvl(1, 'Finance', 'fin', 'review'),
          lvl(2, 'Legal', 'legal', 'review'),
          lvl(3, 'CEO', 'ceo'),
        ],
      });
      const i = await submit();
      expect(statuses(i)).toEqual({ Finance: 'pending', Legal: 'pending', CEO: 'waiting' });
    });

    it('reports approvers from every open branch', async () => {
      await engine.defineTemplate(forked());
      const i = await submit();
      await engine.approve(i.id, { approverId: 'mgr' });
      expect((await engine.getCurrentApprovers(i.id)).sort()).toEqual(['fin', 'legal']);
    });

    it('lets either branch approve first, in any order', async () => {
      await engine.defineTemplate(forked());
      const i = await submit();
      await engine.approve(i.id, { approverId: 'mgr' });

      // Legal goes first this time.
      const afterLegal = await engine.approve(i.id, { approverId: 'legal' });
      expect(statuses(afterLegal)['Legal']).toBe('approved');
      expect(statuses(afterLegal)['Finance']).toBe('pending');
      expect(statuses(afterLegal)['CEO']).toBe('waiting');
      expect(afterLegal.status).toBe('pending');
    });
  });

  describe('join semantics', () => {
    it('holds the chain until every branch resolves', async () => {
      await engine.defineTemplate(forked());
      const i = await submit();
      await engine.approve(i.id, { approverId: 'mgr' });
      await engine.approve(i.id, { approverId: 'fin' });

      const mid = await engine.getInstance(i.id);
      expect(statuses(mid)['CEO']).toBe('waiting');

      const joined = await engine.approve(i.id, { approverId: 'legal' });
      expect(statuses(joined)['CEO']).toBe('pending');
      expect(joined.currentLevel).toBe(4);
    });

    it('completes the instance when the final group is a parallel one', async () => {
      await engine.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [
          lvl(1, 'Manager', 'mgr'),
          lvl(2, 'Finance', 'fin', 'review'),
          lvl(3, 'Legal', 'legal', 'review'),
        ],
      });
      const i = await submit();
      await engine.approve(i.id, { approverId: 'mgr' });
      await engine.approve(i.id, { approverId: 'fin' });
      expect((await engine.getInstance(i.id)).status).toBe('pending');

      const done = await engine.approve(i.id, { approverId: 'legal' });
      expect(done.status).toBe('approved');
    });

    it('rejecting one branch rejects the whole instance', async () => {
      await engine.defineTemplate(forked());
      const i = await submit();
      await engine.approve(i.id, { approverId: 'mgr' });
      const rejected = await engine.reject(i.id, { approverId: 'legal', reason: 'contract risk' });
      expect(rejected.status).toBe('rejected');
    });

    it('supports three concurrent branches', async () => {
      await engine.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [
          lvl(1, 'Finance', 'fin', 'review'),
          lvl(2, 'Legal', 'legal', 'review'),
          lvl(3, 'Security', 'sec', 'review'),
          lvl(4, 'CEO', 'ceo'),
        ],
      });
      const i = await submit();
      expect(Object.values(statuses(i)).filter((s) => s === 'pending')).toHaveLength(3);
      await engine.approve(i.id, { approverId: 'fin' });
      await engine.approve(i.id, { approverId: 'sec' });
      expect(statuses(await engine.getInstance(i.id))['CEO']).toBe('waiting');
      await engine.approve(i.id, { approverId: 'legal' });
      expect(statuses(await engine.getInstance(i.id))['CEO']).toBe('pending');
    });

    it('runs two separate groups back to back', async () => {
      await engine.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [
          lvl(1, 'Finance', 'fin', 'first'),
          lvl(2, 'Legal', 'legal', 'first'),
          lvl(3, 'Ops', 'ops', 'second'),
          lvl(4, 'Risk', 'risk', 'second'),
        ],
      });
      const i = await submit();
      await engine.approve(i.id, { approverId: 'fin' });
      await engine.approve(i.id, { approverId: 'legal' });
      const s = statuses(await engine.getInstance(i.id));
      expect(s['Ops']).toBe('pending');
      expect(s['Risk']).toBe('pending');

      await engine.approve(i.id, { approverId: 'ops' });
      await engine.approve(i.id, { approverId: 'risk' });
      expect((await engine.getInstance(i.id)).status).toBe('approved');
    });
  });

  describe('an approver on two branches must disambiguate', () => {
    const shared = (): ApprovalTemplateConfig => ({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [{ ...lvl(1, 'Finance', 'cfo', 'review') }, { ...lvl(2, 'Legal', 'cfo', 'review') }],
    });

    it('refuses an ambiguous decision rather than guessing a branch', async () => {
      await engine.defineTemplate(shared());
      const i = await submit();
      await expect(engine.approve(i.id, { approverId: 'cfo' })).rejects.toThrow(
        /assigned to more than one open parallel level/,
      );
    });

    it('accepts an explicit level and records it against that branch', async () => {
      await engine.defineTemplate(shared());
      const i = await submit();
      const after = await engine.approve(i.id, { approverId: 'cfo', level: 2 });
      expect(statuses(after)).toEqual({ Finance: 'pending', Legal: 'approved' });

      const done = await engine.approve(i.id, { approverId: 'cfo', level: 1 });
      expect(done.status).toBe('approved');
    });

    it('rejects an explicit level that is not open', async () => {
      await engine.defineTemplate(forked());
      const i = await submit();
      await expect(engine.approve(i.id, { approverId: 'mgr', level: 4 })).rejects.toThrow(
        /Level 4 is not awaiting a decision/,
      );
    });
  });

  describe('validation', () => {
    it('rejects a non-contiguous group', () => {
      const result = engine.validateTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [
          lvl(1, 'Finance', 'fin', 'review'),
          lvl(2, 'Interloper', 'x'),
          lvl(3, 'Legal', 'legal', 'review'),
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.map((e) => e.message).join(' ')).toMatch(/not contiguous/);
    });

    it('accepts a contiguous group', () => {
      expect(engine.validateTemplate(forked()).valid).toBe(true);
    });
  });

  describe('sequential templates are unaffected', () => {
    it('still advances one level at a time', async () => {
      await engine.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [lvl(1, 'Manager', 'mgr'), lvl(2, 'Finance', 'fin')],
      });
      const i = await submit();
      expect(statuses(i)).toEqual({ Manager: 'pending', Finance: 'waiting' });
      const after = await engine.approve(i.id, { approverId: 'mgr' });
      expect(statuses(after)).toEqual({ Manager: 'approved', Finance: 'pending' });
      const done = await engine.approve(i.id, { approverId: 'fin' });
      expect(done.status).toBe('approved');
    });
  });
});
