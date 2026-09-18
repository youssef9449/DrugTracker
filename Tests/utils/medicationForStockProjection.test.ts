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

describe('isMedicationAutoDeductActive / medicationForStockProjection (med-level only)', () => {
  it('Medication ON → Auto active regardless of any former Global concept', () => {
    const med = makeMed({ autoDeductEnabled: true });
    expect(isMedicationAutoDeductActive(med)).toBe(true);
    expect(medicationForStockProjection(med)).toBe(med);
    expect(effectiveCurrentPills(medicationForStockProjection(med))).toBeLessThan(30);
  });

  it('Medication OFF → Auto inactive and stock frozen', () => {
    const med = makeMed({ autoDeductEnabled: false, currentPills: 30 });
    expect(isMedicationAutoDeductActive(med)).toBe(false);
    expect(effectiveCurrentPills(medicationForStockProjection(med))).toBe(30);
  });

  it('projection identity does not rewrite autoDeductEnabled', () => {
    const med = makeMed({ autoDeductEnabled: true });
    expect(medicationForStockProjection(med).autoDeductEnabled).not.toBe(false);
  });
});
