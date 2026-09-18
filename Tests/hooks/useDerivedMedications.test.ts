import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDerivedMedications } from '@/hooks/useDerivedMedications';
import type { Medication } from '@/types';
import { getTodayDateString } from '@/utils/dateCalculations';

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
    lastSyncDate: '2024-01-01',
    autoDeductEnabled: true,
    ...overrides,
  };
}

describe('useDerivedMedications — Global Auto-Deduct (UI-13)', () => {
  it('recomputes medicationsWithStatus when globalAutoDeductEnabled flips', () => {
    const meds = [makeMed()];
    const { result, rerender } = renderHook(
      ({ global }: { global: boolean }) =>
        useDerivedMedications(meds, [], 'all', '', global),
      { initialProps: { global: true } }
    );

    const daysOn = result.current.medicationsWithStatus[0].statusInfo.daysLeft;
    const pillsProjectedLow =
      result.current.medicationsWithStatus[0].statusInfo.status === 'out_of_stock' ||
      daysOn < 15;

    rerender({ global: false });
    const daysOff = result.current.medicationsWithStatus[0].statusInfo.daysLeft;

    // With Global OFF, projection freezes → more days left (or at least not more depleted).
    expect(daysOff).toBeGreaterThanOrEqual(daysOn);
    // And status should reflect frozen 30 pills / 2 daily = 15 days when threshold is 5 → sufficient
    expect(result.current.medicationsWithStatus[0].statusInfo.daysLeft).toBe(15);
    expect(result.current.medicationsWithStatus[0].statusInfo.status).toBe('sufficient');

    // Sanity: Global ON had been projecting (either depleted or fewer days)
    expect(pillsProjectedLow || daysOn < 15).toBe(true);
  });
});
