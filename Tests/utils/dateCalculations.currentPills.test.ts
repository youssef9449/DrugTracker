import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  daysLeftFromCurrentStock,
  getCriticalAlarmDate,
  getDepletionDate,
  getTodayDateString } from '@/utils/dateCalculations';
import { calculateMedicationStatus } from '@/types';
import { NEVER_DEPLETES_DAYS } from '@/utils/time';
import type { Medication } from '@/types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Issue #266 — durable currentPills is sole live stock', () => {
  it('calendar days alone do not reduce durable currentPills or daysLeft', () => {
    const med = makeMed({
      currentPills: 100,
      dailyDose: 10,
      doseSchedule: [{ id: 'd1', amount: 10, time: '08:00' }],
    });
    expect(med.currentPills).toBe(100);
    expect(daysLeftFromCurrentStock(med)).toBe(10);
    expect(getDepletionDate(med).daysLeft).toBe(10);
    expect(calculateMedicationStatus(med).daysLeft).toBe(10);
  });

  it('multi-dose schedule uses current stock for daysLeft', () => {
    const med = makeMed({
      currentPills: 20,
      dailyDose: 5,
      doseSchedule: [
        { id: 'd1', amount: 2, time: '08:00' },
        { id: 'd2', amount: 3, time: '20:00' },
      ],
    });
    expect(daysLeftFromCurrentStock(med)).toBe(4);
    expect(getDepletionDate(med).daysLeft).toBe(4);
    expect(calculateMedicationStatus(med).daysLeft).toBe(4);
  });

  it('Auto OFF does not subtract from currentPills without a durable deduction', () => {
    const med = makeMed({
      currentPills: 20,
      autoDeductEnabled: false,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    expect(med.currentPills).toBe(20);
    expect(daysLeftFromCurrentStock(med)).toBe(10);
    expect(getCriticalAlarmDate(med)).toBeNull();
  });

  it('status and depletion agree on durable stock', () => {
    const med = makeMed({
      currentPills: 15,
      dailyDose: 3,
      doseSchedule: [{ id: 'd1', amount: 3, time: '09:00' }],
    });
    const status = calculateMedicationStatus(med);
    const depletion = getDepletionDate(med);
    expect(status.daysLeft).toBe(depletion.daysLeft);
    expect(status.daysLeft).toBe(5);
    expect(med.currentPills).toBe(15);
  });

  it('critical alarm date is derived from durable currentPills and schedule rate', () => {
    const base = {
      currentPills: 100,
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '08:00' }],
    };
    const a = makeMed({ ...base});
    const b = makeMed({ ...base});
    expect(getCriticalAlarmDate(a)).toBe(getCriticalAlarmDate(b));
    // daysLeft=10, threshold=5 → 5 days until critical
    expect(daysLeftFromCurrentStock(a)).toBe(10);
  });

  it('out of stock when currentPills <= 0', () => {
    const med = makeMed({ currentPills: 0, dailyDose: 2 });
    expect(daysLeftFromCurrentStock(med)).toBe(0);
    expect(calculateMedicationStatus(med).status).toBe('out_of_stock');
    expect(getDepletionDate(med).formattedArabic).toBe('نفد المخزون بالكامل');
  });

  it('zero consumption rate yields never-depletes sentinel', () => {
    const med = makeMed({
      currentPills: 50,
      dailyDose: 0,
      doseSchedule: [],
    });
    expect(daysLeftFromCurrentStock(med)).toBe(NEVER_DEPLETES_DAYS);
  });

  it('getTodayDateString is stable under pinned time', () => {
    expect(getTodayDateString()).toBe('2024-09-10');
  });

  it('warningThresholdDays is per-medication: higher threshold yields earlier critical alarm', () => {
    // Same stock + rate: daysLeft = 100/10 = 10.
    // threshold 5 → alarm in 5 days; threshold 8 → alarm in 2 days (earlier).
    const shared = {
      currentPills: 100,
      dailyDose: 10,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '08:00' }],
    } as const;
    const med5 = makeMed({ ...shared, id: 'med-t5', warningThresholdDays: 5 });
    const med8 = makeMed({ ...shared, id: 'med-t8', warningThresholdDays: 8 });
    const today = getTodayDateString();
    const t5 = getCriticalAlarmDate(med5, today);
    const t8 = getCriticalAlarmDate(med8, today);
    expect(t5).not.toBeNull();
    expect(t8).not.toBeNull();
    expect(t5).not.toBe(t8);
    // Larger threshold ⇒ critical state reached sooner ⇒ earlier alarm timestamp.
    expect(t8!).toBeLessThan(t5!);
  });

  it('changing another medication threshold does not affect this medication alarm date', () => {
    const shared = {
      currentPills: 100,
      dailyDose: 10,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '08:00' }],
    } as const;
    const medA = makeMed({ ...shared, id: 'med-a', warningThresholdDays: 5 });
    const medB5 = makeMed({ ...shared, id: 'med-b', warningThresholdDays: 5 });
    const medB8 = makeMed({ ...shared, id: 'med-b', warningThresholdDays: 8 });
    const today = getTodayDateString();
    const aBefore = getCriticalAlarmDate(medA, today);
    const b5 = getCriticalAlarmDate(medB5, today);
    const b8 = getCriticalAlarmDate(medB8, today);
    const aAfter = getCriticalAlarmDate(medA, today);
    expect(aBefore).toBe(aAfter);
    expect(aBefore).toBe(b5);
    expect(b8).not.toBe(b5);
    expect(b8!).toBeLessThan(b5!);
  });

});
