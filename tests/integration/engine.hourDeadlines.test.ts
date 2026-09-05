import { describe, it, expect } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { businessHoursCalendar, weekendCalendar } from '../../src/utils/BusinessCalendar.js';
import type { Clock } from '../../src/utils/Clock.js';

/** Monday 2026-01-05 at 16:00 local. */
const MONDAY_1600 = new Date(2026, 0, 5, 16, 0, 0, 0);
const fixedClock = (d: Date): Clock => ({ now: () => new Date(d) });

const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const template = (extra: Record<string, unknown>, levelExtra: Record<string, unknown> = {}) => ({
  name: 'PO',
  documentType: 'purchase_order',
  levels: [
    {
      level: 1,
      name: 'Manager',
      approvers: [{ type: 'user' as const, userId: 'mgr' }],
      mode: 'any' as const,
      ...levelExtra,
    },
  ],
  ...extra,
});

const submit = (engine: ApprovalEngine) =>
  engine.submit({
    templateName: 'PO',
    documentId: `d-${Math.random()}`,
    documentType: 'purchase_order',
    submittedBy: 'buyer',
    data: {},
  });

describe('hour-based deadlines', () => {
  it('counts escalation in working hours, skipping the evening', async () => {
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      clock: fixedClock(MONDAY_1600),
      calendar: businessHoursCalendar({ workdayStartHour: 9, workdayEndHour: 17 }),
    });
    await engine.defineTemplate(template({}, { escalationAfterHours: 4 }));

    const i = await submit(engine);
    // 1h left on Monday, then 3h on Tuesday.
    expect(fmt(i.levels[0]!.escalationDueAt!)).toBe('2026-01-06 12:00');
  });

  it('counts the SLA in working hours too', async () => {
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      clock: fixedClock(MONDAY_1600),
      calendar: businessHoursCalendar({ workdayStartHour: 9, workdayEndHour: 17 }),
    });
    await engine.defineTemplate(template({ slaDeadlineHours: 4 }));
    const i = await submit(engine);
    expect(fmt(i.slaDeadlineAt!)).toBe('2026-01-06 12:00');
  });

  it('falls back to elapsed clock time when the calendar has no hour support', async () => {
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      clock: fixedClock(MONDAY_1600),
      // weekendCalendar knows days only — no addBusinessHours.
      calendar: weekendCalendar(),
    });
    await engine.defineTemplate(template({}, { escalationAfterHours: 4 }));
    const i = await submit(engine);
    // Straight +4h rather than pretending the calendar applied.
    expect(fmt(i.levels[0]!.escalationDueAt!)).toBe('2026-01-05 20:00');
  });

  it('falls back to elapsed clock time with no calendar at all', async () => {
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      clock: fixedClock(MONDAY_1600),
    });
    await engine.defineTemplate(template({}, { escalationAfterHours: 2 }));
    const i = await submit(engine);
    expect(fmt(i.levels[0]!.escalationDueAt!)).toBe('2026-01-05 18:00');
  });

  it('leaves day-based deadlines working as before', async () => {
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      clock: fixedClock(MONDAY_1600),
    });
    await engine.defineTemplate(template({}, { escalationAfterDays: 2 }));
    const i = await submit(engine);
    expect(fmt(i.levels[0]!.escalationDueAt!)).toBe('2026-01-07 16:00');
  });

  describe('validation', () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });

    it('rejects a level setting both days and hours', () => {
      const r = engine.validateTemplate(
        template({}, { escalationAfterDays: 1, escalationAfterHours: 4 }),
      );
      expect(r.valid).toBe(false);
      expect(r.errors.map((e) => e.message).join(' ')).toMatch(/pick one/);
    });

    it('rejects a template setting both SLA units', () => {
      const r = engine.validateTemplate(template({ slaDeadlineDays: 1, slaDeadlineHours: 4 }));
      expect(r.valid).toBe(false);
    });

    it('rejects non-positive hour values', () => {
      expect(engine.validateTemplate(template({}, { escalationAfterHours: 0 })).valid).toBe(false);
      expect(engine.validateTemplate(template({ slaDeadlineHours: -1 })).valid).toBe(false);
    });

    it('rejects a non-positive escalationAfterDays', () => {
      const r = engine.validateTemplate(template({}, { escalationAfterDays: 0 }));
      expect(r.valid).toBe(false);
      expect(r.errors.map((e) => e.message).join(' ')).toMatch(/escalationAfterDays must be a positive number/);
    });

    it('accepts hours on their own', () => {
      expect(
        engine.validateTemplate(template({ slaDeadlineHours: 4 }, { escalationAfterHours: 2 }))
          .valid,
      ).toBe(true);
    });
  });
});
