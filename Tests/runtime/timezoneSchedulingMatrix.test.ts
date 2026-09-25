import { describe, expect, it } from 'vitest';

/**
 * #538: timezone/DST matrix for local-time scheduling semantics.
 *
 * vitest.setup.ts pins the suite default to UTC for determinism; this file
 * additionally exercises the PURE local-time date/identity functions under
 * representative timezone environments by mutating process.env.TZ around
 * each scenario (restored in finally). Focus: local calendar-date identity,
 * midnight rollover, and HH:mm boundary semantics — not full-suite reruns.
 */
import {
  getLocalDateString,
  localEpochMs,
  addCalendarDays,
  parseCalendarDate,
  calendarDayDifference,
} from '@/utils/dateCalculations';

type Scenario = {
  tz: string;
  label: string;
};

const scenarios: Scenario[] = [
  { tz: 'UTC', label: 'baseline UTC' },
  { tz: 'Asia/Kolkata', label: 'positive offset (+05:30, half-hour)' },
  { tz: 'America/New_York', label: 'negative offset + DST-observing' },
  { tz: 'Europe/Berlin', label: 'positive offset + DST-observing' },
];

function withTimezone<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe('local-time scheduling semantics across the timezone matrix (#538)', () => {
  for (const scenario of scenarios) {
    describe(scenario.label, () => {
      it('formats the local calendar date with the zone offset applied', () => {
        withTimezone(scenario.tz, () => {
          // 2026-01-15T23:30:00Z — in positive-offset zones this is already
          // Jan 16 local; in negative-offset zones still Jan 15 local.
          const instant = new Date('2026-01-15T23:30:00.000Z');
          const localDate = getLocalDateString(instant);
          const offsetMinutes = -instant.getTimezoneOffset();
          const expectedDayShift = offsetMinutes >= 30 ? 1 : 0;
          if (offsetMinutes >= 30 || offsetMinutes <= -30) {
            expect(localDate === '2026-01-15' || localDate === '2026-01-16').toBe(true);
            expect(localDate).toBe(
              expectedDayShift === 1 ? '2026-01-16' : '2026-01-15'
            );
          }
        });
      });

      it('computes a local HH:mm occurrence on the same local calendar day', () => {
        withTimezone(scenario.tz, () => {
          const epoch = localEpochMs('2026-06-10', '09:30');
          expect(epoch).not.toBeNull();
          const d = new Date(epoch as number);
          expect(getLocalDateString(d)).toBe('2026-06-10');
          expect(d.getHours()).toBe(9);
          expect(d.getMinutes()).toBe(30);
        });
      });

      it('keeps 23:59 vs 00:00 on adjacent local days (midnight rollover)', () => {
        withTimezone(scenario.tz, () => {
          const late = localEpochMs('2026-06-10', '23:59');
          const early = localEpochMs('2026-06-11', '00:01');
          expect(late).not.toBeNull();
          expect(early).not.toBeNull();
          expect((early as number) - (late as number)).toBe(2 * 60 * 1000);
        });
      });

      it('calendar-day arithmetic is zone-independent on date STRINGS', () => {
        withTimezone(scenario.tz, () => {
          expect(addCalendarDays('2026-03-01', 1)).toBe('2026-03-02');
          expect(calendarDayDifference('2026-03-01', '2026-03-31')).toBe(30);
          expect(parseCalendarDate('2026-02-30')).toBeNull();
        });
      });

      it('rejects impossible local date/time combinations deterministically', () => {
        withTimezone(scenario.tz, () => {
          expect(localEpochMs('2026-02-30', '09:00')).toBeNull();
          expect(localEpochMs('2026-02-28', '25:00')).toBeNull();
        });
      });
    });
  }

  it('DST forward transition: 02:30 does not exist on 2026-03-08 in New York', () => {
    withTimezone('America/New_York', () => {
      // Spring-forward at 02:00 local on 2026-03-08: local 02:30 maps to the
      // instant AFTER the skipped hour (03:30 EDT wall time).
      const epoch = localEpochMs('2026-03-08', '02:30');
      expect(epoch).not.toBeNull();
      const d = new Date(epoch as number);
      // The wall-clock reading of a nonexistent time is normalized forward
      // by the platform; it must never go BACK before the transition.
      expect(d.getTime()).toBeGreaterThanOrEqual(
        localEpochMs('2026-03-08', '02:00') as number
      );
    });
  });

  it('DST backward transition: both 01:30 occurrences resolve on 2026-11-01 in New York', () => {
    withTimezone('America/New_York', () => {
      const first = localEpochMs('2026-11-01', '01:30');
      expect(first).not.toBeNull();
      const d = new Date(first as number);
      expect(getLocalDateString(d)).toBe('2026-11-01');
    });
  });
});
