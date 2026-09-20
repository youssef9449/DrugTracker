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
    } as const;
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
    } as const;
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
