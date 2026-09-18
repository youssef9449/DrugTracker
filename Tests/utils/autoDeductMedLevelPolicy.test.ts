import { describe, it, expect } from 'vitest';
import type { Medication } from '@/types';
import {
  isMedicationAutoDeductActive,
  medicationForStockProjection,
  getCardDoseToggleTarget,
} from '@/utils/doseSchedule';
import { effectiveCurrentPills, getTodayDateString } from '@/utils/dateCalculations';

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

describe('Auto-Deduction medication-level policy (no Global kill switch)', () => {
  it('A: Medication ON → Auto active', () => {
    expect(isMedicationAutoDeductActive(makeMed({ autoDeductEnabled: true }))).toBe(true);
  });

  it('B: Medication OFF → Auto inactive', () => {
    expect(isMedicationAutoDeductActive(makeMed({ autoDeductEnabled: false }))).toBe(false);
  });

  it('C: Medication ON → stock projects (not frozen at 30)', () => {
    const med = makeMed({ autoDeductEnabled: true, currentPills: 30 });
    expect(effectiveCurrentPills(medicationForStockProjection(med))).toBeLessThan(30);
  });

  it('D: Medication OFF → stock frozen at currentPills', () => {
    const med = makeMed({ autoDeductEnabled: false, currentPills: 30 });
    expect(effectiveCurrentPills(medicationForStockProjection(med))).toBe(30);
  });

  it('E: Medication ON + elapsed dose is auto-completed on Card toggle', () => {
    const today = getTodayDateString();
    const late = new Date(`${today}T20:00:00`);
    const med = makeMed({
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      dosesPerDay: 1,
      lastSyncDate: today,
    });
    const t = getCardDoseToggleTarget(med, late, today);
    expect(t.canTake).toBe(false);
    expect(t.canRestore).toBe(false);
  });

  it('F: Medication OFF + elapsed dose remains Take-eligible', () => {
    const today = getTodayDateString();
    const late = new Date(`${today}T20:00:00`);
    const med = makeMed({
      autoDeductEnabled: false,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      dosesPerDay: 1,
      lastSyncDate: today,
    });
    const t = getCardDoseToggleTarget(med, late, today);
    expect(t.canTake).toBe(true);
  });

  it('G: medicationForStockProjection does not rewrite Auto ON to OFF', () => {
    const med = makeMed({ autoDeductEnabled: true });
    expect(medicationForStockProjection(med).autoDeductEnabled).not.toBe(false);
  });
});
