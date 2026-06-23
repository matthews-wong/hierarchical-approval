import { describe, it, expect } from 'vitest';
import { weekendCalendar } from '../../src/utils/BusinessCalendar.js';

describe('weekendCalendar', () => {
  it('skips weekends when adding business days', () => {
    const cal = weekendCalendar();
    // Friday 2026-06-19 + 1 business day -> Monday 2026-06-22
    const friday = new Date('2026-06-19T09:00:00');
    const result = cal.addBusinessDays(friday, 1);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(5); // June
    expect(result.getDate()).toBe(22); // Monday
  });

  it('counts plain business days within a week', () => {
    const cal = weekendCalendar();
    // Monday 2026-06-22 + 3 business days -> Thursday 2026-06-25
    const monday = new Date('2026-06-22T09:00:00');
    const result = cal.addBusinessDays(monday, 3);
    expect(result.getDate()).toBe(25);
  });

  it('skips configured holidays', () => {
    const cal = weekendCalendar({ holidays: [new Date('2026-06-23T00:00:00')] });
    // Monday 2026-06-22 + 1 business day, but Tue 06-23 is a holiday -> Wed 06-24
    const monday = new Date('2026-06-22T09:00:00');
    const result = cal.addBusinessDays(monday, 1);
    expect(result.getDate()).toBe(24);
  });

  it('supports custom weekend days (Fri/Sat)', () => {
    const cal = weekendCalendar({ weekendDays: [5, 6] });
    // Thursday 2026-06-18 + 1 business day -> Sunday 2026-06-21 (skips Fri/Sat)
    const thursday = new Date('2026-06-18T09:00:00');
    const result = cal.addBusinessDays(thursday, 1);
    expect(result.getDate()).toBe(21);
  });

  it('returns the original instant for non-positive day counts', () => {
    const cal = weekendCalendar();
    const d = new Date('2026-06-22T09:00:00');
    expect(cal.addBusinessDays(d, 0).getTime()).toBe(d.getTime());
  });
});
