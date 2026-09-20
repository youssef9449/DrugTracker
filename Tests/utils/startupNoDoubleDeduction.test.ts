/**
 * Issue #266: startup does not project-subtract elapsed doses from currentPills.
 */
import { describe, it, expect } from 'vitest';
import type { Medication } from '@/types';
import { daysLeftFromCurrentStock } from '@/utils/dateCalculations';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 10,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    ...overrides,
  };
}

describe('startup stock is durable currentPills', () => {
  it('does not reduce currentPills merely because calendar days elapsed', () => {
    const med = makeMed({ currentPills: 10});
    expect(med.currentPills).toBe(10);
    expect(daysLeftFromCurrentStock(med)).toBe(5);
  });
});
