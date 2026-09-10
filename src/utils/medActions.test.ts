import { describe, it, expect } from 'vitest';
import { settleAndAdjust, consumeDose } from './medActions';
import type { Medication } from '../types';

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

describe('settleAndAdjust (#78)', () => {
  it('settles at the effective balance + applies a positive delta (restore)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-01' });
    const today = '2024-01-10';
    // 9 days passed at 2/day → effPills = 30 - 18 = 12. Restore +2 → 14.
    const result = settleAndAdjust(med, 2, today);
    expect(result.updatedMed.currentPills).toBe(14);
    expect(result.updatedMed.lastSyncDate).toBe(today);
    expect(result.appliedDelta).toBe(2);
  });

  it('applies a positive delta when no days passed (refill)', () => {
    const med = makeMed({ currentPills: 20, dailyDose: 1, lastSyncDate: '2024-01-10' });
    const result = settleAndAdjust(med, 15, '2024-01-10');
    // effPills = 20 (0 days passed). 20 + 15 = 35.
    expect(result.updatedMed.currentPills).toBe(35);
    expect(result.updatedMed.lastSyncDate).toBe('2024-01-10');
  });

  it('clamps at 0 when the delta would make the balance negative', () => {
    const med = makeMed({ currentPills: 5, dailyDose: 10, lastSyncDate: '2024-01-01' });
    // effPills = max(0, 5 - 10*9) → 0. -5 → 0.
    const result = settleAndAdjust(med, -5, '2024-01-10');
    expect(result.updatedMed.currentPills).toBe(0);
  });

  it('does not mutate the input medication', () => {
    const med = makeMed({ currentPills: 30 });
    const result = settleAndAdjust(med, 10, '2024-01-10');
    expect(med.currentPills).toBe(30); // unchanged
    expect(result.updatedMed).not.toBe(med);
  });

  it('respects autoDeductEnabled=false (effPills = currentPills)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-01', autoDeductEnabled: false });
    // auto-deduct off → effPills = 30 (no projection). +5 → 35.
    const result = settleAndAdjust(med, 5, '2024-01-10');
    expect(result.updatedMed.currentPills).toBe(35);
  });
});

describe('consumeDose (#77)', () => {
  it('consumes a dose from the alarm path (source: alarm)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'alarm', '2024-01-10');
    // effPills = 30 (0 days passed). dose = min(2, 30) = 2. newSnapshot = 28.
    expect(result.doseAmount).toBe(2);
    expect(result.updatedMed).not.toBeNull();
    expect(result.updatedMed!.currentPills).toBe(28);
    expect(result.updatedMed!.lastConsumedDate).toBe('2024-01-10');
    expect(result.updatedMed!.lastSyncDate).toBe('2024-01-10');
    expect(result.log).not.toBeNull();
    expect(result.log!.type).toBe('dose_taken');
    expect(result.log!.amount).toBe(-2);
    expect(result.log!.description).toContain('من التنبيه');
    // Uses generateId('consume') — not 'consume-' + Date.now() (#64).
    expect(result.log!.id).toMatch(/^consume-/);
  });

  it('consumes a dose from the manual path (source: manual)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'manual', '2024-01-10');
    expect(result.doseAmount).toBe(2);
    expect(result.updatedMed!.currentPills).toBe(28);
    expect(result.log!.description).toContain('يدوياً');
  });

  it('returns null (no consumption) when the effective balance is 0', () => {
    const med = makeMed({ currentPills: 0, dailyDose: 2, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'manual', '2024-01-10');
    expect(result.doseAmount).toBe(0);
    expect(result.updatedMed).toBeNull();
    expect(result.log).toBeNull();
  });

  it('returns null when the dailyDose is 0 (no consumption rate)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 0, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'manual', '2024-01-10');
    expect(result.doseAmount).toBe(0);
    expect(result.updatedMed).toBeNull();
    expect(result.log).toBeNull();
  });

  it('clamps the dose to the effective balance (partial consumption)', () => {
    const med = makeMed({ currentPills: 1, dailyDose: 5, lastSyncDate: '2024-01-10' });
    // effPills = 1. dose = min(5, 1) = 1. newSnapshot = 0.
    const result = consumeDose(med, 'alarm', '2024-01-10');
    expect(result.doseAmount).toBe(1);
    expect(result.updatedMed!.currentPills).toBe(0);
  });

  it('projects the effective balance forward before consuming (app was closed for days)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-01' });
    // 9 days passed → effPills = 30 - 18 = 12. dose = min(2, 12) = 2. newSnapshot = 10.
    const result = consumeDose(med, 'manual', '2024-01-10');
    expect(result.doseAmount).toBe(2);
    expect(result.updatedMed!.currentPills).toBe(10);
  });

  it('does not mutate the input medication', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-10' });
    consumeDose(med, 'alarm', '2024-01-10');
    expect(med.currentPills).toBe(30);
    expect(med.lastConsumedDate).toBeUndefined();
  });

  it('uses generateId("consume") for the log id (not Date.now() — #64)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'manual', '2024-01-10');
    // generateId('consume') → 'consume-<uuid>' (40 chars). Not 'consume-<timestamp>'.
    expect(result.log!.id).toMatch(/^consume-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
