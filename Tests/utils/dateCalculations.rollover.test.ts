import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { daysLeftFromCurrentStock, getDepletionDate } from '@/utils/dateCalculations';
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
    doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    ...overrides,
  };
}

describe('calendar independence of durable stock (Issue #266)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-09-12T00:30:00'));
  });
  afterEach(() => vi.useRealTimers());

  it('midnight does not subtract from currentPills via projection', () => {
    const med = makeMed({ currentPills: 30});
    expect(med.currentPills).toBe(30);
    expect(daysLeftFromCurrentStock(med)).toBe(15);
    expect(getDepletionDate(med).daysLeft).toBe(15);
  });
});
