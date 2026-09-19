import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  effectiveCurrentPills,
  effectiveDaysLeft,
  getCriticalAlarmDate,
  getTodayDateString,
} from '@/utils/dateCalculations';
import { NEVER_DEPLETES_DAYS } from '@/utils/time';
import type { Medication } from '@/types';

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
    lastSyncDate: '2024-09-01',
    autoDeductEnabled: true,
    ...overrides,
  };
}

// Wave 13 #123: pin system time so the getTodayDateString() calls used
// by some `it` blocks (lines ~331, ~379) resolve to a deterministic
// date (2024-09-10T12:00:00Z). Prevents midnight-UTC flake risk where
// the test process's wall-clock date rolls over mid-run.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('effectiveCurrentPills', () => {
  it('returns currentPills when 0 days have passed', () => {
    const med = makeMed({ currentPills: 60, dailyDose: 2, lastSyncDate: '2024-09-10' });
    expect(effectiveCurrentPills(med, '2024-09-10')).toBe(60);
  });

  it('deducts dailyDose × daysPassed for normal elapsed days', () => {
    // Stored 60, dose 2/day, 9 days passed → 60 - 9*2 = 42
    const med = makeMed({ currentPills: 60, dailyDose: 2, lastSyncDate: '2024-09-01' });
    expect(effectiveCurrentPills(med, '2024-09-10')).toBe(42);
  });

  it('clamps at zero when the app was closed for 30+ days', () => {
    // Stored 60, dose 2/day, 30 days passed → 60 - 60 = 0 (would be -60 without clamp)
    const med = makeMed({ currentPills: 60, dailyDose: 2, lastSyncDate: '2024-09-01' });
    expect(effectiveCurrentPills(med, '2024-10-01')).toBe(0);
    // 60 days → still 0, not negative
    expect(effectiveCurrentPills(med, '2024-10-31')).toBe(0);
  });

  it('returns currentPills unchanged when autoDeductEnabled === false', () => {
    const med = makeMed({
      currentPills: 60,
      dailyDose: 2,
      lastSyncDate: '2024-09-01',
      autoDeductEnabled: false,
    });
    // 9 days "passed" but auto-deduct is off → balance stays at the snapshot.
    expect(effectiveCurrentPills(med, '2024-09-10')).toBe(60);
    // 30 days → still 60 (frozen).
    expect(effectiveCurrentPills(med, '2024-10-01')).toBe(60);
  });

  it('returns currentPills unchanged when dailyDose <= 0', () => {
    const med = makeMed({
      currentPills: 60,
      dailyDose: 0,
      lastSyncDate: '2024-09-01',
    });
    expect(effectiveCurrentPills(med, '2024-09-10')).toBe(60);
  });

  it('manual-consume-today interaction: lastSyncDate === today → no re-deduction', () => {
    // The consume handler sets currentPills -= dose AND lastSyncDate = today.
    // With lastSyncDate === today, daysPassed = 0, so effectiveCurrentPills
    // returns currentPills as-is — no double-deduction of the manual dose.
    const med = makeMed({
      currentPills: 28, // 30 - 2 (manually consumed today)
      dailyDose: 2,
      lastSyncDate: '2024-09-10',
      lastConsumedDate: '2024-09-10',
    });
    expect(effectiveCurrentPills(med, '2024-09-10')).toBe(28);
  });

  it('defaults lastSyncDate to today when missing', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '' });
    // Empty lastSyncDate → defaults to today → daysPassed 0 → no deduction.
    expect(effectiveCurrentPills(med, '2024-09-10')).toBe(30);
  });

  it('refill scenario: projecting from a settled snapshot ignores past consumption', () => {
    // User refilled 60 on 2024-09-10 (lastSyncDate set to 2024-09-10 with
    // currentPills 60). 5 days later, the balance should be 60 - 5*2 = 50.
    const med = makeMed({
      currentPills: 60,
      dailyDose: 2,
      lastSyncDate: '2024-09-10',
    });
    expect(effectiveCurrentPills(med, '2024-09-15')).toBe(50);
  });
});

describe('effectiveDaysLeft', () => {
  it(`returns ${NEVER_DEPLETES_DAYS} when dailyDose <= 0`, () => {
    const med = makeMed({ currentPills: 30, dailyDose: 0 });
    expect(effectiveDaysLeft(med, '2024-09-10')).toBe(NEVER_DEPLETES_DAYS);
  });

  it('returns 0 when effective balance <= 0', () => {
    const med = makeMed({
      currentPills: 4,
      dailyDose: 2,
      lastSyncDate: '2024-09-01',
    });
    // 9 days passed, dose 2 → 4 - 18 = -14 → clamped 0 → daysLeft 0
    expect(effectiveDaysLeft(med, '2024-09-10')).toBe(0);
  });

  it('computes floor(effectivePills / dailyDose)', () => {
    const med = makeMed({
      currentPills: 60,
      dailyDose: 2,
      lastSyncDate: '2024-09-01',
    });
    // 9 days passed → 60 - 18 = 42 → 42 / 2 = 21
    expect(effectiveDaysLeft(med, '2024-09-10')).toBe(21);
  });
});

describe('getCriticalAlarmDate', () => {
  it('returns null when dailyDose <= 0 (no consumption rate)', () => {
    const med = makeMed({
      currentPills: 30,
      dailyDose: 0,
      warningThresholdDays: 5,
      lastSyncDate: '2024-09-10',
    });
    expect(getCriticalAlarmDate(med, '2024-09-10')).toBeNull();
  });

  it('returns null when the med is already at/below critical threshold (the existing alert effect handles immediate notifications)', () => {
    // warningThresholdDays 5 → critical threshold 2.
    // currentPills 2, dose 1 → daysLeft 2 → at critical threshold.
    // The one-shot alarm is only for FUTURE crossings; returning null
    // here prevents repeated immediate alerts on every app launch.
    const med = makeMed({
      currentPills: 2,
      dailyDose: 1,
      warningThresholdDays: 5,
      lastSyncDate: '2024-09-10',
    });
    expect(getCriticalAlarmDate(med, '2024-09-10')).toBeNull();
  });

  it('returns null when currentPills is 0 (already out of stock)', () => {
    const med = makeMed({
      currentPills: 0,
      dailyDose: 1,
      warningThresholdDays: 5,
      lastSyncDate: '2024-09-10',
    });
    expect(getCriticalAlarmDate(med, '2024-09-10')).toBeNull();
  });

  it('returns a future timestamp when the med has enough supply', () => {
    // currentPills 30, dose 1, warningThresholdDays 5 → critical threshold 2.
    // daysLeft 30 → daysUntilCritical = 30 - 2 = 28 days from now.
    const med = makeMed({
      currentPills: 30,
      dailyDose: 1,
      warningThresholdDays: 5,
      lastSyncDate: getTodayDateString(),
    });
    const now = new Date('2024-09-10T12:00:00').getTime();
    const result = getCriticalAlarmDate(med, getTodayDateString());
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(now);
    // The scheduled time is local 09:00 on (today + 28 days).
    // #92: the function now uses UTC day arithmetic (consistent with
    // the rest of the module) then converts to local 9 AM. Verify the
    // result is at 9 AM local on the target date.
    const resultDate = new Date(result!);
    expect(resultDate.getHours()).toBe(9);
    expect(resultDate.getMinutes()).toBe(0);
  });

  it('returns null for a frozen med (autoDeduct off) with sufficient balance', () => {
    // Balance frozen at 30 → won't deplete. No future crossing.
    const med = makeMed({
      currentPills: 30,
      dailyDose: 1,
      warningThresholdDays: 5,
      lastSyncDate: '2024-09-10',
      autoDeductEnabled: false,
    });
    expect(getCriticalAlarmDate(med, '2024-09-10')).toBeNull();
  });

  it('returns null for a frozen med that is ALREADY critical', () => {
    // Frozen at 2, dose 1, threshold 2 → already critical → null
    // (the existing alert effect handles immediate notifications;
    // no future crossing to schedule).
    const med = makeMed({
      currentPills: 2,
      dailyDose: 1,
      warningThresholdDays: 5,
      lastSyncDate: '2024-09-10',
      autoDeductEnabled: false,
    });
    expect(getCriticalAlarmDate(med, '2024-09-10')).toBeNull();
  });

  it('reschedules when warningThresholdDays changes (higher threshold = earlier alarm)', () => {
    // 30 pills, dose 1, threshold 5 → daysUntilCritical = 25.
    // threshold 10 → daysUntilCritical = 20 (fires 5 days earlier).
    const med1 = makeMed({
      currentPills: 30,
      dailyDose: 1,
      warningThresholdDays: 5,
      lastSyncDate: getTodayDateString(),
    });
    const med2 = { ...med1, warningThresholdDays: 10 };
    const r1 = getCriticalAlarmDate(med1, getTodayDateString());
    const r2 = getCriticalAlarmDate(med2, getTodayDateString());
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    // The new (threshold=10) alarm fires 5 days earlier (20 vs 25 days out).
    expect(r2!).toBeLessThan(r1!);
  });

  it('projects the alarm date from the dynamic balance (not the raw snapshot)', () => {
    // Stored 30, dose 1, lastSync 30 days ago → effective 0 → ALREADY
    // critical → returns null (no future alarm; existing alert effect
    // handles the immediate notification on app open).
    const med = makeMed({
      currentPills: 30,
      dailyDose: 1,
      warningThresholdDays: 5,
      lastSyncDate: '2024-08-11', // 30 days before 2024-09-10
    });
    expect(getCriticalAlarmDate(med, '2024-09-10')).toBeNull();
  });
});
