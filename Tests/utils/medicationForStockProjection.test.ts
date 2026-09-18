import { describe, it, expect } from 'vitest';
import type { Medication } from '@/types';
import { calculateMedicationStatus } from '@/types';
import {
  effectiveCurrentPills,
  getTodayDateString,
} from '@/utils/dateCalculations';
import {
  isMedicationAutoDeductActive,
  medicationForStockProjection,
} from '@/utils/doseSchedule';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  const today = getTodayDateString();
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    // lastSyncDate in the past so auto projection would deduct if active
    lastSyncDate: '2024-01-01',
    autoDeductEnabled: true,
    ...overrides,
  };
}

describe('medicationForStockProjection / stock UI effective auto (UI-13)', () => {
  // Case A — Global OFF + Medication ON → no auto projection
  it('Case A: Global OFF + med ON → stock frozen at currentPills (no auto projection)', () => {
    const med = makeMed({ autoDeductEnabled: true, currentPills: 30 });
    expect(isMedicationAutoDeductActive(med, false)).toBe(false);

    const projected = medicationForStockProjection(med, false);
    expect(projected.autoDeductEnabled).toBe(false);
    expect(effectiveCurrentPills(projected)).toBe(30);
    expect(effectiveCurrentPills(med)).toBeLessThan(30); // raw med would still project

    const status = calculateMedicationStatus(projected);
    const statusIfAuto = calculateMedicationStatus(med);
    // Frozen balance should not match the auto-projected lower status path
    // when many days have elapsed since lastSyncDate.
    expect(status.daysLeft).toBeGreaterThanOrEqual(statusIfAuto.daysLeft);
    expect(effectiveCurrentPills(projected)).toBe(med.currentPills);
  });

  // Case B — Global ON + Medication ON → natural auto projection
  it('Case B: Global ON + med ON → auto projection applies', () => {
    const med = makeMed({ autoDeductEnabled: true, currentPills: 30 });
    expect(isMedicationAutoDeductActive(med, true)).toBe(true);

    const projected = medicationForStockProjection(med, true);
    expect(projected).toBe(med); // same reference when effective ON
    expect(effectiveCurrentPills(projected)).toBeLessThan(30);
  });

  // Case C — Global OFF + Medication OFF → still frozen
  it('Case C: Global OFF + med OFF → projection remains off', () => {
    const med = makeMed({ autoDeductEnabled: false, currentPills: 30 });
    const projected = medicationForStockProjection(med, false);
    expect(projected.autoDeductEnabled).toBe(false);
    expect(effectiveCurrentPills(projected)).toBe(30);
  });

  // Case D — toggling global changes projection input
  it('Case D: Global ON→OFF changes projection med (recompute input)', () => {
    const med = makeMed({ autoDeductEnabled: true, currentPills: 30 });
    const on = medicationForStockProjection(med, true);
    const off = medicationForStockProjection(med, false);
    expect(effectiveCurrentPills(on)).not.toBe(effectiveCurrentPills(off));
    expect(effectiveCurrentPills(off)).toBe(30);
    expect(on.autoDeductEnabled).not.toBe(false);
    expect(off.autoDeductEnabled).toBe(false);
  });
});
