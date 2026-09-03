import { describe, it, expect } from 'vitest';
import { businessHoursCalendar } from '../../src/utils/BusinessCalendar.js';

/** Local-time date helper, matching the calendar's own timezone handling. */
const at = (iso: string) => new Date(iso);
const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('businessHoursCalendar', () => {
  const cal = businessHoursCalendar({ workdayStartHour: 9, workdayEndHour: 17 });

  // 2026-01-05 is a Monday.
  it('advances within a single working day', () => {
    expect(fmt(cal.addBusinessHours(at('2026-01-05T10:00:00'), 3))).toBe('2026-01-05 13:00');
  });

  it('rolls over to the next working day', () => {
    // 16:00 Monday + 4h = 1h Monday + 3h Tuesday -> 12:00 Tuesday
    expect(fmt(cal.addBusinessHours(at('2026-01-05T16:00:00'), 4))).toBe('2026-01-06 12:00');
  });

  it('skips the weekend', () => {
    // Friday 16:00 + 4h -> Monday 12:00
    expect(fmt(cal.addBusinessHours(at('2026-01-09T16:00:00'), 4))).toBe('2026-01-12 12:00');
  });

  it('starts counting from the next working moment when submitted before work', () => {
    // 06:00 Monday is not working time; the clock starts at 09:00.
    expect(fmt(cal.addBusinessHours(at('2026-01-05T06:00:00'), 2))).toBe('2026-01-05 11:00');
  });

  it('starts counting the next morning when submitted after work', () => {
    expect(fmt(cal.addBusinessHours(at('2026-01-05T20:00:00'), 2))).toBe('2026-01-06 11:00');
  });

  it('starts counting on Monday when submitted at the weekend', () => {
    // Saturday.
    expect(fmt(cal.addBusinessHours(at('2026-01-10T12:00:00'), 1))).toBe('2026-01-12 10:00');
  });

  it('skips a configured holiday', () => {
    const withHoliday = businessHoursCalendar({
      workdayStartHour: 9,
      workdayEndHour: 17,
      holidays: [at('2026-01-06T00:00:00')],
    });
    // Monday 16:00 + 4h: 1h Monday, Tuesday is a holiday, 3h Wednesday.
    expect(fmt(withHoliday.addBusinessHours(at('2026-01-05T16:00:00'), 4))).toBe(
      '2026-01-07 12:00',
    );
  });

  it('spans several working days', () => {
    // 8h in a day; 20h from Monday 09:00 -> Wednesday 13:00
    expect(fmt(cal.addBusinessHours(at('2026-01-05T09:00:00'), 20))).toBe('2026-01-07 13:00');
  });

  it('handles a fractional hour', () => {
    expect(fmt(cal.addBusinessHours(at('2026-01-05T09:00:00'), 1.5))).toBe('2026-01-05 10:30');
  });

  it('lands exactly on the end of the working day', () => {
    expect(fmt(cal.addBusinessHours(at('2026-01-05T09:00:00'), 8))).toBe('2026-01-05 17:00');
  });

  it('supports a non-standard weekend', () => {
    // Friday/Saturday weekend: Thursday 16:00 + 4h -> Sunday 12:00
    const gulf = businessHoursCalendar({
      workdayStartHour: 9,
      workdayEndHour: 17,
      weekendDays: [5, 6],
    });
    expect(fmt(gulf.addBusinessHours(at('2026-01-08T16:00:00'), 4))).toBe('2026-01-11 12:00');
  });

  it('returns the input for a non-positive or NaN amount', () => {
    const from = at('2026-01-05T10:00:00');
    expect(cal.addBusinessHours(from, 0).getTime()).toBe(from.getTime());
    expect(cal.addBusinessHours(from, -1).getTime()).toBe(from.getTime());
    expect(cal.addBusinessHours(from, Number.NaN).getTime()).toBe(from.getTime());
  });

  it('still does business-day arithmetic', () => {
    expect(fmt(cal.addBusinessDays(at('2026-01-09T10:00:00'), 1))).toBe('2026-01-12 10:00');
  });

  it('rejects a workday that ends before it starts', () => {
    expect(() => businessHoursCalendar({ workdayStartHour: 17, workdayEndHour: 9 })).toThrow(
      /must be greater than workdayStartHour/,
    );
  });

  it('refuses a calendar where no day is ever a working day', () => {
    const never = businessHoursCalendar({ weekendDays: [0, 1, 2, 3, 4, 5, 6] });
    expect(() => never.addBusinessHours(at('2026-01-05T10:00:00'), 1)).toThrow(
      /no working day found/,
    );
  });
});
