import { describe, it, expect } from 'vitest';
import {
  getDoseScheduleForUI,
  resizeDoseSchedule,
  sortDoseSchedule,
  totalDailyAmount,
  validateAndNormalizeDoseSchedule,
  isValidDoseTime,
  MAX_DOSES_PER_DAY,
  DEFAULT_DOSE_TIMES,
} from './doseSchedule';
import type { MedicationDose } from '../types';

function dose(partial: Partial<MedicationDose> & { amount: number; time: string }): MedicationDose {
  return {
    id: partial.id || `dose-${partial.time}-${partial.amount}`,
    amount: partial.amount,
    time: partial.time,
  };
}

function timesAreChronological(schedule: MedicationDose[]): boolean {
  for (let i = 1; i < schedule.length; i++) {
    if (timeMinutes(schedule[i].time) < timeMinutes(schedule[i - 1].time)) return false;
  }
  return true;
}

function timeMinutes(t: string): number {
  const [h, m] = t.split(':').map((n) => parseInt(n, 10));
  return h * 60 + m;
}

describe('doseSchedule helpers', () => {
  // ── Legacy compatibility ──────────────────────────────────────────
  it('maps legacy medication to a one-item schedule', () => {
    const schedule = getDoseScheduleForUI({
      dailyDose: 2,
      reminderTime: '20:00',
    });
    expect(schedule).toHaveLength(1);
    expect(schedule[0].amount).toBe(2);
    expect(schedule[0].time).toBe('20:00');
  });

  it('uses 09:00 when legacy reminderTime is missing', () => {
    const schedule = getDoseScheduleForUI({ dailyDose: 1 });
    expect(schedule).toHaveLength(1);
    expect(schedule[0].time).toBe('09:00');
    expect(schedule[0].amount).toBe(1);
  });

  it('uses 09:00 when legacy reminderTime is invalid', () => {
    const schedule = getDoseScheduleForUI({
      dailyDose: 1,
      reminderTime: 'not-a-time',
    });
    expect(schedule).toHaveLength(1);
    expect(schedule[0].time).toBe('09:00');
  });

  // ── Source of truth: doseSchedule.length ──────────────────────────
  it('prefers stored doseSchedule when present (ignores conflicting dosesPerDay)', () => {
    // Inconsistent: dosesPerDay=3 but only 2 schedule rows.
    // doseSchedule.length is authoritative.
    const schedule = getDoseScheduleForUI({
      dailyDose: 99,
      reminderTime: '01:00',
      doseSchedule: [
        dose({ id: 'a', amount: 1, time: '08:00' }),
        dose({ id: 'b', amount: 1, time: '20:00' }),
      ],
      dosesPerDay: 3,
    });
    expect(schedule).toHaveLength(2);
    expect(schedule.map((d) => d.id)).toEqual(['a', 'b']);
    expect(schedule.map((d) => d.amount)).toEqual([1, 1]);
    expect(schedule.map((d) => d.time)).toEqual(['08:00', '20:00']);
  });

  it('sorts a stored out-of-order doseSchedule chronologically for the UI', () => {
    const schedule = getDoseScheduleForUI({
      dailyDose: 4,
      dosesPerDay: 3,
      doseSchedule: [
        dose({ id: 'late', amount: 1, time: '21:00' }),
        dose({ id: 'early', amount: 2, time: '08:00' }),
        dose({ id: 'middle', amount: 1, time: '14:00' }),
      ],
    });
    expect(schedule).toHaveLength(3);
    expect(schedule.map((d) => d.id)).toEqual(['early', 'middle', 'late']);
    expect(schedule.map((d) => d.time)).toEqual(['08:00', '14:00', '21:00']);
    expect(schedule.map((d) => d.amount)).toEqual([2, 1, 1]);
    // amounts stay tied to the correct IDs
    expect(schedule.find((d) => d.id === 'early')?.amount).toBe(2);
    expect(schedule.find((d) => d.id === 'middle')?.amount).toBe(1);
    expect(schedule.find((d) => d.id === 'late')?.amount).toBe(1);
  });

  it('ignores conflicting dosesPerDay when sorting a stored schedule', () => {
    const schedule = getDoseScheduleForUI({
      dailyDose: 2,
      dosesPerDay: 9, // deliberately wrong
      doseSchedule: [
        dose({ id: 'b', amount: 1, time: '20:00' }),
        dose({ id: 'a', amount: 1, time: '08:00' }),
      ],
    });
    expect(schedule).toHaveLength(2); // schedule length wins, not dosesPerDay
    expect(schedule.map((d) => d.id)).toEqual(['a', 'b']);
    expect(schedule.map((d) => d.time)).toEqual(['08:00', '20:00']);
  });

  it('edit compatibility: returns both stored rows for a 2-dose med', () => {
    const schedule = getDoseScheduleForUI({
      dailyDose: 3,
      dosesPerDay: 2,
      doseSchedule: [
        dose({ id: 'a', amount: 2, time: '08:00' }),
        dose({ id: 'b', amount: 1, time: '20:00' }),
      ],
    });
    expect(schedule).toHaveLength(2);
    expect(schedule[0]).toMatchObject({ id: 'a', amount: 2, time: '08:00' });
    expect(schedule[1]).toMatchObject({ id: 'b', amount: 1, time: '20:00' });
  });

  // ── Multi-dose persistence shape (via validate) ───────────────────
  it('multi-dose schedule produces dosesPerDay, dailyDose, and preserved pairs', () => {
    const result = validateAndNormalizeDoseSchedule(3, [
      dose({ id: 'd1', amount: 2, time: '08:00' }),
      dose({ id: 'd2', amount: 1, time: '14:00' }),
      dose({ id: 'd3', amount: 1, time: '21:00' }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.dosesPerDay).toBe(3);
    expect(result.dailyDose).toBe(4);
    expect(result.schedule).toHaveLength(3);
    expect(result.schedule?.map((d) => ({ amount: d.amount, time: d.time }))).toEqual([
      { amount: 2, time: '08:00' },
      { amount: 1, time: '14:00' },
      { amount: 1, time: '21:00' },
    ]);
    // IDs preserved through normalize
    expect(result.schedule?.map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
  });

  // ── Default times are chronological ───────────────────────────────
  it('DEFAULT_DOSE_TIMES is chronological', () => {
    for (let i = 1; i < DEFAULT_DOSE_TIMES.length; i++) {
      expect(timeMinutes(DEFAULT_DOSE_TIMES[i])).toBeGreaterThan(
        timeMinutes(DEFAULT_DOSE_TIMES[i - 1])
      );
    }
  });

  it('resizeDoseSchedule([], 4) produces a chronological schedule', () => {
    const four = resizeDoseSchedule([], 4);
    expect(four).toHaveLength(4);
    expect(timesAreChronological(four)).toBe(true);
    expect(four.every((d) => d.amount === 1)).toBe(true);
  });

  it('creates three schedule items for three doses', () => {
    const three = resizeDoseSchedule([], 3);
    expect(three).toHaveLength(3);
    expect(three.every((d) => d.amount === 1)).toBe(true);
    expect(timesAreChronological(three)).toBe(true);
  });

  // ── Increasing dose count ─────────────────────────────────────────
  it('preserves existing rows (by id) when increasing dosesPerDay and ends chronological', () => {
    const start = [
      dose({ id: 'a', amount: 2, time: '08:00' }),
      dose({ id: 'b', amount: 1, time: '14:00' }),
    ];
    const next = resizeDoseSchedule(start, 4);
    expect(next).toHaveLength(4);

    const byId = Object.fromEntries(next.map((d) => [d.id, d]));
    expect(byId.a).toEqual(start[0]);
    expect(byId.b).toEqual(start[1]);
    // IDs of preserved rows unchanged
    expect(byId.a.id).toBe('a');
    expect(byId.b.id).toBe('b');
    expect(byId.a.amount).toBe(2);
    expect(byId.b.amount).toBe(1);
    expect(byId.a.time).toBe('08:00');
    expect(byId.b.time).toBe('14:00');

    // Exactly two new rows
    const newRows = next.filter((d) => d.id !== 'a' && d.id !== 'b');
    expect(newRows).toHaveLength(2);
    expect(newRows.every((d) => d.amount === 1)).toBe(true);

    expect(timesAreChronological(next)).toBe(true);
  });

  it('does not regenerate IDs for existing rows when increasing', () => {
    const start = [
      dose({ id: 'stable-1', amount: 1, time: '08:00' }),
      dose({ id: 'stable-2', amount: 1, time: '20:00' }),
    ];
    const next = resizeDoseSchedule(start, 3);
    const ids = next.map((d) => d.id);
    expect(ids).toContain('stable-1');
    expect(ids).toContain('stable-2');
    expect(ids.filter((id) => id === 'stable-1' || id === 'stable-2')).toHaveLength(2);
  });

  // ── Decreasing dose count ─────────────────────────────────────────
  it('keeps first N rows unmodified when decreasing dosesPerDay', () => {
    const start = [
      dose({ id: 'a', amount: 2, time: '08:00' }),
      dose({ id: 'b', amount: 1, time: '14:00' }),
      dose({ id: 'c', amount: 1, time: '21:00' }),
    ];
    const next = resizeDoseSchedule(start, 2);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(start[0]);
    expect(next[1]).toEqual(start[1]);
    expect(next[0].id).toBe('a');
    expect(next[1].id).toBe('b');
    // retained rows are the same object references / values — not modified
    expect(next[0].amount).toBe(2);
    expect(next[0].time).toBe('08:00');
  });

  it('reducing to one keeps only the first row', () => {
    const start = [
      dose({ id: 'a', amount: 2, time: '08:00' }),
      dose({ id: 'b', amount: 1, time: '14:00' }),
      dose({ id: 'c', amount: 1, time: '21:00' }),
    ];
    const next = resizeDoseSchedule(start, 1);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('a');
    expect(next[0].amount).toBe(2);
    expect(next[0].time).toBe('08:00');
  });

  // ── Amounts / totals ──────────────────────────────────────────────
  it('allows different amounts per dose and totals them', () => {
    const schedule = [
      dose({ amount: 2, time: '08:00' }),
      dose({ amount: 1, time: '20:00' }),
    ];
    expect(totalDailyAmount(schedule)).toBe(3);
  });

  // ── Validation ────────────────────────────────────────────────────
  it('validates times and amounts including 00:00 and 23:59', () => {
    expect(isValidDoseTime('08:00')).toBe(true);
    expect(isValidDoseTime('23:59')).toBe(true);
    expect(isValidDoseTime('00:00')).toBe(true);
    expect(isValidDoseTime('24:00')).toBe(false);
    expect(isValidDoseTime('9:00')).toBe(true);

    const badAmount = validateAndNormalizeDoseSchedule(1, [
      dose({ amount: 0, time: '08:00' }),
    ]);
    expect(badAmount.ok).toBe(false);
    expect(badAmount.error).toBe('invalid_amount');

    const negAmount = validateAndNormalizeDoseSchedule(1, [
      dose({ amount: -1, time: '08:00' }),
    ]);
    expect(negAmount.ok).toBe(false);
    expect(negAmount.error).toBe('invalid_amount');

    const badTime = validateAndNormalizeDoseSchedule(1, [
      dose({ amount: 1, time: '25:00' }),
    ]);
    expect(badTime.ok).toBe(false);
    expect(badTime.error).toBe('invalid_time');

    const midnight = validateAndNormalizeDoseSchedule(1, [
      dose({ amount: 1, time: '00:00' }),
    ]);
    expect(midnight.ok).toBe(true);
    expect(midnight.schedule?.[0].time).toBe('00:00');

    const endOfDay = validateAndNormalizeDoseSchedule(1, [
      dose({ amount: 1, time: '23:59' }),
    ]);
    expect(endOfDay.ok).toBe(true);
    expect(endOfDay.schedule?.[0].time).toBe('23:59');
  });

  it('requires schedule length to equal dosesPerDay', () => {
    const result = validateAndNormalizeDoseSchedule(2, [
      dose({ amount: 1, time: '08:00' }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('length_mismatch');
  });

  it('rejects duplicate times', () => {
    const result = validateAndNormalizeDoseSchedule(2, [
      dose({ amount: 1, time: '08:00' }),
      dose({ amount: 1, time: '08:00' }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('duplicate_time');
  });

  it('normalizes schedule chronologically and sets dailyDose + reminderTime', () => {
    const result = validateAndNormalizeDoseSchedule(3, [
      dose({ id: 'c', amount: 1, time: '21:00' }),
      dose({ id: 'a', amount: 2, time: '08:00' }),
      dose({ id: 'b', amount: 1, time: '14:00' }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.schedule?.map((d) => d.time)).toEqual(['08:00', '14:00', '21:00']);
    expect(result.schedule?.map((d) => d.amount)).toEqual([2, 1, 1]);
    expect(result.schedule?.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(result.dailyDose).toBe(4);
    expect(result.dosesPerDay).toBe(3);
    expect(result.reminderTime).toBe('08:00');
  });

  it('sortDoseSchedule is deterministic', () => {
    const sorted = sortDoseSchedule([
      dose({ id: 'z', amount: 1, time: '22:00' }),
      dose({ id: 'a', amount: 1, time: '06:00' }),
    ]);
    expect(sorted.map((d) => d.time)).toEqual(['06:00', '22:00']);
  });

  it('clamps dosesPerDay to MAX_DOSES_PER_DAY', () => {
    const big = resizeDoseSchedule([], 99);
    expect(big.length).toBe(MAX_DOSES_PER_DAY);
    expect(timesAreChronological(big)).toBe(true);
  });

  it('validate rejects count above MAX_DOSES_PER_DAY', () => {
    const rows = Array.from({ length: MAX_DOSES_PER_DAY + 1 }, (_, i) =>
      dose({
        id: `x${i}`,
        amount: 1,
        time: `${String(i).padStart(2, '0')}:00`,
      })
    );
    const result = validateAndNormalizeDoseSchedule(MAX_DOSES_PER_DAY + 1, rows);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_count');
  });
});
