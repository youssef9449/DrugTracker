import { describe, it, expect } from 'vitest';
import { isDoseConsumedOnDate } from '@/utils/dateCalculations';
import type { Medication } from '@/types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 10,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2026-09-14',
    autoDeductEnabled: true,
    ...overrides,
  };
}

describe('isDoseConsumedOnDate — explicit per-dose only (no lastConsumedDate fallback)', () => {
  const TODAY = '2026-09-14';

  it('no-schedule med + matching lastConsumedDate does NOT mark an arbitrary dose consumed', () => {
    const med = makeMed({
      doseSchedule: undefined,
      lastConsumedDate: TODAY,
    });
    expect(isDoseConsumedOnDate(med, 'd1', TODAY)).toBe(false);
    expect(isDoseConsumedOnDate(med, 'any', TODAY)).toBe(false);
  });

  it('explicit doseConsumption[doseId] still marks that dose consumed', () => {
    const med = makeMed({
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      doseConsumption: { d1: TODAY },
    });
    expect(isDoseConsumedOnDate(med, 'd1', TODAY)).toBe(true);
    expect(isDoseConsumedOnDate(med, 'd2', TODAY)).toBe(false);
  });

  it('explicit doseConsumptionHistory[doseId] still marks that dose consumed', () => {
    const med = makeMed({
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      doseConsumptionHistory: { d1: [TODAY] },
    });
    expect(isDoseConsumedOnDate(med, 'd1', TODAY)).toBe(true);
  });

  it('single-slot explicit schedule works with per-dose consumption only', () => {
    const med = makeMed({
      doseSchedule: [{ id: 's1', amount: 2, time: '09:00' }],
      dosesPerDay: 1,
      lastConsumedDate: TODAY, // must NOT alone make s1 consumed
      doseConsumption: { s1: TODAY },
    });
    expect(isDoseConsumedOnDate(med, 's1', TODAY)).toBe(true);
    const medLcdOnly = makeMed({
      doseSchedule: [{ id: 's1', amount: 2, time: '09:00' }],
      lastConsumedDate: TODAY,
    });
    expect(isDoseConsumedOnDate(medLcdOnly, 's1', TODAY)).toBe(false);
  });
});
