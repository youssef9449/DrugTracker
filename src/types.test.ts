import { describe, it, expect } from 'vitest';
import {
  calculateMedicationStatus,
  getCriticalThresholdDays,
  type Medication,
} from './types';
import { getTodayDateString } from './utils/dateCalculations';
import { NEVER_DEPLETES_DAYS } from './utils/time';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-test',
    name: 'Test',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: getTodayDateString(),
    ...overrides,
  };
}

describe('getCriticalThresholdDays', () => {
  it('returns warningThresholdDays directly (no derived sub-threshold)', () => {
    expect(getCriticalThresholdDays(makeMed({ warningThresholdDays: 5 }))).toBe(5);
    expect(getCriticalThresholdDays(makeMed({ warningThresholdDays: 7 }))).toBe(7);
    expect(getCriticalThresholdDays(makeMed({ warningThresholdDays: 10 }))).toBe(10);
    expect(getCriticalThresholdDays(makeMed({ warningThresholdDays: 1 }))).toBe(1);
  });

  it('falls back to 5 when warningThresholdDays is 0/missing', () => {
    expect(getCriticalThresholdDays(makeMed({ warningThresholdDays: 0 }))).toBe(5);
  });
});

describe('calculateMedicationStatus', () => {
  it('returns out_of_stock when currentPills <= 0', () => {
    const s = calculateMedicationStatus(makeMed({ currentPills: 0, dailyDose: 1 }));
    expect(s.status).toBe('out_of_stock');
    expect(s.daysLeft).toBe(0);
  });

  it('returns sufficient when dailyDose <= 0', () => {
    const s = calculateMedicationStatus(makeMed({ currentPills: 10, dailyDose: 0 }));
    expect(s.status).toBe('sufficient');
    expect(s.daysLeft).toBe(NEVER_DEPLETES_DAYS);
  });

  it('returns critical when daysLeft <= warningThresholdDays (the user-configured threshold)', () => {
    // warningThresholdDays 5, currentPills 5 → daysLeft 5 → critical
    expect(
      calculateMedicationStatus(makeMed({ currentPills: 5, dailyDose: 1 })).status
    ).toBe('critical');
    // warningThresholdDays 5, currentPills 4 → daysLeft 4 → critical
    expect(
      calculateMedicationStatus(makeMed({ currentPills: 4, dailyDose: 1 })).status
    ).toBe('critical');
    // warningThresholdDays 5, currentPills 1 → daysLeft 1 → critical
    expect(
      calculateMedicationStatus(makeMed({ currentPills: 1, dailyDose: 1 })).status
    ).toBe('critical');
  });

  it('threshold 7 means exactly 7 days is critical, 8 days is not', () => {
    expect(
      calculateMedicationStatus(
        makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })
      ).status
    ).toBe('critical');
    expect(
      calculateMedicationStatus(
        makeMed({ currentPills: 8, dailyDose: 1, warningThresholdDays: 7 })
      ).status
    ).toBe('sufficient');
  });

  it('threshold 7: 6 days is critical (not a separate warning tier)', () => {
    expect(
      calculateMedicationStatus(
        makeMed({ currentPills: 6, dailyDose: 1, warningThresholdDays: 7 })
      ).status
    ).toBe('critical');
  });

  it('no hidden derived critical threshold', () => {
    // With warningThresholdDays=10, the old code would derive critical=5.
    // Now: daysLeft=6 → critical (because 6 <= 10).
    expect(
      calculateMedicationStatus(
        makeMed({ currentPills: 6, dailyDose: 1, warningThresholdDays: 10 })
      ).status
    ).toBe('critical');
  });

  it('returns sufficient when daysLeft > warningThresholdDays', () => {
    expect(
      calculateMedicationStatus(
        makeMed({ currentPills: 30, dailyDose: 1, warningThresholdDays: 5 })
      ).status
    ).toBe('sufficient');
  });
});
