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
  /**
   * Return the date that is `hours` **working** hours after `from`, skipping
   * non-working hours, weekends and holidays.
   *
   * Optional. A calendar that only knows about whole days — such as
   * {@link weekendCalendar} — omits it, and the engine falls back to elapsed
   * clock time for any hour-based deadline rather than silently pretending the
   * calendar was applied.
   */
  addBusinessHours?(from: Date, hours: number): Date;
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

const HOUR_MS = 3_600_000;

export interface BusinessHoursCalendarOptions extends WeekendCalendarOptions {
  /** First working hour of the day, 0-23 in local time. Defaults to 9. */
  workdayStartHour?: number;
  /**
   * Hour at which the working day ends, 0-24 in local time. Defaults to 17.
   * Must be greater than {@link workdayStartHour}.
   */
  workdayEndHour?: number;
}

/**
 * A calendar that counts only working hours within working days.
 *
 * SLAs in an ERP are quoted in hours far more often than days — "respond within
 * four working hours" — and counting those as elapsed clock time makes a
 * request submitted at 16:00 on a Friday overdue before anybody could have
 * looked at it. This advances the clock only through the configured working
 * window, skipping evenings, weekends and holidays.
 *
 * A `from` outside working hours is first moved forward to the next working
 * moment, so a deadline never starts counting from a time nobody was at work.
 *
 * Arithmetic is performed in the host's local timezone, matching
 * {@link weekendCalendar}.
 *
 * @example
 * ```ts
 * const calendar = businessHoursCalendar({ workdayStartHour: 9, workdayEndHour: 17 });
 * // Friday 16:00 + 4 working hours -> Monday 12:00
 * ```
 */
export function businessHoursCalendar(
  options: BusinessHoursCalendarOptions = {},
): Required<Pick<BusinessCalendar, 'addBusinessDays' | 'addBusinessHours'>> {
  const startHour = options.workdayStartHour ?? 9;
  const endHour = options.workdayEndHour ?? 17;
  if (!(endHour > startHour)) {
    throw new Error(
      `businessHoursCalendar: workdayEndHour (${endHour}) must be greater than workdayStartHour (${startHour}).`,
    );
  }

  const weekend = new Set(options.weekendDays ?? [0, 6]);
  const holidays = new Set((options.holidays ?? []).map(dayKey));
  const isBusinessDay = (d: Date): boolean => !weekend.has(d.getDay()) && !holidays.has(dayKey(d));

  const startOfWorkday = (d: Date): Date => {
    const out = new Date(d.getTime());
    out.setHours(startHour, 0, 0, 0);
    return out;
  };
  const endOfWorkday = (d: Date): Date => {
    const out = new Date(d.getTime());
    out.setHours(endHour, 0, 0, 0);
    return out;
  };

  /** Move to the next moment that is inside a working window. */
  const toWorkingMoment = (from: Date): Date => {
    const cursor = new Date(from.getTime());
    for (let guard = 0; guard < 3660; guard++) {
      if (!isBusinessDay(cursor)) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(startHour, 0, 0, 0);
        continue;
      }
      if (cursor.getTime() < startOfWorkday(cursor).getTime()) return startOfWorkday(cursor);
      if (cursor.getTime() >= endOfWorkday(cursor).getTime()) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(startHour, 0, 0, 0);
        continue;
      }
      return cursor;
    }
    // Every day for ten years was a holiday; a caller misconfigured the calendar.
    throw new Error(
      'businessHoursCalendar: no working day found within 10 years of the start date.',
    );
  };

  const base = weekendCalendar(options);

  return {
    addBusinessDays: base.addBusinessDays,

    addBusinessHours(from: Date, hours: number): Date {
      if (hours <= 0 || Number.isNaN(hours)) return new Date(from.getTime());

      let cursor = toWorkingMoment(from);
      let remainingMs = Math.round(hours * HOUR_MS);

      for (let guard = 0; remainingMs > 0 && guard < 3660; guard++) {
        const dayEnd = endOfWorkday(cursor);
        const availableMs = dayEnd.getTime() - cursor.getTime();

        if (remainingMs <= availableMs) {
          return new Date(cursor.getTime() + remainingMs);
        }
        remainingMs -= availableMs;
        // Next working day, from its first working minute.
        const next = new Date(cursor.getTime());
        next.setDate(next.getDate() + 1);
        next.setHours(startHour, 0, 0, 0);
        cursor = toWorkingMoment(next);
      }

      throw new Error(
        `businessHoursCalendar: ${hours} working hours could not be scheduled within 10 years — check weekendDays and holidays.`,
      );
    },
  };
}
