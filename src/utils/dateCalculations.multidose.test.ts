import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  effectiveCurrentPills,
  computeDueDoseBreakdown,
  hasDoseSchedule,
  isDoseConsumedOnDate,
  todayDueUnits,
  dailyScheduleAmount,
} from './dateCalculations';
import { consumeDose } from './medActions';
import type { Medication } from '../types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Drug A',
    currentPills: 30,
    dailyDose: 4,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-09-12',
    autoDeductEnabled: true,
    reminderEnabled: true,
    reminderTime: '08:00',
    doseSchedule: [
      { id: 'd1', amount: 2, time: '08:00' },
      { id: 'd2', amount: 1, time: '14:00' },
      { id: 'd3', amount: 1, time: '21:00' },
    ],
    dosesPerDay: 3,
    ...overrides,
  };
}

function at(isoLocal: string): Date {
  // isoLocal like '2024-09-12T10:00:00' interpreted as local
  return new Date(isoLocal);
}

describe('Phase 3 multi-dose due units', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hasDoseSchedule detects schedule', () => {
    expect(hasDoseSchedule(makeMed())).toBe(true);
    expect(hasDoseSchedule(makeMed({ doseSchedule: undefined }))).toBe(false);
  });

  it('dailyScheduleAmount sums slot amounts', () => {
    expect(dailyScheduleAmount(makeMed())).toBe(4);
  });

  it('before first dose: no units due same day after sync', () => {
    const med = makeMed({ lastSyncDate: '2024-09-12' });
    const now = at('2024-09-12T07:00:00');
    expect(todayDueUnits(med, now, '2024-09-12')).toBe(0);
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(30);
  });

  it('at 08:00: first dose due (2 units)', () => {
    const med = makeMed({ lastSyncDate: '2024-09-12' });
    const now = at('2024-09-12T08:00:00');
    expect(todayDueUnits(med, now, '2024-09-12')).toBe(2);
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(28);
  });

  it('at 13:59: only 08:00 due', () => {
    const med = makeMed({ lastSyncDate: '2024-09-12' });
    const now = at('2024-09-12T13:59:00');
    expect(todayDueUnits(med, now, '2024-09-12')).toBe(2);
  });

  it('at 14:00: first + second due', () => {
    const med = makeMed({ lastSyncDate: '2024-09-12' });
    const now = at('2024-09-12T14:00:00');
    expect(todayDueUnits(med, now, '2024-09-12')).toBe(3);
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(27);
  });

  it('at 22:00: all three due', () => {
    const med = makeMed({ lastSyncDate: '2024-09-12' });
    const now = at('2024-09-12T22:00:00');
    expect(todayDueUnits(med, now, '2024-09-12')).toBe(4);
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(26);
  });

  it('consuming dose A removes only A from today due', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-12',
      doseConsumption: { d1: '2024-09-12' },
    });
    const now = at('2024-09-12T15:00:00');
    expect(isDoseConsumedOnDate(med, 'd1', '2024-09-12')).toBe(true);
    expect(isDoseConsumedOnDate(med, 'd2', '2024-09-12')).toBe(false);
    expect(todayDueUnits(med, now, '2024-09-12')).toBe(1); // only 14:00
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(29);
  });

  it('multi-day catch-up counts full past days + partial today', () => {
    // lastSync Sep 10, today Sep 12 22:00 → Sep 11 full (4) + Sep 12 all (4) = 8
    const med = makeMed({ lastSyncDate: '2024-09-10', currentPills: 30 });
    const now = at('2024-09-12T22:00:00');
    const b = computeDueDoseBreakdown(med, now, '2024-09-12');
    expect(b.betweenDays).toBe(1); // Sep 11
    expect(b.pastDueUnits).toBe(4);
    expect(b.todayDueUnits).toBe(4);
    expect(b.fullDueUnits).toBe(8);
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(22);
  });
});

describe('Phase 3 consumeDose multi-dose', () => {
  it('consumes only the targeted dose id', () => {
    const med = makeMed({ lastSyncDate: '2024-09-12', currentPills: 30 });
    const now = at('2024-09-12T10:00:00');
    const result = consumeDose(med, 'manual', '2024-09-12', now, 'd1');
    expect(result.doseAmount).toBe(2);
    expect(result.updatedMed?.doseConsumption?.d1).toBe('2024-09-12');
    expect(result.updatedMed?.doseConsumption?.d2).toBeUndefined();
    expect(result.log?.doseId).toBe('d1');
  });

  it('does not double-consume the same dose the same day', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-12',
      doseConsumption: { d1: '2024-09-12' },
      currentPills: 28,
    });
    const now = at('2024-09-12T10:00:00');
    const result = consumeDose(med, 'manual', '2024-09-12', now, 'd1');
    expect(result.doseAmount).toBe(0);
    expect(result.updatedMed).toBeNull();
  });

  it('manual consume + projection never double-deducts', () => {
    const med = makeMed({ lastSyncDate: '2024-09-12', currentPills: 30 });
    const now = at('2024-09-12T10:00:00');
    // Before consume, 08:00 is projected (-2)
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(28);
    const result = consumeDose(med, 'manual', '2024-09-12', now, 'd1');
    expect(result.doseAmount).toBe(2);
    // After: d1 marked consumed; projection should not deduct d1 again
    expect(
      effectiveCurrentPills(result.updatedMed!, '2024-09-12', now)
    ).toBe(result.updatedMed!.currentPills);
  });

  it('legacy med still consumes via lastConsumedDate', () => {
    const med = makeMed({
      doseSchedule: undefined,
      dosesPerDay: undefined,
      dailyDose: 1,
      reminderTime: '20:00',
      lastSyncDate: '2024-09-12',
      currentPills: 10,
    });
    const now = at('2024-09-12T10:00:00');
    const result = consumeDose(med, 'manual', '2024-09-12', now);
    expect(result.doseAmount).toBe(1);
    expect(result.updatedMed?.lastConsumedDate).toBe('2024-09-12');
  });
});
