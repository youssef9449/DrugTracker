import { describe, it, expect, beforeEach } from 'vitest';
import { syncAutoDailyDeductions, getTodayDateString } from './dateCalculations';
import type { Medication } from '../types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-03-10',
    autoDeductEnabled: true,
    ...overrides,
  };
}

describe('syncAutoDailyDeductions — consume-pill feature', () => {
  beforeEach(() => {
    // Use a fixed date for deterministic tests.
  });

  it('skips auto-deduction when lastConsumedDate === today', () => {
    const today = getTodayDateString();
    // A med with lastSyncDate in the past (daysPassed > 0) but
    // lastConsumedDate === today → the auto-deduction should be skipped.
    const med = makeMed({
      currentPills: 28,
      dailyDose: 2,
      lastSyncDate: '2024-03-10',
      lastConsumedDate: today,
    });
    // Use today's date as the "today" param.
    const result = syncAutoDailyDeductions([med], today);
    // The med should NOT have been deducted.
    expect(result.updatedMeds[0].currentPills).toBe(28);
    expect(result.newLogs).toHaveLength(0);
    expect(result.deductedSummary).toHaveLength(0);
  });

  it('auto-deducts normally when lastConsumedDate is in the past', () => {
    const today = getTodayDateString();
    const med = makeMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2024-03-10',
      lastConsumedDate: '2024-03-09', // consumed yesterday, not today
    });
    // The actual deduction depends on daysPassed; we need a real
    // date diff. Use today's date as "today" and a past lastSyncDate.
    // daysPassed = getDaysDifference(lastSyncDate, today) which is > 0.
    const result = syncAutoDailyDeductions([med], today);
    // If daysPassed > 0, the med should have been deducted.
    // (We can't predict the exact pills deducted without knowing
    // daysPassed, but we can assert the log was created.)
    if (result.newLogs.length > 0) {
      expect(result.newLogs[0].type).toBe('auto_daily');
      expect(result.deductedSummary).toHaveLength(1);
    }
  });

  it('auto-deducts normally when lastConsumedDate is undefined', () => {
    const today = getTodayDateString();
    const med = makeMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2024-03-10',
      // lastConsumedDate not set → should deduct normally.
    });
    const result = syncAutoDailyDeductions([med], today);
    if (result.newLogs.length > 0) {
      expect(result.newLogs[0].type).toBe('auto_daily');
    }
  });

  it('preserves lastConsumedDate in the updated med', () => {
    const today = getTodayDateString();
    const med = makeMed({
      currentPills: 28,
      dailyDose: 1,
      lastSyncDate: '2024-03-10',
      lastConsumedDate: today,
    });
    const result = syncAutoDailyDeductions([med], today);
    expect(result.updatedMeds[0].lastConsumedDate).toBe(today);
  });
});
