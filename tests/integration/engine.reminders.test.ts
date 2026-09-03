import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { Clock } from '../../src/utils/Clock.js';
import type { ReminderEvent } from '../../src/types/index.js';

/** A clock the test drives by hand, so reminder deadlines are deterministic. */
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

describe('approval reminders', () => {
  let clock: TestClock;
  let adapter: MemoryAdapter;
  let engine: ApprovalEngine;
  let events: ReminderEvent[];

  beforeEach(() => {
    clock = new TestClock();
    adapter = new MemoryAdapter();
    engine = new ApprovalEngine({ adapter, clock });
    events = [];
    engine.on('approval:reminder', (e) => events.push(e));
  });

  const define = async (level: Record<string, unknown>) =>
    engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        {
          level: 1,
          name: 'Manager',
          approvers: [{ type: 'user' as const, userId: 'mgr' }],
          mode: 'any' as const,
          ...level,
        },
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

  /** Run one scheduler tick at the clock's current time. */
  const tick = async () => {
    const overdue = await adapter.getOverdueInstances('default', clock.now());
    for (const inst of overdue) {
      for (const lvl of inst.levels) {
        if (
          lvl.status === 'pending' &&
          lvl.reminderDueAt &&
          new Date(lvl.reminderDueAt) <= clock.now()
        ) {
          await (
            engine as unknown as {
              sendReminder: (id: string, n: number) => Promise<void>;
            }
          ).sendReminder(inst.id, lvl.level);
        }
      }
    }
  };

  it('schedules the first reminder when the level opens', async () => {
    await define({ reminderAfterDays: 2 });
    const i = await submit();
    expect(i.levels[0]?.reminderDueAt?.getTime()).toBe(clock.now().getTime() + 2 * DAY);
    expect(i.levels[0]?.remindersSent).toBe(0);
  });

  it('does not fire before the deadline', async () => {
    await define({ reminderAfterDays: 2 });
    await submit();
    clock.advanceDays(1);
    await tick();
    expect(events).toHaveLength(0);
  });

  it('fires once at the deadline, naming the pending approvers', async () => {
    await define({ reminderAfterDays: 2 });
    const i = await submit();
    clock.advanceDays(2);
    await tick();

    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe(1);
    expect(events[0]?.reminderNumber).toBe(1);
    expect(events[0]?.recipients).toEqual(['mgr']);

    const after = await engine.getInstance(i.id);
    expect(after.levels[0]?.remindersSent).toBe(1);
    // No repeat configured, so it stops after one.
    expect(after.levels[0]?.reminderDueAt).toBeUndefined();
  });

  it('repeats on reminderEveryDays up to the cap', async () => {
    await define({ reminderAfterDays: 2, reminderEveryDays: 1, maxReminders: 3 });
    const i = await submit();

    clock.advanceDays(2);
    await tick();
    clock.advanceDays(1);
    await tick();
    clock.advanceDays(1);
    await tick();
    clock.advanceDays(1);
    await tick(); // beyond the cap — must not fire

    expect(events.map((e) => e.reminderNumber)).toEqual([1, 2, 3]);
    const after = await engine.getInstance(i.id);
    expect(after.levels[0]?.remindersSent).toBe(3);
    expect(after.levels[0]?.reminderDueAt).toBeUndefined();
  });

  it('defaults the cap to 3 when maxReminders is omitted', async () => {
    await define({ reminderAfterDays: 1, reminderEveryDays: 1 });
    await submit();
    for (let d = 0; d < 6; d++) {
      clock.advanceDays(1);
      await tick();
    }
    expect(events).toHaveLength(3);
  });

  it('stops reminding once the level is approved', async () => {
    await define({ reminderAfterDays: 1, reminderEveryDays: 1, maxReminders: 5 });
    const i = await submit();
    clock.advanceDays(1);
    await tick();
    expect(events).toHaveLength(1);

    await engine.approve(i.id, { approverId: 'mgr' });
    clock.advanceDays(5);
    await tick();
    expect(events).toHaveLength(1);
  });

  it('excludes approvers who already voted on a quorum level', async () => {
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        {
          level: 1,
          name: 'Board',
          mode: 'quorum',
          minApprovals: 3,
          reminderAfterDays: 1,
          approvers: [
            { type: 'user' as const, userId: 'd1' },
            { type: 'user' as const, userId: 'd2' },
            { type: 'user' as const, userId: 'd3' },
          ],
        },
      ],
    });
    const i = await submit();
    await engine.approve(i.id, { approverId: 'd1' });
    clock.advanceDays(1);
    await tick();
    expect(events[0]?.recipients).toEqual(['d2', 'd3']);
  });

  it('records a reminded audit entry', async () => {
    await define({ reminderAfterDays: 1 });
    const i = await submit();
    clock.advanceDays(1);
    await tick();
    const history = await engine.getHistory(i.id);
    const entry = history.find((h) => h.action === 'reminded');
    expect(entry?.actorId).toBe('system');
    expect(entry?.newValue?.['reminderNumber']).toBe(1);
  });

  describe('validation', () => {
    const withLevel = (extra: Record<string, unknown>) => ({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        {
          level: 1,
          name: 'Manager',
          approvers: [{ type: 'user' as const, userId: 'mgr' }],
          mode: 'any' as const,
          ...extra,
        },
      ],
    });

    it('rejects a non-positive reminderAfterDays', () => {
      expect(engine.validateTemplate(withLevel({ reminderAfterDays: 0 })).valid).toBe(false);
    });

    it('rejects a non-integer maxReminders', () => {
      expect(
        engine.validateTemplate(withLevel({ reminderAfterDays: 1, maxReminders: 1.5 })).valid,
      ).toBe(false);
    });

    it('rejects reminderEveryDays without reminderAfterDays, which would never fire', () => {
      const r = engine.validateTemplate(withLevel({ reminderEveryDays: 2 }));
      expect(r.valid).toBe(false);
      expect(r.errors.map((e) => e.message).join(' ')).toMatch(/no reminder would ever be sent/);
    });

    it('accepts a well-formed reminder config', () => {
      expect(
        engine.validateTemplate(
          withLevel({ reminderAfterDays: 2, reminderEveryDays: 1, maxReminders: 4 }),
        ).valid,
      ).toBe(true);
    });
  });
});
