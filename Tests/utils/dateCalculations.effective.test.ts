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
    lastSyncDate: '2024-09-01',
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
  it('old lastSyncDate does not reduce live stock or daysLeft', () => {
    const med = makeMed({
      currentPills: 100,
      dailyDose: 10,
      lastSyncDate: '2024-01-01',
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

  it('Auto OFF never creates projected subtraction from currentPills', () => {
    const med = makeMed({
      currentPills: 20,
      autoDeductEnabled: false,
      lastSyncDate: '2024-01-01',
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
      lastSyncDate: '2020-01-01',
    });
    const status = calculateMedicationStatus(med);
    const depletion = getDepletionDate(med);
    expect(status.daysLeft).toBe(depletion.daysLeft);
    expect(status.daysLeft).toBe(5);
    expect(med.currentPills).toBe(15);
  });

  it('critical alarm date does not depend on lastSyncDate alone', () => {
    const base = {
      currentPills: 100,
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '08:00' }],
    } as const;
    const a = makeMed({ ...base, lastSyncDate: '2024-09-10' });
    const b = makeMed({ ...base, lastSyncDate: '2020-01-01' });
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
});
