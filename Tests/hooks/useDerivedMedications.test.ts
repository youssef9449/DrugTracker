import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDerivedMedications } from '@/hooks/useDerivedMedications';
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
    lastSyncDate: '2024-01-01',
    autoDeductEnabled: true,
    ...overrides,
  };
}

describe('useDerivedMedications — medication-level Auto projection', () => {
  it('Medication ON projects stock (daysLeft reflects auto depletion)', () => {
    const meds = [makeMed({ autoDeductEnabled: true })];
    const { result } = renderHook(() =>
      useDerivedMedications(meds, [], 'all', '')
    );
    const days = result.current.medicationsWithStatus[0].statusInfo.daysLeft;
    // Past lastSync with auto ON → projected depletion (not frozen 15 days)
    expect(days).toBeLessThan(15);
  });

  it('Medication OFF freezes stock at currentPills', () => {
    const meds = [makeMed({ autoDeductEnabled: false, currentPills: 30 })];
    const { result } = renderHook(() =>
      useDerivedMedications(meds, [], 'all', '')
    );
    expect(result.current.medicationsWithStatus[0].statusInfo.daysLeft).toBe(15);
    expect(result.current.medicationsWithStatus[0].statusInfo.status).toBe('sufficient');
  });
});
