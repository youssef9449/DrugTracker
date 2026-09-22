import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getTodayDateString,
  getDepletionDate } from '@/utils/dateCalculations';
import { NEVER_DEPLETES_DAYS } from '@/utils/time';
import { formatDepletionDate } from '@/utils/medicationPresentation';
import type { Medication } from '@/types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  // currentPills (no days have passed). Tests that exercise the
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    ...overrides,
  };
}

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


describe('getDepletionDate', () => {
  it('returns "ينفد اليوم" when daysLeft is 0', () => {
    const r = getDepletionDate(makeMed({ currentPills: 0, dailyDose: 1 }));
    expect(r.daysLeft).toBe(0);
    expect(formatDepletionDate(r.dateStr, r.daysLeft, 0)).toBe('نفد المخزون بالكامل');
  });

  it('returns "غداً" when daysLeft is 1', () => {
    const r = getDepletionDate(makeMed({ currentPills: 1, dailyDose: 1 }));
    expect(r.daysLeft).toBe(1);
    expect(formatDepletionDate(r.dateStr, r.daysLeft, 1)).toBe('غداً');
  });

  it('returns "بعد غد" when daysLeft is 2', () => {
    const r = getDepletionDate(makeMed({ currentPills: 2, dailyDose: 1 }));
    expect(r.daysLeft).toBe(2);
    expect(formatDepletionDate(r.dateStr, r.daysLeft, 2)).toBe('بعد غد');
  });

  it('returns a dateStr 7 days out for 7 daysLeft', () => {
    const r = getDepletionDate(makeMed({ currentPills: 7, dailyDose: 1 }));
    expect(r.daysLeft).toBe(7);
    // dateStr is today + 7 days (UTC); system time pinned in beforeEach.
    expect(r.dateStr).toBe('2024-09-17');
  });

  it(`treats dailyDose <= 0 as ${NEVER_DEPLETES_DAYS} days (effectively never depletes)`, () => {
    const r = getDepletionDate(makeMed({ currentPills: 30, dailyDose: 0 }));
    expect(r.daysLeft).toBe(NEVER_DEPLETES_DAYS);
  });
});

