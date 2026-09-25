import { requireDefined } from '../helpers/requireDefined';
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
    autoDeductEnabled: true,
    ...overrides,
  };
}

describe('useDerivedMedications — medication-level status projection', () => {
  it('Medication ON does not invent depletion from elapsed time (durable stock only)', () => {
    // Current contract (stockDepletion.ts): daysLeft is derived from durable
    // currentPills and the schedule rate ONLY — the UI never projects
    // deductions for elapsed calendar days. The Auto engine performs real
    // deductions and persists them into currentPills, so an Auto-ON med with
    // untouched durable stock projects the same daysLeft as its stock allows.
    const meds = [makeMed({ autoDeductEnabled: true })];
    const { result } = renderHook(() =>
      useDerivedMedications(meds, [], 'all', '')
    );
    const info = requireDefined(result.current.medicationsWithStatus[0], 'result.current.medicationsWithStatus[0]').statusInfo;
    // 30 pills / 2 per day → 15 days from durable stock (not frozen, not
    // artificially depleted by elapsed-time projection).
    expect(info.daysLeft).toBe(15);
    expect(info.status).toBe('sufficient');
  });

  it('Medication OFF freezes stock at currentPills', () => {
    const meds = [makeMed({ autoDeductEnabled: false, currentPills: 30 })];
    const { result } = renderHook(() =>
      useDerivedMedications(meds, [], 'all', '')
    );
    expect(requireDefined(result.current.medicationsWithStatus[0], 'result.current.medicationsWithStatus[0]').statusInfo.daysLeft).toBe(15);
    expect(requireDefined(result.current.medicationsWithStatus[0], 'result.current.medicationsWithStatus[0]').statusInfo.status).toBe('sufficient');
  });
});
