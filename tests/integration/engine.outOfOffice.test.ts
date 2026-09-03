import { describe, it, expect } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { OutOfOfficeProvider } from '../../src/engine/LevelResolver.js';

const lvl = (n: number, name: string, userId: string) => ({
  level: n,
  name,
  approvers: [{ type: 'user' as const, userId }],
  mode: 'any' as const,
});

/** Cover table driven by a plain map, standing in for an HR/directory lookup. */
const providerFrom = (table: Record<string, string>): OutOfOfficeProvider => ({
  getDelegateFor: (userId) => table[userId] ?? null,
});

const build = (ooo?: OutOfOfficeProvider) =>
  new ApprovalEngine({ adapter: new MemoryAdapter(), outOfOfficeProvider: ooo });

const defineTwoLevel = async (engine: ApprovalEngine) =>
  engine.defineTemplate({
    name: 'PO',
    documentType: 'purchase_order',
    levels: [lvl(1, 'Manager', 'mgr'), lvl(2, 'Finance', 'fin')],
  });

const submit = async (engine: ApprovalEngine) =>
  engine.submit({
    templateName: 'PO',
    documentId: `doc-${Math.random()}`,
    documentType: 'purchase_order',
    submittedBy: 'buyer',
    data: {},
  });

describe('out-of-office cover', () => {
  it('substitutes an absent approver at submit', async () => {
    const engine = build(providerFrom({ mgr: 'mgr-cover' }));
    await defineTwoLevel(engine);
    const i = await submit(engine);
    expect(i.levels[0]?.approverIds).toEqual(['mgr-cover']);
  });

  it('leaves an available approver alone', async () => {
    const engine = build(providerFrom({ someone_else: 'x' }));
    await defineTwoLevel(engine);
    const i = await submit(engine);
    expect(i.levels[0]?.approverIds).toEqual(['mgr']);
  });

  it('substitutes when a later level activates, not only at submit', async () => {
    const engine = build(providerFrom({ fin: 'fin-cover' }));
    await defineTwoLevel(engine);
    const i = await submit(engine);
    const after = await engine.approve(i.id, { approverId: 'mgr' });
    expect(after.levels[1]?.approverIds).toEqual(['fin-cover']);
  });

  it('lets the stand-in actually approve', async () => {
    const engine = build(providerFrom({ mgr: 'mgr-cover' }));
    await defineTwoLevel(engine);
    const i = await submit(engine);
    const after = await engine.approve(i.id, { approverId: 'mgr-cover' });
    expect(after.levels[0]?.status).toBe('approved');
  });

  it('follows a chain of absences to someone present', async () => {
    const engine = build(providerFrom({ mgr: 'a', a: 'b', b: 'c' }));
    await defineTwoLevel(engine);
    const i = await submit(engine);
    expect(i.levels[0]?.approverIds).toEqual(['c']);
  });

  it('stops on a cover cycle rather than looping forever', async () => {
    // a covers b while b covers a — a real misconfiguration.
    const engine = build(providerFrom({ mgr: 'a', a: 'b', b: 'a' }));
    await defineTwoLevel(engine);
    const i = await submit(engine);
    // Terminates and lands on someone; the point is that it returns at all.
    expect(i.levels[0]?.approverIds).toHaveLength(1);
  });

  it('stops after the hop cap on an unbounded cover chain', async () => {
    const engine = build({
      // Every user is away, forever forwarding to the next.
      getDelegateFor: (userId) => `${userId}+`,
    });
    await defineTwoLevel(engine);
    const i = await submit(engine);
    expect(i.levels[0]?.approverIds).toEqual(['mgr+++++']);
  });

  it('treats a throwing provider as no cover known', async () => {
    const engine = build({
      getDelegateFor: () => {
        throw new Error('HR system down');
      },
    });
    await defineTwoLevel(engine);
    const i = await submit(engine);
    // An HR lookup failing must not stop the approval being routed at all.
    expect(i.levels[0]?.approverIds).toEqual(['mgr']);
  });

  it('deduplicates when two approvers share one stand-in', async () => {
    const engine = build(providerFrom({ a: 'cover', b: 'cover' }));
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        {
          level: 1,
          name: 'Pair',
          mode: 'any',
          approvers: [
            { type: 'user', userId: 'a' },
            { type: 'user', userId: 'b' },
          ],
        },
      ],
    });
    const i = await submit(engine);
    expect(i.levels[0]?.approverIds).toEqual(['cover']);
  });

  it('is reflected in previewApprovalChain', async () => {
    const engine = build(providerFrom({ fin: 'fin-cover' }));
    await defineTwoLevel(engine);
    const preview = await engine.previewApprovalChain('PO', {}, 'buyer');
    expect(preview.levels[1]?.resolvedApprovers).toEqual(['fin-cover']);
  });

  it('is a no-op when no provider is configured', async () => {
    const engine = build();
    await defineTwoLevel(engine);
    const i = await submit(engine);
    expect(i.levels[0]?.approverIds).toEqual(['mgr']);
  });

  it('passes the resolution time to the provider so cover can be date-bound', async () => {
    const seen: Date[] = [];
    const engine = build({
      getDelegateFor: (userId, at) => {
        seen.push(at);
        return userId === 'mgr' ? 'holiday-cover' : null;
      },
    });
    await defineTwoLevel(engine);
    const i = await submit(engine);
    expect(i.levels[0]?.approverIds).toEqual(['holiday-cover']);
    expect(seen[0]).toBeInstanceOf(Date);
  });
});
