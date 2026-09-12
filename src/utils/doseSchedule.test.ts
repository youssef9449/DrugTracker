import { describe, it, expect } from 'vitest';
import {
  getDoseScheduleForUI,
  resizeDoseSchedule,
  sortDoseSchedule,
  totalDailyAmount,
  validateAndNormalizeDoseSchedule,
  isValidDoseTime,
  MAX_DOSES_PER_DAY,
} from './doseSchedule';
import type { MedicationDose } from '../types';

function dose(partial: Partial<MedicationDose> & { amount: number; time: string }): MedicationDose {
  return {
    id: partial.id || `dose-${partial.time}-${partial.amount}`,
    amount: partial.amount,
    time: partial.time,
  };
}

describe('doseSchedule helpers', () => {
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

  it('prefers stored doseSchedule when present', () => {
    const schedule = getDoseScheduleForUI({
      dailyDose: 99,
      reminderTime: '01:00',
      doseSchedule: [
        dose({ amount: 1, time: '08:00' }),
        dose({ amount: 1, time: '20:00' }),
      ],
      dosesPerDay: 2,
    });
    expect(schedule).toHaveLength(2);
    expect(schedule.map((d) => d.amount)).toEqual([1, 1]);
  });

  it('creates three schedule items for three doses', () => {
    const three = resizeDoseSchedule([], 3);
    expect(three).toHaveLength(3);
    expect(three.every((d) => d.amount === 1)).toBe(true);
  });

  it('preserves existing rows when increasing dosesPerDay', () => {
    const start = [
      dose({ id: 'a', amount: 2, time: '08:00' }),
      dose({ id: 'b', amount: 1, time: '14:00' }),
    ];
    const next = resizeDoseSchedule(start, 4);
    expect(next).toHaveLength(4);
    expect(next[0]).toEqual(start[0]);
    expect(next[1]).toEqual(start[1]);
    expect(next[2].amount).toBe(1);
    expect(next[3].amount).toBe(1);
  });

  it('keeps first N rows when decreasing dosesPerDay', () => {
    const start = [
      dose({ id: 'a', amount: 2, time: '08:00' }),
      dose({ id: 'b', amount: 1, time: '14:00' }),
      dose({ id: 'c', amount: 1, time: '21:00' }),
    ];
    const next = resizeDoseSchedule(start, 2);
    expect(next).toHaveLength(2);
    expect(next[0].id).toBe('a');
    expect(next[1].id).toBe('b');
  });

  it('allows different amounts per dose and totals them', () => {
    const schedule = [
      dose({ amount: 2, time: '08:00' }),
      dose({ amount: 1, time: '20:00' }),
    ];
    expect(totalDailyAmount(schedule)).toBe(3);
  });

  it('validates times and amounts', () => {
    expect(isValidDoseTime('08:00')).toBe(true);
    expect(isValidDoseTime('23:59')).toBe(true);
    expect(isValidDoseTime('24:00')).toBe(false);
    expect(isValidDoseTime('9:00')).toBe(true);

    const badAmount = validateAndNormalizeDoseSchedule(1, [
      dose({ amount: 0, time: '08:00' }),
    ]);
    expect(badAmount.ok).toBe(false);
    expect(badAmount.error).toBe('invalid_amount');

    const badTime = validateAndNormalizeDoseSchedule(1, [
      dose({ amount: 1, time: '25:00' }),
    ]);
    expect(badTime.ok).toBe(false);
    expect(badTime.error).toBe('invalid_time');
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
      dose({ amount: 1, time: '21:00' }),
      dose({ amount: 2, time: '08:00' }),
      dose({ amount: 1, time: '14:00' }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.schedule?.map((d) => d.time)).toEqual(['08:00', '14:00', '21:00']);
    expect(result.schedule?.map((d) => d.amount)).toEqual([2, 1, 1]);
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
  });
});
