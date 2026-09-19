import { describe, it, expect } from 'vitest';
import {
  dailyScheduleAmount,
  daysLeftFromCurrentStock,
  getDepletionDate } from '@/utils/dateCalculations';
import type { Medication } from '@/types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 5,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-09-12',
    autoDeductEnabled: true,
    doseSchedule: [
      { id: 'd1', amount: 2, time: '08:00' },
      { id: 'd2', amount: 3, time: '20:00' },
    ],
    ...overrides,
  };
}

describe('dailyScheduleAmount / durable daysLeft (Issue #266)', () => {
  it('sums multi-dose amounts for the daily rate', () => {
    expect(dailyScheduleAmount(makeMed())).toBe(5);
  });

  it('daysLeft uses currentPills / schedule sum without elapsed projection', () => {
    const med = makeMed({ currentPills: 20, lastSyncDate: '2020-01-01' });
    expect(daysLeftFromCurrentStock(med)).toBe(4);
    expect(getDepletionDate(med).daysLeft).toBe(4);
  });

  it('Auto OFF does not change durable currentPills or daysLeft math', () => {
    const med = makeMed({
      currentPills: 20,
      autoDeductEnabled: false,
      lastSyncDate: '2020-01-01',
    });
    expect(med.currentPills).toBe(20);
    expect(daysLeftFromCurrentStock(med)).toBe(4);
  });
});
