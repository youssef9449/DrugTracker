import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  daysLeftFromCurrentStock,
  getCriticalAlarmDate,
  getDepletionDate,
  getTodayDateString } from '@/utils/dateCalculations';
import { calculateMedicationStatus } from '@/types';
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
    autoDeductEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Issue #266 — durable currentPills is sole live stock', () => {
  it('calendar days alone do not reduce durable currentPills or daysLeft', () => {
    const med = makeMed({
      currentPills: 100,
      dailyDose: 10,
      doseSchedule: [{ id: 'd1', amount: 10, time: '08:00' }],
    });
    expect(med.currentPills).toBe(100);
    expect(daysLeftFromCurrentStock(med)).toBe(10);
    expect(getDepletionDate(med).daysLeft).toBe(10);
    expect(calculateMedicationStatus(med).daysLeft).toBe(10);
  });

  it('multi-dose schedule uses current stock for daysLeft', () => {
    const med = makeMed({
      currentPills: 20,
      dailyDose: 5,
      doseSchedule: [
        { id: 'd1', amount: 2, time: '08:00' },
        { id: 'd2', amount: 3, time: '20:00' },
      ],
    });
    expect(daysLeftFromCurrentStock(med)).toBe(4);
    expect(getDepletionDate(med).daysLeft).toBe(4);
    expect(calculateMedicationStatus(med).daysLeft).toBe(4);
  });

  it('Auto OFF does not subtract from currentPills without a durable deduction', () => {
    const med = makeMed({
      currentPills: 20,
      autoDeductEnabled: false,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    expect(med.currentPills).toBe(20);
    expect(daysLeftFromCurrentStock(med)).toBe(10);
    expect(getCriticalAlarmDate(med)).toBeNull();
  });

  it('status and depletion agree on durable stock', () => {
    const med = makeMed({
      currentPills: 15,
      dailyDose: 3,
      doseSchedule: [{ id: 'd1', amount: 3, time: '09:00' }],
    });
    const status = calculateMedicationStatus(med);
    const depletion = getDepletionDate(med);
    expect(status.daysLeft).toBe(depletion.daysLeft);
    expect(status.daysLeft).toBe(5);
    expect(med.currentPills).toBe(15);
  });

  it('critical alarm date is derived from durable currentPills and schedule rate', () => {
    const base = {
      currentPills: 100,
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '08:00' }],
    };
    const a = makeMed({ ...base});
    const b = makeMed({ ...base});
    expect(getCriticalAlarmDate(a)).toBe(getCriticalAlarmDate(b));
    // daysLeft=10, threshold=5 → 5 days until critical
    expect(daysLeftFromCurrentStock(a)).toBe(10);
  });

  it('out of stock when currentPills <= 0', () => {
    const med = makeMed({ currentPills: 0, dailyDose: 2 });
    expect(daysLeftFromCurrentStock(med)).toBe(0);
    expect(calculateMedicationStatus(med).status).toBe('out_of_stock');
    expect(getDepletionDate(med).formattedArabic).toBe('نفد المخزون بالكامل');
  });

  it('zero consumption rate yields never-depletes sentinel', () => {
    const med = makeMed({
      currentPills: 50,
      dailyDose: 0,
      doseSchedule: [],
    });
    expect(daysLeftFromCurrentStock(med)).toBe(NEVER_DEPLETES_DAYS);
  });

  it('getTodayDateString is stable under pinned time', () => {
    expect(getTodayDateString()).toBe('2024-09-10');
  });

  it('warningThresholdDays is per-medication: higher threshold yields earlier critical alarm', () => {
    // Same stock + rate: daysLeft = 100/10 = 10.
    // threshold 5 → alarm in 5 days; threshold 8 → alarm in 2 days (earlier).
    const shared = {
      currentPills: 100,
      dailyDose: 10,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '08:00' }],
    };
    const med5 = makeMed({ ...shared, id: 'med-t5', warningThresholdDays: 5 });
    const med8 = makeMed({ ...shared, id: 'med-t8', warningThresholdDays: 8 });
    const today = getTodayDateString();
    const t5 = getCriticalAlarmDate(med5, today);
    const t8 = getCriticalAlarmDate(med8, today);
    expect(t5).not.toBeNull();
    expect(t8).not.toBeNull();
    expect(t5).not.toBe(t8);
    // Larger threshold ⇒ critical state reached sooner ⇒ earlier alarm timestamp.
    expect(t8!).toBeLessThan(t5!);
  });

  it('changing another medication threshold does not affect this medication alarm date', () => {
    const shared = {
      currentPills: 100,
      dailyDose: 10,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '08:00' }],
    };
    const medA = makeMed({ ...shared, id: 'med-a', warningThresholdDays: 5 });
    const medB5 = makeMed({ ...shared, id: 'med-b', warningThresholdDays: 5 });
    const medB8 = makeMed({ ...shared, id: 'med-b', warningThresholdDays: 8 });
    const today = getTodayDateString();
    const aBefore = getCriticalAlarmDate(medA, today);
    const b5 = getCriticalAlarmDate(medB5, today);
    const b8 = getCriticalAlarmDate(medB8, today);
    const aAfter = getCriticalAlarmDate(medA, today);
    expect(aBefore).toBe(aAfter);
    expect(aBefore).toBe(b5);
    expect(b8).not.toBe(b5);
    expect(b8!).toBeLessThan(b5!);
  });

});

describe('getCriticalAlarmDate — exact dose occurrence time', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Local noon so morning doses today are still in the future for some cases.
    vi.setSystemTime(new Date(2024, 8, 10, 12, 0, 0, 0)); // 2024-09-10 local
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns exact dose time 20:00, not 09:00, for single daily dose crossing', () => {
    // dayAmt=10, threshold=5 → critical when floor(pills/10) <= 5 i.e. pills <= 59
    // Start 70 → one 10-pill dose → 60 still ok (daysLeft=6); second dose → 50 critical.
    // With one dose/day at 20:00: daysLeft=7, need reduce to <=59 → after 2nd day dose? 
    // floor(70/10)=7 > 5; after -10 → 60, floor=6 > 5; after -10 → 50, floor=5 ≤ 5.
    // So 2nd occurrence at 20:00 tomorrow.
    const med = makeMed({
      currentPills: 70,
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '20:00' }],
    });
    const ts = getCriticalAlarmDate(med, '2024-09-10');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    expect(d.getHours()).toBe(20);
    expect(d.getMinutes()).toBe(0);
    expect(d.getHours()).not.toBe(9);
  });

  it('picks the exact multi-dose slot that first crosses the threshold', () => {
    // dayAmt=15 (10+5), threshold=1 → critical when floor(pills/15) <= 1 i.e. pills <= 29
    // Start 40: floor=2 > 1. After 08:00 dose -10 → 30, floor=2. After 20:00 -5 → 25, floor=1 critical.
    const med = makeMed({
      currentPills: 40,
      dailyDose: 15,
      warningThresholdDays: 1,
      autoDeductEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 10, time: '08:00' },
        { id: 'd2', amount: 5, time: '20:00' },
      ],
    });
    // now is 12:00 local → 08:00 today already past; 20:00 today is next
    // After skipping 08:00 past without deducting (already passed, not projected):
    // We skip past occurrences without deducting — so pills stay 40 until 20:00 -5 = 35 still floor=2.
    // Need careful fixture: make morning not yet passed OR account for skip.
    // Set now to 07:00 so both doses today are future.
    vi.setSystemTime(new Date(2024, 8, 10, 7, 0, 0, 0));
    const ts = getCriticalAlarmDate(med, '2024-09-10');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    expect(d.getHours()).toBe(20);
    expect(d.getMinutes()).toBe(0);
  });

  it('does not select a dose time that already passed today', () => {
    vi.setSystemTime(new Date(2024, 8, 10, 21, 0, 0, 0)); // after 20:00
    const med = makeMed({
      currentPills: 70,
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '20:00' }],
    });
    const ts = getCriticalAlarmDate(med, '2024-09-10');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    // Must be a future day at 20:00, not today
    expect(d.getDate()).toBeGreaterThan(10);
    expect(d.getHours()).toBe(20);
  });

  it('returns today\'s later dose when that occurrence causes the crossing', () => {
    vi.setSystemTime(new Date(2024, 8, 10, 7, 0, 0, 0));
    // dayAmt=10, threshold=5 → critical at pills<=59. Start 65 → one dose crosses.
    const med = makeMed({
      currentPills: 65,
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '20:00' }],
    });
    const ts = getCriticalAlarmDate(med, '2024-09-10');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(10);
    expect(d.getHours()).toBe(20);
  });

  it('returns null when Auto Deduct is OFF', () => {
    const med = makeMed({
      currentPills: 100,
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: false,
      doseSchedule: [{ id: 'd1', amount: 10, time: '20:00' }],
    });
    expect(getCriticalAlarmDate(med, '2024-09-10')).toBeNull();
  });

  it('returns null when already critical', () => {
    const med = makeMed({
      currentPills: 30, // daysLeft=3 <= 5
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '20:00' }],
    });
    expect(getCriticalAlarmDate(med, '2024-09-10')).toBeNull();
  });

  it('returns null when schedule is empty / zero rate', () => {
    const med = makeMed({
      currentPills: 100,
      dailyDose: 0,
      doseSchedule: [],
      warningThresholdDays: 5,
      autoDeductEnabled: true,
    });
    expect(getCriticalAlarmDate(med, '2024-09-10')).toBeNull();
  });

  it('future-day crossing uses that day\'s dose time, not 09:00', () => {
    vi.setSystemTime(new Date(2024, 8, 10, 12, 0, 0, 0));
    const med = makeMed({
      currentPills: 100,
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '20:00' }],
    });
    // daysLeft=10, critical at <=5 → after 5 doses of 10 (100→50)
    const ts = getCriticalAlarmDate(med, '2024-09-10');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    expect(d.getHours()).toBe(20);
    expect(d.getHours()).not.toBe(9);
  });
});

describe('getCriticalAlarmDate — bulk-jump performance path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 8, 10, 12, 0, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('very large stock returns correct future dose time without per-day simulation', () => {
    // 1_000_000 pills, 1/day, threshold 5 → critical when floor(pills) <= 5 i.e. pills <= 5
    // After today (past 12:00, so today 20:00 still future): one dose → 999999
    // Need to reach <=5 → requiredDeduction ~999994 from after today? 
    // Actually process today first: 1000000-1=999999 at 20:00 if today 20:00 is future.
    // Then need 999999-5=999994 more → 999994 more days of 1 → crossing day far out.
    const med = makeMed({
      currentPills: 1_000_000,
      dailyDose: 1,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
    });
    const ts = getCriticalAlarmDate(med, '2024-09-10');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    expect(d.getHours()).toBe(20);
    expect(d.getMinutes()).toBe(0);
    // Critical when pills after dose <= 5. Start 1e6; today 20:00 → 999999 still ok.
    // Need pills to become 5 after a dose: before dose = 6. Days of full 1 after today to get to 6:
    // 999999 - 6 = 999993 full days, then next day dose 6→5 crosses.
    // Crossing date = 2024-09-11 + 999993 days.
    const expected = new Date(2024, 8, 11);
    expected.setDate(expected.getDate() + 999993);
    expected.setHours(20, 0, 0, 0);
    expect(ts).toBe(expected.getTime());
  });

  it('large stock multi-dose picks the exact crossing slot', () => {
    // dayAmt=15, threshold=1 → criticalPillsLimit = 2*15-1 = 29
    // Start 10000. Today 12:00: 18:00 and 22:00 both future.
    // After full days... verify hour is either 18 or 22 depending on math.
    const med = makeMed({
      currentPills: 10_000,
      dailyDose: 15,
      warningThresholdDays: 1,
      autoDeductEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 10, time: '18:00' },
        { id: 'd2', amount: 5, time: '22:00' },
      ],
    });
    const ts = getCriticalAlarmDate(med, '2024-09-10');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    expect([18, 22]).toContain(d.getHours());
    // Recompute with a tiny stock to know which slot: start 40 at 07:00 was d2.
    // For large stock, same slot pattern on the crossing day: enter day with pills such that
    // after first 10 still >29, after second 5 crosses — or after first crosses.
    // criticalPillsLimit=29. If enter with 35: 35-10=25 <=29 → 18:00.
    // If enter with 40: 40-10=30 >29; 30-5=25 <=29 → 22:00.
    // After N full days pills = 10000 - (today partial if any) - N*15.
    // Today: 10000-10-5=9985 if both fire. required = 9985-29=9956; ceil(9956/15)=664 days.
    // daysBeforeCrossing = 663; after 663 days pills = 9985-663*15 = 9985-9945=40.
    // Enter crossing day with 40 → 22:00 crosses.
    expect(d.getHours()).toBe(22);
  });

  it('exception date after a large normal block still yields exact timestamp', () => {
    // Mark a far-future date as skipped so the path must process that exception.
    const med = makeMed({
      currentPills: 500,
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '20:00' }],
      doseSkippedHistory: { d1: ['2024-10-01'] },
    });
    const ts = getCriticalAlarmDate(med, '2024-09-10');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    expect(d.getHours()).toBe(20);
    // Compare against a no-history med — skipped day should delay or equal later.
    const plain = makeMed({
      currentPills: 500,
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '20:00' }],
    });
    const tsPlain = getCriticalAlarmDate(plain, '2024-09-10');
    expect(tsPlain).not.toBeNull();
    expect(ts!).toBeGreaterThanOrEqual(tsPlain!);
  });

  it('consumed occurrence before mathematical crossing delays the alarm', () => {
    const base = makeMed({
      currentPills: 80,
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '20:00' }],
    });
    const t0 = getCriticalAlarmDate(base, '2024-09-10');
    expect(t0).not.toBeNull();

    const withSkip = {
      ...base,
      doseConsumptionHistory: { d1: ['2024-09-11'] },
    };
    const t1 = getCriticalAlarmDate(withSkip, '2024-09-10');
    expect(t1).not.toBeNull();
    expect(t1!).toBeGreaterThan(t0!);
  });

  it('today later dose still returns exact time when it crosses', () => {
    // Start 65, dayAmt 10, threshold 5 → critical at pills<=59 after dose
    // 65-10=55 → crosses today at 20:00
    const med = makeMed({
      currentPills: 65,
      dailyDose: 10,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 10, time: '20:00' }],
    });
    const ts = getCriticalAlarmDate(med, '2024-09-10');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(10);
    expect(d.getHours()).toBe(20);
  });

  it('fractional dose amounts cross at exact 20:00 slot', () => {
    // dayAmt = 2.5, threshold 5 → Critical when floor(pills/2.5) <= 5
    // i.e. pills < 15. Start 17 (floor=6). Use early clock so both slots today are future.
    vi.setSystemTime(new Date(2024, 8, 10, 6, 0, 0, 0));
    const med = makeMed({
      currentPills: 17,
      dailyDose: 2.5,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 2, time: '08:00' },
        { id: 'd2', amount: 0.5, time: '20:00' },
      ],
    });
    // Today: 17-2=15 (floor 6), 15-0.5=14.5 (floor 5) → Critical today 20:00
    // User scenario wants tomorrow if only future relative to "before doses".
    // With both today future, crossing is today 20:00.
    const tsToday = getCriticalAlarmDate(med, '2024-09-10');
    expect(tsToday).not.toBeNull();
    const dToday = new Date(tsToday!);
    expect(dToday.getDate()).toBe(10);
    expect(dToday.getHours()).toBe(20);

    // After today is fully past, same stock still 17 (no durable change) → tomorrow 20:00
    // if we only project future: set clock after 20:00 so today contributes nothing.
    vi.setSystemTime(new Date(2024, 8, 10, 21, 0, 0, 0));
    const ts = getCriticalAlarmDate(med, '2024-09-10');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(11);
    expect(d.getHours()).toBe(20);
    expect(d.getMinutes()).toBe(0);
  });

  it('IEEE-754 0.1+0.2 boundary does not treat 1.8 stock as already Critical', () => {
    vi.setSystemTime(new Date(2024, 8, 10, 6, 0, 0, 0));
    const med = makeMed({
      currentPills: 1.8,
      dailyDose: 0.3,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 0.1, time: '08:00' },
        { id: 'd2', amount: 0.2, time: '20:00' },
      ],
    });
    // Starting stock is mathematically 6 days left → not already Critical.
    expect(daysLeftFromCurrentStock(med)).toBe(6);
    const ts = getCriticalAlarmDate(med, '2024-09-10');
    expect(ts).not.toBeNull();
    // First future dose 08:00: 1.8 - 0.1 = 1.7 → floor(1.7/0.3)=5 ≤ 5 → Critical.
    const d = new Date(ts!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(10);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(0);
  });

  it('fractional schedule bulk-jump: exact integer ratio that raw float misses', () => {
    // dayAmt = 0.1 + 0.2 = 0.30000000000000004 (IEEE-754)
    // threshold = 3, start = 2.1
    // floorRatioSafely(2.1, 0.30000000000000004) = 7 (mathematically 7 exact)
    // 7 - 3 = 4 fullDaysNeeded → after 3 full normal days, 4th day slot-by-slot.
    // But raw float: Math.floor((2.1 - (3+1)*0.30000000000000004) / 0.30000000000000004) + 1
    // = Math.floor((2.1 - 1.2000000000000002) / 0.30000000000000004) + 1
    // = Math.floor(0.8999999999999998 / 0.30000000000000004) + 1
    // = Math.floor(2.9999999999999996) + 1 = 3 → wrong (should be 4).
    // This test verifies the floorRatioSafely-based fullDaysNeeded is correct.
    vi.setSystemTime(new Date(2024, 8, 10, 21, 0, 0, 0)); // after all today's doses
    const med = makeMed({
      currentPills: 2.1,
      dailyDose: 0.3,
      warningThresholdDays: 3,
      autoDeductEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 0.1, time: '08:00' },
        { id: 'd2', amount: 0.2, time: '20:00' },
      ],
    });
    expect(daysLeftFromCurrentStock(med)).toBe(7);
    const ts = getCriticalAlarmDate(med, '2024-09-10');
    expect(ts).not.toBeNull();
    // After 3 full days (daysBeforeCrossing=3): pills = 2.1 - 3*0.30000000000000004 = 1.1999999999999997
    // Day 4 (2024-09-14): 08:00 dose -0.1 = 1.0999999999999997 → floor(1.0999.../0.3) = 3 ≤ 3 → Critical
    const d = new Date(ts!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(14);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(0);
  });

  it('large genuinely fractional ratio is not promoted to next integer', () => {
    // floorRatioSafely uses a one-ULP tolerance: only ratios within one
    // ULP below an integer are promoted. Genuine fractions at any
    // magnitude are not.
    //
    // ratio = 999999999999999.5, denominator = 1
    // nearestInteger = 1000000000000000
    // difference = 0.5
    // one ULP at this magnitude is much smaller than 0.5
    // therefore no promotion occurs
    // Math.floor(999999999999999.5) = 999999999999999 (correct)
    //
    // Use daysLeftFromCurrentStock as the public caller to verify.
    const med = makeMed({
      currentPills: 999999999999999.5,
      dailyDose: 1,
      warningThresholdDays: 5,
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    });
    expect(daysLeftFromCurrentStock(med)).toBe(999999999999999);
    // Verify it is NOT promoted to 999999999999999 + 1
    expect(daysLeftFromCurrentStock(med)).not.toBe(1000000000000000);
  });

});
