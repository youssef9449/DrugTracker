import { describe, it, expect } from 'vitest';
import type { Medication } from '@/types';
import {
  isMedicationAutoDeductActive,
  getCardDoseToggleTarget } from '@/utils/doseSchedule';
import { daysLeftFromCurrentStock } from '@/utils/dateCalculations';

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

describe('Auto-Deduction medication-level policy (Issue #266 durable stock)', () => {
  it('A: Medication ON → Auto active', () => {
    expect(isMedicationAutoDeductActive(makeMed({ autoDeductEnabled: true }))).toBe(true);
  });

  it('B: Medication OFF → Auto inactive', () => {
    expect(isMedicationAutoDeductActive(makeMed({ autoDeductEnabled: false }))).toBe(false);
  });

  it('C: Medication ON does not project currentPills downward', () => {
    const med = makeMed({ autoDeductEnabled: true, currentPills: 30 });
    expect(med.currentPills).toBe(30);
    expect(daysLeftFromCurrentStock(med)).toBe(15);
  });

  it('D: Medication OFF keeps durable currentPills', () => {
    const med = makeMed({ autoDeductEnabled: false, currentPills: 30 });
    expect(med.currentPills).toBe(30);
    expect(daysLeftFromCurrentStock(med)).toBe(15);
  });

  it('undefined autoDeductEnabled defaults ON', () => {
    const med = makeMed();
    delete (med as { autoDeductEnabled?: boolean }).autoDeductEnabled;
    expect(isMedicationAutoDeductActive(med)).toBe(true);
  });
});
