import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';

const u = (n: number, name: string, userId: string) => ({
  level: n,
  name,
  approvers: [{ type: 'user' as const, userId }],
  mode: 'any' as const,
});

describe('explainChain', () => {
  let engine: ApprovalEngine;

  beforeEach(async () => {
    engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [u(1, 'Manager', 'mgr'), u(2, 'Finance', 'fin')],
      conditions: [
        // 0: adds the CFO for large amounts
        { when: { field: 'amount', operator: '>', value: 10000 }, addLevels: [u(3, 'CFO', 'cfo')] },
        // 1: skips Finance for internal transfers
        { when: { field: 'category', operator: '==', value: 'internal' }, skipLevels: [2] },
      ],
    });
  });

  it('marks statically declared levels as coming from the template', async () => {
    const e = await engine.explainChain('PO', { amount: 1 }, 'buyer');
    expect(e.templateName).toBe('PO');
    expect(e.levels.map((l) => [l.level, l.source])).toEqual([
      [1, 'template'],
      [2, 'template'],
    ]);
  });

  it('names the rule that added a level', async () => {
    const e = await engine.explainChain('PO', { amount: 20000 }, 'buyer');
    const cfo = e.levels.find((l) => l.level === 3);
    expect(cfo?.source).toBe('condition');
    expect(cfo?.addedByRule).toBe(0);
    expect(cfo?.name).toBe('CFO');
  });

  it('names the rule that skipped a level', async () => {
    const e = await engine.explainChain('PO', { category: 'internal' }, 'buyer');
    expect(e.levels.map((l) => l.level)).toEqual([1]);
    expect(e.skipped).toEqual([{ level: 2, name: 'Finance', skippedByRule: 1 }]);
  });

  it('reports every rule, matched or not, with what it would do', async () => {
    const e = await engine.explainChain('PO', { amount: 1 }, 'buyer');
    expect(e.rules).toEqual([
      { index: 0, matched: false, addsLevels: [3], skipsLevels: [] },
      { index: 1, matched: false, addsLevels: [], skipsLevels: [2] },
    ]);
  });

  it('marks the rules that did fire', async () => {
    const e = await engine.explainChain('PO', { amount: 20000, category: 'internal' }, 'buyer');
    expect(e.rules.map((r) => r.matched)).toEqual([true, true]);
    expect(e.levels.map((l) => l.level)).toEqual([1, 3]);
  });

  it('resolves approvers per level', async () => {
    const e = await engine.explainChain('PO', { amount: 20000 }, 'buyer');
    expect(e.levels.map((l) => l.resolvedApprovers)).toEqual([['mgr'], ['fin'], ['cfo']]);
  });

  it('still lists a level whose approvers cannot be resolved, with the reason', async () => {
    await engine.defineTemplate({
      name: 'ROLE',
      documentType: 'role',
      levels: [
        { level: 1, name: 'Team', approvers: [{ type: 'role', role: 'nobody' }], mode: 'any' },
      ],
    });
    const e = await engine.explainChain('ROLE', {}, 'buyer');
    expect(e.levels[0]?.resolvedApprovers).toEqual([]);
    // Naming the level with the unresolvable approver is the whole point.
    expect(e.levels[0]?.resolutionError).toMatch(/orgProvider/);
  });

  it('reports a broken rule against that rule rather than throwing', async () => {
    await engine.defineTemplate({
      name: 'BROKEN',
      documentType: 'broken',
      levels: [u(1, 'L', 'a')],
      conditions: [
        { when: { field: 'x', operator: 'never_registered', value: 1 }, skipLevels: [1] },
      ],
    });

    const e = await engine.explainChain('BROKEN', { x: 1 }, 'buyer');
    expect(e.rules[0]?.error).toMatch(/Unknown condition operator "never_registered"/);
    expect(e.rules[0]?.matched).toBe(false);
    // The explanation is least useful at exactly the moment it would throw.
    expect(e.levels.map((l) => l.level)).toEqual([1]);
  });

  it('marks a sub-workflow level and does not resolve approvers for it', async () => {
    await engine.defineTemplate({
      name: 'CHILD',
      documentType: 'child',
      levels: [u(1, 'Board', 'chair')],
    });
    await engine.defineTemplate({
      name: 'PARENT',
      documentType: 'parent',
      levels: [
        {
          level: 1,
          name: 'Board approval',
          mode: 'any',
          approvers: [],
          subWorkflow: { templateName: 'CHILD' },
        },
      ],
    });

    const e = await engine.explainChain('PARENT', {}, 'buyer');
    expect(e.levels[0]?.subWorkflowTemplate).toBe('CHILD');
    expect(e.levels[0]?.resolvedApprovers).toEqual([]);
    expect(e.levels[0]?.resolutionError).toBeUndefined();
  });

  it('agrees with what submit() actually builds', async () => {
    const data = { amount: 20000 };
    const e = await engine.explainChain('PO', data, 'buyer');
    const i = await engine.submit({
      templateName: 'PO',
      documentId: 'po-1',
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data,
    });
    expect(e.levels.map((l) => l.level)).toEqual(i.levels.map((l) => l.level));
  });

  it('throws for a template that does not exist', async () => {
    await expect(engine.explainChain('nope', {}, 'buyer')).rejects.toThrow();
  });
});
