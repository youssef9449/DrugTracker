import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  effectiveCurrentPills,
  computeDueDoseBreakdown,
  hasDoseSchedule,
  isDoseConsumedOnDate,
  todayDueUnits,
  dailyScheduleAmount,
  syncAutoDailyDeductions,
  settleDoseChange,
  countDueAutoDoses,
  effectiveDaysLeft,
  historicalDayDueUnits,
} from './dateCalculations';
import { consumeDose, settleAndAdjust } from './medActions';
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
    expect(todayDueUnits(med, now, '2024-09-12')).toBe(1);
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(29);
  });

  it('multi-day catch-up counts full past days + partial today', () => {
    const med = makeMed({ lastSyncDate: '2024-09-10', currentPills: 30 });
    const now = at('2024-09-12T22:00:00');
    const b = computeDueDoseBreakdown(med, now, '2024-09-12');
    expect(b.betweenDays).toBe(1);
    expect(b.pastDueUnits).toBe(4);
    expect(b.todayDueUnits).toBe(4);
    expect(b.fullDueUnits).toBe(8);
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(22);
  });
});

describe('Phase 3B Example A — partial day boundary times', () => {
  const cases: Array<{ time: string; due: number }> = [
    { time: '07:59', due: 0 },
    { time: '08:00', due: 2 },
    { time: '13:59', due: 2 },
    { time: '14:00', due: 3 },
    { time: '20:59', due: 3 },
    { time: '21:00', due: 4 },
  ];
  for (const c of cases) {
    it(`at ${c.time}: ${c.due} units due`, () => {
      const med = makeMed({ lastSyncDate: '2024-09-12', currentPills: 40 });
      const now = at(`2024-09-12T${c.time}:00`);
      expect(todayDueUnits(med, now, '2024-09-12')).toBe(c.due);
      expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(40 - c.due);
    });
  }
});

describe('Phase 3B Example B — manual d1 no double deduction', () => {
  it('at 10:00 manual d1 deducts exactly 2', () => {
    const med = makeMed({ lastSyncDate: '2024-09-12', currentPills: 30 });
    const now = at('2024-09-12T10:00:00');
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(28);
    const result = consumeDose(med, 'manual', '2024-09-12', now, 'd1');
    expect(result.doseAmount).toBe(2);
    expect(result.updatedMed!.currentPills).toBe(28);
    expect(result.updatedMed!.doseConsumption!.d1).toBe('2024-09-12');
    expect(
      effectiveCurrentPills(result.updatedMed!, '2024-09-12', now)
    ).toBe(28);
  });
});

describe('Phase 3B Example C — manual d2 before scheduled time', () => {
  it('early d2 is recorded and never auto-deducted; d1 stays independent', () => {
    const med = makeMed({ lastSyncDate: '2024-09-12', currentPills: 30 });
    const now = at('2024-09-12T10:00:00');
    const result = consumeDose(med, 'manual', '2024-09-12', now, 'd2');
    expect(result.doseAmount).toBe(1);
    expect(result.updatedMed!.doseConsumption!.d2).toBe('2024-09-12');
    expect(result.updatedMed!.doseConsumption!.d1).toBeUndefined();
    expect(todayDueUnits(result.updatedMed!, now, '2024-09-12')).toBe(2);
    expect(effectiveCurrentPills(result.updatedMed!, '2024-09-12', now)).toBe(27);
    const later = at('2024-09-12T15:00:00');
    expect(todayDueUnits(result.updatedMed!, later, '2024-09-12')).toBe(2);
  });
});

describe('Phase 3B Example D — independent doses', () => {
  it('d1 manual + d2 auto + d3 future at 15:00', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-11',
      currentPills: 28,
      doseConsumption: { d1: '2024-09-12' },
    });
    const now = at('2024-09-12T15:00:00');
    expect(todayDueUnits(med, now, '2024-09-12')).toBe(1);
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(27);
  });
});

describe('Phase 3B Example E — historical catch-up', () => {
  it('Sep 7 lastSync → Sep 10 15:00 accounts for Sep 8+9 full and Sep 10 partial', () => {
    const med = makeMed({ lastSyncDate: '2024-09-07', currentPills: 40 });
    const now = at('2024-09-10T15:00:00');
    const b = computeDueDoseBreakdown(med, now, '2024-09-10');
    expect(b.betweenDays).toBe(2);
    expect(b.pastDueUnits).toBe(8);
    expect(b.todayDueUnits).toBe(3);
    expect(b.fullDueUnits).toBe(11);
    expect(effectiveCurrentPills(med, '2024-09-10', now)).toBe(29);
    const sync = syncAutoDailyDeductions([med], '2024-09-10', now);
    expect(sync.updatedMeds[0].currentPills).toBe(32);
    expect(sync.updatedMeds[0].lastSyncDate).toBe('2024-09-09');
    expect(
      effectiveCurrentPills(sync.updatedMeds[0], '2024-09-10', now)
    ).toBe(29);
  });
});

describe('Phase 3B Example F — all doses consumed', () => {
  it('no additional auto deduction when all slots consumed today', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-12',
      currentPills: 26,
      doseConsumption: {
        d1: '2024-09-12',
        d2: '2024-09-12',
        d3: '2024-09-12',
      },
      lastConsumedDate: '2024-09-12',
    });
    const now = at('2024-09-12T22:00:00');
    expect(todayDueUnits(med, now, '2024-09-12')).toBe(0);
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(26);
    const b = computeDueDoseBreakdown(med, now, '2024-09-12');
    expect(b.consumedToday).toBe(true);
    expect(b.fullDueUnits).toBe(0);
  });
});

describe('Phase 3B Example G — schedule edit keeps stable dose IDs', () => {
  it('changing amount/time does not transfer consumption history', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-12',
      doseConsumption: { d1: '2024-09-12', d2: '2024-09-11' },
    });
    const edited: Medication = {
      ...med,
      dailyDose: 5,
      doseSchedule: [
        { id: 'd1', amount: 3, time: '08:00' },
        { id: 'd2', amount: 1, time: '15:00' },
        { id: 'd3', amount: 1, time: '21:00' },
      ],
    };
    expect(isDoseConsumedOnDate(edited, 'd1', '2024-09-12')).toBe(true);
    expect(isDoseConsumedOnDate(edited, 'd2', '2024-09-11')).toBe(true);
    expect(isDoseConsumedOnDate(edited, 'd2', '2024-09-12')).toBe(false);
    const { updatedMed } = settleDoseChange(med, 5, '2024-09-12', at('2024-09-12T10:00:00'));
    expect(updatedMed.currentPills).toBe(30);
    expect(updatedMed.dailyDose).toBe(5);
  });

  it('removed dose id is ignored by projection (orphan key harmless)', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-12',
      doseConsumption: { d1: '2024-09-12', gone: '2024-09-12' },
      doseSchedule: [
        { id: 'd1', amount: 2, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dailyDose: 3,
      dosesPerDay: 2,
    });
    const now = at('2024-09-12T15:00:00');
    expect(todayDueUnits(med, now, '2024-09-12')).toBe(1);
  });
});

describe('Phase 3B Example H — legacy regression', () => {
  it('legacy gated med still uses dailyDose + lastConsumedDate', () => {
    const med = makeMed({
      doseSchedule: undefined,
      dosesPerDay: undefined,
      dailyDose: 2,
      reminderEnabled: true,
      reminderTime: '20:00',
      lastSyncDate: '2024-09-12',
      currentPills: 10,
    });
    const before = at('2024-09-12T10:00:00');
    expect(effectiveCurrentPills(med, '2024-09-12', before)).toBe(10);
    const after = at('2024-09-12T20:00:00');
    expect(effectiveCurrentPills(med, '2024-09-12', after)).toBe(8);
    const consumed = {
      ...med,
      lastConsumedDate: '2024-09-12',
      currentPills: 8,
      lastSyncDate: '2024-09-12',
    };
    expect(effectiveCurrentPills(consumed, '2024-09-12', after)).toBe(8);
  });

  it('yesterday consumption does not suppress today multi-dose', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-12',
      doseConsumption: { d1: '2024-09-11', d2: '2024-09-11', d3: '2024-09-11' },
    });
    const now = at('2024-09-12T22:00:00');
    expect(todayDueUnits(med, now, '2024-09-12')).toBe(4);
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
    expect(effectiveCurrentPills(med, '2024-09-12', now)).toBe(28);
    const result = consumeDose(med, 'manual', '2024-09-12', now, 'd1');
    expect(result.doseAmount).toBe(2);
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

  it('fallback without doseId picks earliest unconsumed slot', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-12',
      currentPills: 30,
      doseConsumption: { d1: '2024-09-12' },
    });
    const now = at('2024-09-12T16:00:00');
    const result = consumeDose(med, 'alarm', '2024-09-12', now);
    expect(result.doseAmount).toBe(1);
    expect(result.log?.doseId).toBe('d2');
  });
});

describe('Phase 3B countDueAutoDoses / days left', () => {
  it('countDueAutoDoses for multi is integer due dose-event count', () => {
    const med = makeMed({ lastSyncDate: '2024-09-12', currentPills: 30 });
    const now = at('2024-09-12T15:00:00');
    // d1 + d2 due at 15:00 → 2 events (not fractional units/dayAmt)
    expect(countDueAutoDoses(med, now, '2024-09-12')).toBe(2);
  });

  it('effectiveDaysLeft uses schedule total', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-12',
      currentPills: 40,
      autoDeductEnabled: false,
    });
    expect(effectiveDaysLeft(med, '2024-09-12')).toBe(10);
  });
});

describe('Phase 3B settleAndAdjust multi-dose', () => {
  it('refill settles past-only leaving today dynamic', () => {
    const med = makeMed({ lastSyncDate: '2024-09-10', currentPills: 30 });
    const now = at('2024-09-12T15:00:00');
    const { updatedMed } = settleAndAdjust(med, 10, '2024-09-12', now);
    expect(updatedMed.currentPills).toBe(36);
    expect(updatedMed.lastSyncDate).toBe('2024-09-11');
    expect(effectiveCurrentPills(updatedMed, '2024-09-12', now)).toBe(33);
  });
});

describe('Phase 3B BLOCKER — historical partial consumption (no double deduction)', () => {
  it('Scenario A: partial day rolls into tomorrow deducts only unconsumed slots', () => {
    // Day 1 Sep 12: d1+d2 manual, d3 not. Stock after = 37 from 40.
    // lastSync stays yesterday-style after partial consumes.
    const med = makeMed({
      lastSyncDate: '2024-09-11',
      currentPills: 37,
      doseConsumption: { d1: '2024-09-12', d2: '2024-09-12' },
      doseConsumptionHistory: {
        d1: ['2024-09-12'],
        d2: ['2024-09-12'],
      },
    });
    // Day 2 Sep 13 10:00 — Sep 12 is historical
    const now = at('2024-09-13T10:00:00');
    const b = computeDueDoseBreakdown(med, now, '2024-09-13');
    // Sep 12 historical: only d3 (1 unit) still due
    expect(b.pastDueUnits).toBe(1);
    // Today Sep 13 10:00: d1 due (2)
    expect(b.todayDueUnits).toBe(2);
    expect(b.fullDueUnits).toBe(3);
    expect(effectiveCurrentPills(med, '2024-09-13', now)).toBe(34);
  });

  it('Scenario B: only d1 consumed historically → deduct d2+d3', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-11',
      currentPills: 38,
      doseConsumption: { d1: '2024-09-12' },
      doseConsumptionHistory: { d1: ['2024-09-12'] },
    });
    const now = at('2024-09-13T07:00:00');
    const b = computeDueDoseBreakdown(med, now, '2024-09-13');
    expect(b.pastDueUnits).toBe(2); // d2+d3
    expect(b.todayDueUnits).toBe(0);
    expect(effectiveCurrentPills(med, '2024-09-13', now)).toBe(36);
  });

  it('Scenario C: all doses consumed historically → 0 past due', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-11',
      currentPills: 36,
      doseConsumption: {
        d1: '2024-09-12',
        d2: '2024-09-12',
        d3: '2024-09-12',
      },
      doseConsumptionHistory: {
        d1: ['2024-09-12'],
        d2: ['2024-09-12'],
        d3: ['2024-09-12'],
      },
      lastConsumedDate: '2024-09-12',
    });
    const now = at('2024-09-13T10:00:00');
    const b = computeDueDoseBreakdown(med, now, '2024-09-13');
    expect(b.pastDueUnits).toBe(0);
  });

  it('Scenario D: no recorded history → full schedule fallback', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-11',
      currentPills: 40,
      // no doseConsumption / history
    });
    const now = at('2024-09-13T07:00:00');
    const b = computeDueDoseBreakdown(med, now, '2024-09-13');
    expect(b.pastDueUnits).toBe(4); // full Sep 12
  });

  it('Scenario E: consecutive partially-consumed days settled independently', () => {
    // Day1 Sep 10: only d1; Day2 Sep 11: d1+d2; Day3 Sep 12: nothing
    // lastSync Sep 9, today Sep 13 early
    const med = makeMed({
      lastSyncDate: '2024-09-09',
      currentPills: 40,
      doseConsumption: {
        d1: '2024-09-11', // last
        d2: '2024-09-11',
      },
      doseConsumptionHistory: {
        d1: ['2024-09-10', '2024-09-11'],
        d2: ['2024-09-11'],
      },
    });
    const now = at('2024-09-13T07:00:00');
    const b = computeDueDoseBreakdown(med, now, '2024-09-13');
    // Sep 10: d2+d3 = 2
    // Sep 11: d3 = 1
    // Sep 12: full = 4
    expect(b.betweenDays).toBe(3);
    expect(b.pastDueUnits).toBe(2 + 1 + 4);
    expect(b.todayDueUnits).toBe(0);
  });

  it('consumeDose writes history so later catch-up is correct', () => {
    let med = makeMed({ lastSyncDate: '2024-09-12', currentPills: 40 });
    const day1 = at('2024-09-12T10:00:00');
    let r = consumeDose(med, 'manual', '2024-09-12', day1, 'd1');
    med = r.updatedMed!;
    r = consumeDose(med, 'manual', '2024-09-12', at('2024-09-12T15:00:00'), 'd2');
    med = r.updatedMed!;
    expect(med.currentPills).toBe(37);
    expect(med.doseConsumptionHistory!.d1).toContain('2024-09-12');
    expect(med.doseConsumptionHistory!.d2).toContain('2024-09-12');

    // Next day
    const day2 = at('2024-09-13T10:00:00');
    const b = computeDueDoseBreakdown(med, day2, '2024-09-13');
    expect(b.pastDueUnits).toBe(1); // only d3 from Sep 12
    expect(effectiveCurrentPills(med, '2024-09-13', day2)).toBe(
      med.currentPills - 1 - 2 // past d3 + today d1
    );
  });

  it('pre-3B doseConsumption last-date alone still credits that day', () => {
    // Only last-date map, no history field (migrated readers treat as single-date history)
    const med = makeMed({
      lastSyncDate: '2024-09-11',
      currentPills: 38,
      doseConsumption: { d1: '2024-09-12' },
      // no doseConsumptionHistory
    });
    const now = at('2024-09-13T07:00:00');
    expect(computeDueDoseBreakdown(med, now, '2024-09-13').pastDueUnits).toBe(2);
  });

  it('schedule amount edit does not rewrite historical consumption identity', () => {
    const med = makeMed({
      lastSyncDate: '2024-09-12',
      doseConsumption: { d1: '2024-09-11' },
      doseConsumptionHistory: { d1: ['2024-09-11'] },
      doseSchedule: [
        { id: 'd1', amount: 3, time: '10:00' }, // was 2 @ 08:00
        { id: 'd2', amount: 1, time: '14:00' },
        { id: 'd3', amount: 1, time: '21:00' },
      ],
      dailyDose: 5,
    });
    // Recorded consume *date* survives amount/time edit (stable doseId).
    expect(isDoseConsumedOnDate(med, 'd1', '2024-09-11')).toBe(true);
    // Unrecorded historical slots use CURRENT schedule amounts (fallback,
    // not reconstructed past config): d1 skipped, d2+d3 = 1+1 = 2.
    expect(historicalDayDueUnits(med, '2024-09-11')).toBe(2);
  });

  it('unconsumed historical slot uses current amount after edit (documented fallback)', () => {
    // Yesterday d2 was never consumed; schedule later edits d2 1 → 5.
    const med = makeMed({
      lastSyncDate: '2024-09-11',
      currentPills: 40,
      doseSchedule: [
        { id: 'd1', amount: 2, time: '08:00' },
        { id: 'd2', amount: 5, time: '14:00' }, // edited
        { id: 'd3', amount: 1, time: '21:00' },
      ],
      dailyDose: 8,
      // no history for Sep 12
    });
    // Unknown-history day: full current schedule = 2+5+1 = 8 (not old 4)
    expect(historicalDayDueUnits(med, '2024-09-12')).toBe(8);
  });
});

