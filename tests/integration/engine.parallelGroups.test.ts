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

describe('escalation reaches every open branch', () => {
  it('returns an overdue upper branch from getOverdueInstances', async () => {
    // Regression guard: MemoryAdapter matched only instance.currentLevel, so an
    // overdue branch above the lowest one in a group was never even fetched,
    // and could not escalate. PostgresAdapter already scanned every level.
    const adapter = new MemoryAdapter();
    const engine = new ApprovalEngine({ adapter });
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        { ...lvl(1, 'Finance', 'fin', 'review'), escalationAfterDays: 5 },
        { ...lvl(2, 'Legal', 'legal', 'review'), escalationAfterDays: 1 },
      ],
    });
    const i = await engine.submit({
      templateName: 'PO',
      documentId: 'doc-esc',
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: {},
    });
    expect(i.currentLevel).toBe(1);

    // Two days on: Legal (level 2, the upper branch) is overdue; Finance is not.
    const asOf = new Date(Date.now() + 2 * 86_400_000);
    const overdue = await adapter.getOverdueInstances('default', asOf);
    expect(overdue.map((o) => o.id)).toContain(i.id);
  });
});

describe('delegate and reassign reach the right branch', () => {
  // Regression guard: both resolved via currentLevelInstance, so inside a
  // parallel group they always acted on the lowest open branch — an approver
  // could not hand off their own upper-branch work at all.
  const forkedShared = async (engine: ApprovalEngine) =>
    engine.defineTemplate({
      name: 'PAR',
      documentType: 'contract',
      levels: [lvl(1, 'Finance', 'fin', 'review'), lvl(2, 'Legal', 'legal', 'review')],
    });

  const submitPar = (engine: ApprovalEngine) =>
    engine.submit({
      templateName: 'PAR',
      documentId: `c-${Math.random()}`,
      documentType: 'contract',
      submittedBy: 'buyer',
      data: {},
    });

  it('reassigns the upper branch, not the lowest one', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await forkedShared(engine);
    const i = await submitPar(engine);

    await engine.reassign(i.id, {
      reassignedBy: 'admin',
      fromApprover: 'legal',
      toApprover: 'legal-2',
      reason: 'on leave',
    });

    const after = await engine.getInstance(i.id);
    expect(after.levels[0]?.approverIds).toEqual(['fin']);
    expect(after.levels[1]?.approverIds).toEqual(['legal-2']);
  });

  it('delegates the upper branch, not the lowest one', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await forkedShared(engine);
    const i = await submitPar(engine);

    await engine.delegate(i.id, {
      fromApprover: 'legal',
      toApprover: 'legal-2',
      reason: 'holiday',
    });

    const after = await engine.getInstance(i.id);
    expect(after.levels[0]?.approverIds).toEqual(['fin']);
    expect(after.levels[1]?.approverIds).toContain('legal-2');
  });

  it('an explicit level disambiguates when one person holds both branches', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'PAR2',
      documentType: 'contract',
      levels: [lvl(1, 'Finance', 'cfo', 'review'), lvl(2, 'Legal', 'cfo', 'review')],
    });
    const i = await engine.submit({
      templateName: 'PAR2',
      documentId: 'c-both',
      documentType: 'contract',
      submittedBy: 'buyer',
      data: {},
    });

    await engine.reassign(i.id, {
      reassignedBy: 'admin',
      fromApprover: 'cfo',
      toApprover: 'deputy',
      reason: 'split the load',
      level: 2,
    });

    const after = await engine.getInstance(i.id);
    expect(after.levels[0]?.approverIds).toEqual(['cfo']);
    expect(after.levels[1]?.approverIds).toEqual(['deputy']);
  });
});
