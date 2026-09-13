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

  it('treats a level with no escalationStep (predating the field) as rung 0', async () => {
    // escalationStep is optional on the type — a level persisted before this
    // field existed has none — so escalateInternal falls back to rung 0
    // rather than crashing on `undefined` used as an array index.
    const i = await submit();
    const stored = await engine.getInstance(i.id);
    delete stored.levels[0]!.escalationStep;
    await adapter.updateInstance(stored, stored.version);

    await engine.escalate(i.id, { escalatedBy: 'admin' });
    expect(await approvers(i.id)).toEqual(['mgr', 'director']);
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

  it('sorts an hours-based rung ahead of a slower days-based rung', async () => {
    const HOUR = 3_600_000;
    const e = new ApprovalEngine({ adapter: new MemoryAdapter(), clock });
    await e.defineTemplate({
      name: 'HRS',
      documentType: 'hrs',
      levels: [{ level: 1, name: 'L', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' }],
      escalationSteps: [
        { afterDays: 1, escalateTo: { type: 'user', userId: 'late' } },
        { afterHours: 5, escalateTo: { type: 'user', userId: 'early' } },
      ],
    });
    const i = await e.submit({
      templateName: 'HRS',
      documentId: 'h-1',
      documentType: 'hrs',
      submittedBy: 'buyer',
      data: {},
    });
    expect(i.levels[0]?.escalationDueAt?.getTime()).toBe(clock.now().getTime() + 5 * HOUR);
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

  it('falls back to the live template config when the snapshot predates escalation', async () => {
    const e = new ApprovalEngine({ adapter: new MemoryAdapter(), clock });
    await e.defineTemplate({
      name: 'RETRO',
      documentType: 'retro',
      levels: [
        {
          level: 1,
          name: 'L',
          approvers: [{ type: 'user', userId: 'a' }],
          mode: 'any',
          escalationAfterDays: 1,
        },
      ],
    });
    // Submitted before escalation existed on the template: the instance's
    // templateSnapshot carries escalation: undefined.
    const i = await e.submit({
      templateName: 'RETRO',
      documentId: 'retro-1',
      documentType: 'retro',
      submittedBy: 'buyer',
      data: {},
    });

    await e.updateTemplate({
      name: 'RETRO',
      documentType: 'retro',
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

    await (
      e as unknown as {
        escalateInternal: (i: string, by: string, c: undefined, l?: number) => Promise<unknown>;
      }
    ).escalateInternal(i.id, 'system', undefined, 1);

    expect((await e.getInstance(i.id)).levels[0]?.approverIds).toEqual(['a', 'boss']);
  });

  it('falls back to the live template ladder when the snapshot predates escalationSteps', async () => {
    const e = new ApprovalEngine({ adapter: new MemoryAdapter(), clock });
    await e.defineTemplate({
      name: 'LADDER-RETRO',
      documentType: 'ladder-retro',
      levels: [{ level: 1, name: 'L', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' }],
    });
    // Submitted before escalationSteps existed on the template: the
    // instance's templateSnapshot carries escalationSteps: undefined.
    const i = await e.submit({
      templateName: 'LADDER-RETRO',
      documentId: 'ladder-retro-1',
      documentType: 'ladder-retro',
      submittedBy: 'buyer',
      data: {},
    });

    await e.updateTemplate({
      name: 'LADDER-RETRO',
      documentType: 'ladder-retro',
      levels: [{ level: 1, name: 'L', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' }],
      escalationSteps: [{ afterDays: 1, escalateTo: { type: 'user', userId: 'boss' } }],
    });

    await (
      e as unknown as {
        escalateInternal: (i: string, by: string, c: undefined, l?: number) => Promise<unknown>;
      }
    ).escalateInternal(i.id, 'system', undefined, 1);

    expect((await e.getInstance(i.id)).levels[0]?.approverIds).toEqual(['a', 'boss']);
  });

  it('does not add approvers or advance the rung when escalation resolves to the submitter only', async () => {
    const e = new ApprovalEngine({ adapter: new MemoryAdapter(), clock });
    await e.defineTemplate({
      name: 'SELF',
      documentType: 'self',
      levels: [{ level: 1, name: 'L', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' }],
      escalationSteps: [{ afterDays: 1, escalateTo: { type: 'user', userId: 'buyer' } }],
    });
    const i = await e.submit({
      templateName: 'SELF',
      documentId: 'self-1',
      documentType: 'self',
      submittedBy: 'buyer',
      data: {},
    });
    const s = new EscalationScheduler({
      adapter: (e as unknown as { opts: { adapter: MemoryAdapter } }).opts.adapter,
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
    const after = await e.getInstance(i.id);
    expect(after.levels[0]?.approverIds).toEqual(['a']);
    expect(after.levels[0]?.escalationStep).toBe(0);
  });

  it('is a no-op when the instance is no longer pending', async () => {
    const i = await submit();
    await engine.approve(i.id, { approverId: 'mgr' });

    const after = await (
      engine as unknown as {
        escalateInternal: (i: string, by: string, c: undefined, l?: number) => Promise<{
          status: string;
        }>;
      }
    ).escalateInternal(i.id, 'system', undefined, 1);

    expect(after.status).toBe('approved');
    const history = await engine.getHistory(i.id);
    expect(history.some((h) => h.action === 'escalated')).toBe(false);
  });

  it('falls back to the currently open level when the given levelNumber no longer exists', async () => {
    const i = await submit();

    // Simulates the scheduler having scanned a level that updateData()
    // later removed before escalateInternal actually ran.
    const after = await (
      engine as unknown as {
        escalateInternal: (
          i: string,
          by: string,
          c: undefined,
          l?: number,
        ) => Promise<{ levels: { level: number; approverIds: string[] }[] }>;
      }
    ).escalateInternal(i.id, 'system', undefined, 99);

    expect(after.levels.find((l) => l.level === 1)?.approverIds).toEqual(['mgr', 'director']);
  });

  it('does not escalate when neither the ladder nor a legacy config has an escalation target', async () => {
    const e = new ApprovalEngine({ adapter: new MemoryAdapter(), clock });
    await e.defineTemplate({
      name: 'NO-ESCALATION',
      documentType: 'no-escalation',
      levels: [{ level: 1, name: 'L', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' }],
    });
    const i = await e.submit({
      templateName: 'NO-ESCALATION',
      documentId: 'ne-1',
      documentType: 'no-escalation',
      submittedBy: 'buyer',
      data: {},
    });

    const after = await (
      e as unknown as {
        escalateInternal: (
          i: string,
          by: string,
          c: undefined,
          l?: number,
        ) => Promise<{ levels: { escalationStep?: number; approverIds: string[] }[] }>;
      }
    ).escalateInternal(i.id, 'system', undefined, 1);

    expect(after.levels[0]?.approverIds).toEqual(['a']);
    expect(after.levels[0]?.escalationStep).toBe(0);
  });

  it('sorts a rung with neither delay field as a zero-delay rung, in either position', async () => {
    // Neither afterDays nor afterHours is required on an EscalationStep, so a
    // rung can declare only escalateTo. The sort comparator's inner "?? 0"
    // fallback is what keeps that rung orderable against the others,
    // regardless of which side of the comparison it lands on.
    const e = new ApprovalEngine({ adapter: new MemoryAdapter(), clock });
    await e.defineTemplate({
      name: 'ZERO-DELAY-FIRST',
      documentType: 'zero-delay-first',
      levels: [{ level: 1, name: 'L', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' }],
      escalationSteps: [
        { escalateTo: { type: 'user', userId: 'immediate' } },
        { afterDays: 3, escalateTo: { type: 'user', userId: 'late' } },
      ],
    });
    const first = await e.submit({
      templateName: 'ZERO-DELAY-FIRST',
      documentId: 'zd-1',
      documentType: 'zero-delay-first',
      submittedBy: 'buyer',
      data: {},
    });

    await e.defineTemplate({
      name: 'ZERO-DELAY-SECOND',
      documentType: 'zero-delay-second',
      levels: [{ level: 1, name: 'L', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' }],
      escalationSteps: [
        { afterDays: 3, escalateTo: { type: 'user', userId: 'late' } },
        { escalateTo: { type: 'user', userId: 'immediate' } },
      ],
    });
    const second = await e.submit({
      templateName: 'ZERO-DELAY-SECOND',
      documentId: 'zd-2',
      documentType: 'zero-delay-second',
      submittedBy: 'buyer',
      data: {},
    });

    // The delay-less rung sorts first either way, but has no due date of its
    // own, so the level opens with none armed yet.
    for (const i of [first, second]) {
      expect(i.levels[0]?.escalationDueAt).toBeUndefined();
      expect(i.levels[0]?.escalationStep).toBe(0);
    }
  });

  it("escalationLadder's own sort orders an hours-based rung ahead of a days-based one, with a delay-less rung first", async () => {
    // firstRungOf (covered above) and escalationLadder each carry an
    // identically-shaped comparator but are separate call sites; closing one
    // does not close the other. This drives escalationLadder's directly, via
    // escalateInternal, with a mix that also exercises the outer
    // `afterHours ?? ...` branch's "value present" side (every other test in
    // this file leaves afterHours undefined throughout the whole ladder).
    const e = new ApprovalEngine({ adapter: new MemoryAdapter(), clock });
    await e.defineTemplate({
      name: 'MIXED-LADDER',
      documentType: 'mixed-ladder',
      levels: [{ level: 1, name: 'L', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' }],
      escalationSteps: [
        { afterDays: 3, escalateTo: { type: 'user', userId: 'late' } },
        { afterHours: 5, escalateTo: { type: 'user', userId: 'soon' } },
        { escalateTo: { type: 'user', userId: 'immediate' } },
      ],
    });
    const i = await e.submit({
      templateName: 'MIXED-LADDER',
      documentId: 'ml-1',
      documentType: 'mixed-ladder',
      submittedBy: 'buyer',
      data: {},
    });

    const escalateOnce = (targetLevel: number) =>
      (
        e as unknown as {
          escalateInternal: (
            id: string,
            by: string,
            c: undefined,
            l?: number,
          ) => Promise<{ auditLog: { action: string; delegateTo?: string }[] }>;
        }
      ).escalateInternal(i.id, 'system', undefined, targetLevel);

    await escalateOnce(1);
    await escalateOnce(1);
    await escalateOnce(1);

    const targets = (await e.getInstance(i.id)).auditLog
      .filter((a) => a.action === 'escalated')
      .map((a) => a.delegateTo);
    expect(targets).toEqual(['immediate', 'soon', 'late']);
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
