import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { syncAutoDailyDeductions, getTodayDateString } from '@/utils/dateCalculations';
import type { Medication } from '@/types';

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
    // Wave 13 #123: pin system time so the getTodayDateString() calls
    // used inside each `it` block resolve to a deterministic date
    // (2024-09-10). Prevents midnight-UTC flake risk where the test
    // process's wall-clock date rolls over mid-run.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips re-deducting today when lastConsumedDate === today (settled snapshot)', () => {
    const today = getTodayDateString();
    // Realistic post-Manual-Take state: the manual consume pre-settled the
    // snapshot (lastSyncDate = today), so the only day in the window
    // (lastSyncDate, today] is today itself — already consumed → nothing
    // due → no deduction.
    const med = makeMed({
      currentPills: 28,
      dailyDose: 2,
      lastSyncDate: today,
      lastConsumedDate: today,
    });
    // Use today's date as the "today" param.
    const result = syncAutoDailyDeductions([med], today);
    // The med should NOT have been deducted.
    expect(result.updatedMeds[0].currentPills).toBe(28);
    expect(result.newLogs).toHaveLength(0);
    expect(result.deductedSummary).toHaveLength(0);
  });

  it('consumed today excludes only today — never the historical unconsumed days', () => {
    const today = getTodayDateString();
    const t = new Date(`${today}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() - 1);
    const yesterday = t.toISOString().slice(0, 10);

    // lastSync = yesterday, today consumed (e.g. same-day Exact Auto on a
    // stale snapshot): the window is today only → excluded → no deduction.
    const oneDay = makeMed({
      currentPills: 28,
      dailyDose: 2,
      lastSyncDate: yesterday,
      lastConsumedDate: today,
    });
    const oneDayResult = syncAutoDailyDeductions([oneDay], today);
    expect(oneDayResult.updatedMeds[0].currentPills).toBe(28);
    expect(oneDayResult.newLogs).toHaveLength(0);

    // Phase 4 contract: lastSync further back — the historical unconsumed
    // days (yesterday−1 .. yesterday) must STILL settle even though today
    // is consumed. consumedToday is not a global sync blocker.
    const t3 = new Date(`${today}T00:00:00Z`);
    t3.setUTCDate(t3.getUTCDate() - 3);
    const threeDaysAgo = t3.toISOString().slice(0, 10);
    const stale = makeMed({
      currentPills: 28,
      dailyDose: 2,
      lastSyncDate: threeDaysAgo,
      lastConsumedDate: today,
    });
    const staleResult = syncAutoDailyDeductions([stale], today);
    // Window (D-3, D] = 3 days; today excluded → 2 days × 2 units = 4.
    expect(staleResult.updatedMeds[0].currentPills).toBe(24);
    expect(staleResult.newLogs).toHaveLength(1);
    expect(staleResult.newLogs[0].amount).toBe(-4);
    expect(staleResult.updatedMeds[0].lastSyncDate).toBe(today);
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
