import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { EscalationScheduler } from '../../src/engine/EscalationScheduler.js';
import type { Clock } from '../../src/utils/Clock.js';

class TestClock implements Clock {
  constructor(private current = new Date('2026-01-01T00:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
}

const DAY = 86_400_000;

describe('escalation ladders', () => {
  let clock: TestClock;
  let adapter: MemoryAdapter;
  let engine: ApprovalEngine;
  let scheduler: EscalationScheduler;

  beforeEach(async () => {
    clock = new TestClock();
    adapter = new MemoryAdapter();
    engine = new ApprovalEngine({ adapter, clock });
    scheduler = new EscalationScheduler({
      adapter,
      tenantId: 'default',
      clock,
      onEscalate: async (id, levelNumber) => {
        await (
          engine as unknown as {
            escalateInternal: (
              i: string,
              by: string,
              ctx: undefined,
              l?: number,
            ) => Promise<unknown>;
          }
        ).escalateInternal(id, 'system', undefined, levelNumber);
      },
    });

    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
      ],
      escalationSteps: [
        { afterDays: 2, escalateTo: { type: 'user', userId: 'director' } },
        { afterDays: 4, escalateTo: { type: 'user', userId: 'vp' } },
        { afterDays: 7, escalateTo: { type: 'user', userId: 'ceo' } },
      ],
    });
  });

  const submit = () =>
    engine.submit({
      templateName: 'PO',
      documentId: `d-${Math.random()}`,
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: {},
    });

  const approvers = async (id: string) => (await engine.getInstance(id)).levels[0]?.approverIds;

  it('arms the first rung when the level opens', async () => {
    const i = await submit();
    expect(i.levels[0]?.escalationDueAt?.getTime()).toBe(clock.now().getTime() + 2 * DAY);
    expect(i.levels[0]?.escalationStep).toBe(0);
  });

  it('fires each rung in turn, adding approvers cumulatively', async () => {
    const i = await submit();

    clock.advanceDays(2);
    await scheduler.tick();
    expect(await approvers(i.id)).toEqual(['mgr', 'director']);

    clock.advanceDays(2); // day 4
    await scheduler.tick();
    expect(await approvers(i.id)).toEqual(['mgr', 'director', 'vp']);

    clock.advanceDays(3); // day 7
    await scheduler.tick();
    expect(await approvers(i.id)).toEqual(['mgr', 'director', 'vp', 'ceo']);
  });

  it('measures each rung from when the level opened, not from the last escalation', async () => {
    const i = await submit();
    clock.advanceDays(2);
    await scheduler.tick();

    // The second rung is "4 days after the level opened", i.e. 2 more days.
    const after = await engine.getInstance(i.id);
    expect(after.levels[0]?.escalationDueAt?.getTime()).toBe(
      new Date('2026-01-01T00:00:00Z').getTime() + 4 * DAY,
    );
  });

  it('stops after the last rung', async () => {
    const i = await submit();
    for (const day of [2, 4, 7]) {
      clock.advanceDays(day === 2 ? 2 : day === 4 ? 2 : 3);
      await scheduler.tick();
    }
    const after = await engine.getInstance(i.id);
    expect(after.levels[0]?.escalationStep).toBe(3);
    expect(after.levels[0]?.escalationDueAt).toBeUndefined();

    clock.advanceDays(30);
    await scheduler.tick();
    expect(await approvers(i.id)).toEqual(['mgr', 'director', 'vp', 'ceo']);
  });

  it('does not fire a rung before its deadline', async () => {
    const i = await submit();
    clock.advanceDays(1);
    await scheduler.tick();
    expect(await approvers(i.id)).toEqual(['mgr']);
  });

  it('sorts rungs by delay regardless of declaration order', async () => {
    const e = new ApprovalEngine({ adapter: new MemoryAdapter(), clock });
    await e.defineTemplate({
      name: 'OUT',
      documentType: 'out',
      levels: [{ level: 1, name: 'L', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' }],
      escalationSteps: [
        { afterDays: 5, escalateTo: { type: 'user', userId: 'late' } },
        { afterDays: 1, escalateTo: { type: 'user', userId: 'early' } },
      ],
    });
    const i = await e.submit({
      templateName: 'OUT',
      documentId: 'o-1',
      documentType: 'out',
      submittedBy: 'buyer',
      data: {},
    });
    expect(i.levels[0]?.escalationDueAt?.getTime()).toBe(clock.now().getTime() + 1 * DAY);
  });

  it('an explicit per-level delay overrides the ladder timing', async () => {
    const e = new ApprovalEngine({ adapter: new MemoryAdapter(), clock });
    await e.defineTemplate({
      name: 'MIX',
      documentType: 'mix',
      levels: [
        {
          level: 1,
          name: 'L',
          approvers: [{ type: 'user', userId: 'a' }],
          mode: 'any',
          escalationAfterDays: 1,
        },
      ],
      escalationSteps: [{ afterDays: 9, escalateTo: { type: 'user', userId: 'boss' } }],
    });
    const i = await e.submit({
      templateName: 'MIX',
      documentId: 'm-1',
      documentType: 'mix',
      submittedBy: 'buyer',
      data: {},
    });
    // The level says when; the ladder says who.
    expect(i.levels[0]?.escalationDueAt?.getTime()).toBe(clock.now().getTime() + 1 * DAY);
  });

  it('falls back to the single-step escalation when no ladder is set', async () => {
    const e = new ApprovalEngine({ adapter: new MemoryAdapter(), clock });
    const a = (e as unknown as { opts: { adapter: MemoryAdapter } }).opts.adapter;
    await e.defineTemplate({
      name: 'OLD',
      documentType: 'old',
      levels: [
        {
          level: 1,
          name: 'L',
          approvers: [{ type: 'user', userId: 'a' }],
          mode: 'any',
          escalationAfterDays: 1,
        },
      ],
      escalation: { afterDays: 1, escalateTo: { type: 'user', userId: 'boss' } },
    });
    const i = await e.submit({
      templateName: 'OLD',
      documentId: 'old-1',
      documentType: 'old',
      submittedBy: 'buyer',
      data: {},
    });

    const s = new EscalationScheduler({
      adapter: a,
      tenantId: 'default',
      clock,
      onEscalate: async (id, lvl) => {
        await (
          e as unknown as {
            escalateInternal: (i: string, by: string, c: undefined, l?: number) => Promise<unknown>;
          }
        ).escalateInternal(id, 'system', undefined, lvl);
      },
    });
    clock.advanceDays(1);
    await s.tick();
    expect((await e.getInstance(i.id)).levels[0]?.approverIds).toEqual(['a', 'boss']);
  });

  it('records each escalation in the audit trail', async () => {
    const i = await submit();
    clock.advanceDays(2);
    await scheduler.tick();
    clock.advanceDays(2);
    await scheduler.tick();

    const history = await engine.getHistory(i.id);
    const escalations = history.filter((h) => h.action === 'escalated');
    expect(escalations).toHaveLength(2);
    expect(escalations.map((e) => e.delegateTo)).toEqual(['director', 'vp']);
  });
});

describe('rungs are measured from when each branch opened', () => {
  // Regression guard: the open time was inferred from the audit trail, and a
  // level_advanced entry carries only the group's lowest level number. An upper
  // branch of a parallel group therefore found no entry, fell back to "now",
  // and measured its rungs from the previous escalation — so two identically
  // configured branches of one group escalated on different schedules.
  const DAY_MS = 86_400_000;

  it('gives both branches of a group the same next-rung deadline', async () => {
    const clock = new TestClock();
    const adapter = new MemoryAdapter();
    const engine = new ApprovalEngine({ adapter, clock });
    const scheduler = new EscalationScheduler({
      adapter,
      tenantId: 'default',
      clock,
      onEscalate: async (id, levelNumber) => {
        await (
          engine as unknown as {
            escalateInternal: (i: string, b: string, c: undefined, l?: number) => Promise<unknown>;
          }
        ).escalateInternal(id, 'system', undefined, levelNumber);
      },
    });

    await engine.defineTemplate({
      name: 'PAR',
      documentType: 'contract',
      levels: [
        {
          level: 1,
          name: 'Finance',
          group: 'rev',
          approvers: [{ type: 'user', userId: 'fin' }],
          mode: 'any',
        },
        {
          level: 2,
          name: 'Legal',
          group: 'rev',
          approvers: [{ type: 'user', userId: 'legal' }],
          mode: 'any',
        },
      ],
      escalationSteps: [
        { afterDays: 2, escalateTo: { type: 'user', userId: 'director' } },
        { afterDays: 4, escalateTo: { type: 'user', userId: 'vp' } },
      ],
    });

    const i = await engine.submit({
      templateName: 'PAR',
      documentId: 'c-1',
      documentType: 'contract',
      submittedBy: 'buyer',
      data: {},
    });
    const openedAt = clock.now().getTime();

    clock.advanceDays(2);
    await scheduler.tick();

    const after = await engine.getInstance(i.id);
    const daysFromOpen = (l?: { escalationDueAt?: Date }) =>
      ((l?.escalationDueAt?.getTime() ?? 0) - openedAt) / DAY_MS;

    expect(daysFromOpen(after.levels.find((l) => l.level === 1))).toBe(4);
    expect(daysFromOpen(after.levels.find((l) => l.level === 2))).toBe(4);
  });

  it('records openedAt when a level activates', async () => {
    const clock = new TestClock();
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter(), clock });
    await engine.defineTemplate({
      name: 'SEQ',
      documentType: 'seq',
      levels: [
        { level: 1, name: 'One', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' },
        { level: 2, name: 'Two', approvers: [{ type: 'user', userId: 'b' }], mode: 'any' },
      ],
    });
    const i = await engine.submit({
      templateName: 'SEQ',
      documentId: 's-1',
      documentType: 'seq',
      submittedBy: 'buyer',
      data: {},
    });
    expect(i.levels[0]?.openedAt).toBeInstanceOf(Date);
    expect(i.levels[1]?.openedAt).toBeUndefined();

    clock.advanceDays(3);
    const after = await engine.approve(i.id, { approverId: 'a' });
    // The second level opened three days after the first, and says so.
    expect(after.levels[1]?.openedAt?.getTime()).toBe(clock.now().getTime());
  });

  it('survives a storage round trip as a Date', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'RT',
      documentType: 'rt',
      levels: [{ level: 1, name: 'One', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' }],
    });
    const i = await engine.submit({
      templateName: 'RT',
      documentId: 'rt-1',
      documentType: 'rt',
      submittedBy: 'buyer',
      data: {},
    });
    expect((await engine.getInstance(i.id)).levels[0]?.openedAt).toBeInstanceOf(Date);
  });
});
