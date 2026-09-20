/**
 * Issue #266: live stock is durable currentPills only.
 * Take must mutate currentPills once; no read-time projection subtracts elapsed doses.
 */
import { describe, it, expect } from 'vitest';
import type { Medication } from '@/types';
import { consumeDose } from '@/utils/medActions';
import { isDoseConsumedOnDate } from '@/utils/dateCalculations';

const TODAY = '2026-09-14';
const NOW = new Date('2026-09-14T09:00:00');

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 1, time: '20:00' },
    ],
    ...overrides,
  };
}

describe('Take deducts durable currentPills once (no projection)', () => {
  it('elapsed dose time does not reduce currentPills until Take', () => {
    const med = makeMed();
    expect(med.currentPills).toBe(30);
    expect(isDoseConsumedOnDate(med, 'd1', TODAY)).toBe(false);
  });

  it('Manual/alarm Take deducts schedule amount once', () => {
    const med = makeMed();
    const take = consumeDose(med, 'alarm', TODAY, NOW, 'd1');
    expect(take.ok).toBe(true);
    if (!take.ok) return;
    expect(take.updatedMed.currentPills).toBe(29);
    expect(isDoseConsumedOnDate(take.updatedMed, 'd1', TODAY)).toBe(true);
    // Second take same slot must not double-deduct.
    const again = consumeDose(take.updatedMed, 'alarm', TODAY, NOW, 'd1');
    expect(again.ok).toBe(false);
  });
});
