import { describe, it, expect } from 'vitest';
import { daysLeftFromCurrentStock } from '@/utils/dateCalculations';
import type { Medication } from '@/types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 40,
    dailyDose: 4,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-01-01',
    autoDeductEnabled: true,
    reminderEnabled: true,
    reminderTime: '20:00',
    doseSchedule: [{ id: 'd1', amount: 4, time: '20:00' }],
    ...overrides,
  };
}

describe('reminderTime does not project stock (Issue #266)', () => {
  it('reminder settings do not change durable currentPills daysLeft', () => {
    const withReminder = makeMed();
    const without = makeMed({ reminderEnabled: false, reminderTime: undefined });
    expect(daysLeftFromCurrentStock(withReminder)).toBe(10);
    expect(daysLeftFromCurrentStock(without)).toBe(10);
  });
});
