import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getTodayDateString,
  getDaysDifference,
  getDepletionDate } from '@/utils/dateCalculations';
import { NEVER_DEPLETES_DAYS } from '@/utils/time';
import type { Medication } from '@/types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  // lastSyncDate defaults to today so currentPills ===
  // currentPills (no days have passed). Tests that exercise the
  // dynamic-balance projection override lastSyncDate explicitly.
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: getTodayDateString(),
    autoDeductEnabled: true,
    ...overrides,
  };
}

// Wave 13 #123: pin system time so makeMed's `lastSyncDate: getTodayDateString()`
// default and the `getDepletionDate(...)` assertions that compute the date
// string 7 days out resolve to a deterministic date (2024-09-10T12:00:00Z).
// Prevents midnight-UTC flake risk where the test process's wall-clock date
// rolls over mid-run.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

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

  it(`treats dailyDose <= 0 as ${NEVER_DEPLETES_DAYS} days (effectively never depletes)`, () => {
    const r = getDepletionDate(makeMed({ currentPills: 30, dailyDose: 0 }));
    expect(r.daysLeft).toBe(NEVER_DEPLETES_DAYS);
  });
});

