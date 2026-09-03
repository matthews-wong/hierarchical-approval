import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';

const u = (n: number, name: string, userId: string) => ({
  level: n,
  name,
  approvers: [{ type: 'user' as const, userId }],
  mode: 'any' as const,
});

describe('simulate', () => {
  let adapter: MemoryAdapter;
  let engine: ApprovalEngine;

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    engine = new ApprovalEngine({ adapter });
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [u(1, 'Manager', 'mgr'), u(2, 'Finance', 'fin')],
      conditions: [
        { when: { field: 'amount', operator: '>', value: 10000 }, addLevels: [u(3, 'CFO', 'cfo')] },
      ],
    });
  });

  const sim = (over: Record<string, unknown> = {}) =>
    engine.simulate({
      templateName: 'PO',
      data: { amount: 1 },
      submittedBy: 'buyer',
      ...over,
    });

  it('reports the chain without any decisions', async () => {
    const r = await sim();
    expect(r.levels.map((l) => l.name)).toEqual(['Manager', 'Finance']);
    expect(r.finalStatus).toBe('pending');
    expect(r.incomplete).toBe(true);
    expect(r.unreachedLevels).toEqual([2]);
  });

  it('applies conditions, as submit would', async () => {
    const r = await sim({ data: { amount: 20000 } });
    expect(r.levels.map((l) => l.name)).toEqual(['Manager', 'Finance', 'CFO']);
  });

  it('plays a full approval to completion', async () => {
    const r = await sim({ decisions: [{ approve: 'mgr' }, { approve: 'fin' }] });
    expect(r.finalStatus).toBe('approved');
    expect(r.incomplete).toBe(false);
    expect(r.transcript.map((t) => [t.step, t.action, t.status])).toEqual([
      [1, 'approve', 'pending'],
      [2, 'approve', 'approved'],
    ]);
  });

  it('answers what a rejection does', async () => {
    const r = await sim({
      data: { amount: 20000 },
      decisions: [{ approve: 'mgr' }, { approve: 'fin' }, { reject: 'cfo', reason: 'over budget' }],
    });
    expect(r.finalStatus).toBe('rejected');
    expect(r.transcript.at(-1)).toMatchObject({ action: 'reject', actorId: 'cfo' });
  });

  it('stops at a refused decision and reports why', async () => {
    const r = await sim({ decisions: [{ approve: 'not-an-approver' }, { approve: 'fin' }] });
    expect(r.transcript).toHaveLength(1);
    expect(r.transcript[0]?.error).toMatch(/not an approver/i);
    expect(r.finalStatus).toBe('pending');
  });

  it('stops once the approval reaches a terminal state', async () => {
    const r = await sim({
      decisions: [{ approve: 'mgr' }, { approve: 'fin' }, { approve: 'someone-else' }],
    });
    expect(r.transcript).toHaveLength(2);
    expect(r.finalStatus).toBe('approved');
  });

  it('writes nothing to the caller"s storage', async () => {
    await sim({ decisions: [{ approve: 'mgr' }] });
    const stored = await engine.queryInstances({});
    expect(stored.items).toEqual([]);
  });

  it('does not fire the caller"s events or notifications', async () => {
    const seen: string[] = [];
    engine.on('approval:submitted', () => seen.push('submitted'));
    engine.on('approval:approved', () => seen.push('approved'));

    const notified: string[] = [];
    const withNotify = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      notificationAdapter: {
        notify: async (e) => {
          notified.push(e.type);
        },
      },
    });
    await withNotify.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [u(1, 'Manager', 'mgr')],
    });

    await sim({ decisions: [{ approve: 'mgr' }] });
    await withNotify.simulate({
      templateName: 'PO',
      data: {},
      submittedBy: 'buyer',
      decisions: [{ approve: 'mgr' }],
    });

    expect(seen).toEqual([]);
    expect(notified).toEqual([]);
  });

  it('resolves custom approver types registered on the real engine', async () => {
    engine.registerResolver('picker', () => 'picked-user');
    await engine.defineTemplate({
      name: 'DYN',
      documentType: 'dyn',
      levels: [
        {
          level: 1,
          name: 'Dynamic',
          mode: 'any',
          approvers: [{ type: 'dynamic', resolver: 'picker' }],
        },
      ],
    });

    const r = await engine.simulate({ templateName: 'DYN', data: {}, submittedBy: 'buyer' });
    // A simulation that could not resolve these would answer a different question.
    expect(r.levels[0]?.approvers).toEqual(['picked-user']);
  });

  it('reports final level statuses', async () => {
    const r = await sim({ decisions: [{ approve: 'mgr' }] });
    expect(r.levels.map((l) => [l.name, l.status])).toEqual([
      ['Manager', 'approved'],
      ['Finance', 'pending'],
    ]);
  });

  it('throws for a template that does not exist', async () => {
    await expect(
      engine.simulate({ templateName: 'nope', data: {}, submittedBy: 'buyer' }),
    ).rejects.toThrow();
  });
});
