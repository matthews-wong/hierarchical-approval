/**
 * Computes deadline dates from a number of days. The default engine behaviour
 * treats day offsets (escalationAfterDays, slaDeadlineDays) as plain calendar
 * days; provide a BusinessCalendar on ApprovalEngine to interpret them as
 * business days instead — skipping weekends and configured holidays.
 */
export interface BusinessCalendar {
  /**
   * Return the date that is `days` business days after `from`. A fractional
   * `days` adds whole business days first, then the remaining fraction as
   * elapsed clock time within the resulting business day.
   */
  addBusinessDays(from: Date, days: number): Date;
}

const DAY_MS = 86_400_000;

function dayKey(d: Date): string {
  // Local-date key (YYYY-MM-DD) for holiday comparison.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface WeekendCalendarOptions {
  /** Dates to treat as non-working days (compared by local calendar date). */
  holidays?: Date[];
  /**
   * Weekday numbers (0 = Sunday … 6 = Saturday) that count as weekend.
   * Defaults to [0, 6]. Override for regions with different work weeks
   * (e.g. [5, 6] for a Friday/Saturday weekend).
   */
  weekendDays?: number[];
}

/**
 * A calendar that skips weekends (Sat/Sun by default) and any supplied
 * holidays. Day arithmetic is performed in the host's local timezone.
 */
export function weekendCalendar(options: WeekendCalendarOptions = {}): BusinessCalendar {
  const weekend = new Set(options.weekendDays ?? [0, 6]);
  const holidays = new Set((options.holidays ?? []).map(dayKey));

  const isBusinessDay = (d: Date): boolean => !weekend.has(d.getDay()) && !holidays.has(dayKey(d));

  return {
    addBusinessDays(from: Date, days: number): Date {
      if (days <= 0 || Number.isNaN(days)) return new Date(from.getTime());

      const whole = Math.floor(days);
      const fraction = days - whole;

      const cursor = new Date(from.getTime());
      let remaining = whole;
      // Advance one calendar day at a time, counting only business days.
      while (remaining > 0) {
        cursor.setDate(cursor.getDate() + 1);
        if (isBusinessDay(cursor)) remaining--;
      }

      return fraction > 0 ? new Date(cursor.getTime() + fraction * DAY_MS) : cursor;
    },
  };
}
