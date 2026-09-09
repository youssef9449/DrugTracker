import { describe, it, expect } from 'vitest';
import {
  getTodayDateString,
  getDaysDifference,
  getDepletionDate,
  syncAutoDailyDeductions,
} from './dateCalculations';
import type { Medication } from '../types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-01-01',
    autoDeductEnabled: true,
    ...overrides,
  };
}

describe('getTodayDateString', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(getTodayDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('getDaysDifference', () => {
  it('returns 0 for equal dates', () => {
    expect(getDaysDifference('2024-03-15', '2024-03-15')).toBe(0);
  });

  it('returns the positive whole-day difference', () => {
    expect(getDaysDifference('2024-03-10', '2024-03-15')).toBe(5);
  });

  it('clamps negative differences to 0', () => {
    expect(getDaysDifference('2024-03-20', '2024-03-15')).toBe(0);
  });

  it('handles month + year boundaries correctly (UTC, no DST off-by-one)', () => {
    // Across a month boundary
    expect(getDaysDifference('2024-01-31', '2024-02-01')).toBe(1);
    // Across a year boundary
    expect(getDaysDifference('2024-12-31', '2025-01-01')).toBe(1);
    // Leap year February
    expect(getDaysDifference('2024-02-28', '2024-03-01')).toBe(2); // 2024 is a leap year
  });

  it('returns 0 for malformed input', () => {
    expect(getDaysDifference('not-a-date', '2024-03-15')).toBe(0);
    expect(getDaysDifference('2024-03-15', '')).toBe(0);
  });
});

describe('getDepletionDate', () => {
  it('returns "ينفد اليوم" when daysLeft is 0', () => {
    const r = getDepletionDate(makeMed({ currentPills: 0, dailyDose: 1 }));
    expect(r.daysLeft).toBe(0);
    expect(r.formattedArabic).toBe('نفد المخزون بالكامل');
  });

  it('returns "غداً" when daysLeft is 1', () => {
    const r = getDepletionDate(makeMed({ currentPills: 1, dailyDose: 1 }));
    expect(r.daysLeft).toBe(1);
    expect(r.formattedArabic).toBe('غداً');
  });

  it('returns "بعد غد" when daysLeft is 2', () => {
    const r = getDepletionDate(makeMed({ currentPills: 2, dailyDose: 1 }));
    expect(r.daysLeft).toBe(2);
    expect(r.formattedArabic).toBe('بعد غد');
  });

  it('returns a dateStr 7 days out for 7 daysLeft', () => {
    const r = getDepletionDate(makeMed({ currentPills: 7, dailyDose: 1 }));
    expect(r.daysLeft).toBe(7);
    // dateStr is today + 7 days (UTC). We assert it's a valid YYYY-MM-DD
    // and that the diff from today is exactly 7.
    expect(r.dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getDaysDifference(getTodayDateString(), r.dateStr)).toBe(7);
  });

  it('treats dailyDose <= 0 as 999 days (effectively never depletes)', () => {
    const r = getDepletionDate(makeMed({ currentPills: 30, dailyDose: 0 }));
    expect(r.daysLeft).toBe(999);
  });
});

describe('syncAutoDailyDeductions', () => {
  it('deducts pills for each day passed since lastSyncDate', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-03-10' });
    const result = syncAutoDailyDeductions([med], '2024-03-15');
    expect(result.updatedMeds[0].currentPills).toBe(20); // 30 - 2*5
    expect(result.updatedMeds[0].lastSyncDate).toBe('2024-03-15');
    expect(result.newLogs).toHaveLength(1);
    expect(result.newLogs[0].amount).toBe(-10);
    expect(result.deductedSummary[0].daysPassed).toBe(5);
  });

  it('clamps the deduction so currentPills never goes negative', () => {
    const med = makeMed({ currentPills: 3, dailyDose: 2, lastSyncDate: '2024-03-10' });
    const result = syncAutoDailyDeductions([med], '2024-03-15');
    expect(result.updatedMeds[0].currentPills).toBe(0);
    expect(result.newLogs[0].amount).toBe(-3); // only 3 pills existed
  });

  it('skips meds with autoDeductEnabled === false', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-03-10', autoDeductEnabled: false });
    const result = syncAutoDailyDeductions([med], '2024-03-15');
    expect(result.updatedMeds[0].currentPills).toBe(30); // unchanged
    expect(result.newLogs).toHaveLength(0);
  });

  it('skips meds with dailyDose <= 0', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 0, lastSyncDate: '2024-03-10' });
    const result = syncAutoDailyDeductions([med], '2024-03-15');
    expect(result.updatedMeds[0].currentPills).toBe(30);
    expect(result.newLogs).toHaveLength(0);
  });

  it('produces no logs when 0 days have passed', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-03-15' });
    const result = syncAutoDailyDeductions([med], '2024-03-15');
    expect(result.newLogs).toHaveLength(0);
  });

  it('ensures lastSyncDate is set on meds that had none', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '' });
    const result = syncAutoDailyDeductions([med], '2024-03-15');
    expect(result.updatedMeds[0].lastSyncDate).toBe('2024-03-15');
  });
});
