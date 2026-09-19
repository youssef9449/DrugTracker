import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  effectiveCurrentPills,
  countDueAutoDoses,
  computeDueDoseBreakdown,
} from '@/utils/dateCalculations';
import { consumeDose } from '@/utils/medActions';
import type { Medication } from '@/types';

/**
 * reminderTime-gated auto-deduction timing tests.
 *
 * The process TZ is forced to UTC in vitest.setup.ts, so the local
 * time-of-day of the mocked `now` instants is deterministic across
 * machines (e.g. `new Date('2026-09-11T15:00:00Z').getHours()` === 15).
 * reminderTime is the user's LOCAL dose time; in production the device's
 * real timezone is used, but for tests UTC makes the assertions exact.
 */

function makeRemindedMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2026-09-10',
    autoDeductEnabled: true,
    reminderEnabled: true,
    reminderTime: '20:00',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Helper: set the system clock to the given UTC instant and return a
 * `now` Date matching it (so the function under test gets the exact
 * moment the test intends, not the real wall clock).
 */
function at(utcIso: string): Date {
  const now = new Date(utcIso);
  vi.setSystemTime(now);
  return now;
}

describe('reminderTime-gated auto-deduction timing', () => {
  // ─── 1. before reminderTime → no deduction ─────────────────────────
  it('before reminderTime: today dose NOT due → balance = snapshot', () => {
    const now = at('2026-09-11T15:00:00Z'); // 15:00, reminderTime 20:00
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    expect(countDueAutoDoses(med, now, '2026-09-11')).toBe(0);
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(30);
  });

  // ─── 2. at reminderTime → due ───────────────────────────────────────
  it('at reminderTime: today dose due → balance = snapshot - dose', () => {
    const now = at('2026-09-11T20:00:00Z'); // 20:00 = reminderTime
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    expect(countDueAutoDoses(med, now, '2026-09-11')).toBe(1);
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(28);
  });

  // ─── 3. after reminderTime → due ────────────────────────────────────
  it('after reminderTime: today dose due → balance = snapshot - dose', () => {
    const now = at('2026-09-11T21:00:00Z'); // 21:00 > 20:00
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    expect(countDueAutoDoses(med, now, '2026-09-11')).toBe(1);
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(28);
  });

  // ─── 4. manual consume before reminderTime → no double at the time ─
  it('manual consume before reminderTime: deduct once, no double at reminderTime', () => {
    const now = at('2026-09-11T18:00:00Z'); // 18:00 < 20:00
    // Issue #267: consumeDose requires a doseSchedule (no Legacy fallback).
    // Use a single-slot schedule at the reminderTime so behavior matches the
    // pre-#267 reminderTime-gated semantics.
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
      doseSchedule: [{ id: 'd1', amount: 2, time: '20:00' }],
      dosesPerDay: 1,
    });
    const { updatedMed } = consumeDose(med, 'manual', '2026-09-11', now, 'd1');
    expect(updatedMed).not.toBeNull();
    expect(updatedMed!.currentPills).toBe(28); // 30 - 2 (the manual dose only)
    expect(updatedMed!.lastConsumedDate).toBe('2026-09-11');

    // At 20:00 (reminderTime), NO additional deduction: the manual
    // consume marked today's dose complete (doseConsumption.d1 = today).
    const nowAtTime = at('2026-09-11T20:00:00Z');
    expect(effectiveCurrentPills(updatedMed!, '2026-09-11', nowAtTime)).toBe(28);
  });

  // ─── 5. manual consume after reminderTime → no double deduction ────
  it('manual consume after reminderTime: no double deduction', () => {
    const now = at('2026-09-11T20:01:00Z'); // 20:01 > 20:00 (today dose due)
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
      doseSchedule: [{ id: 'd1', amount: 2, time: '20:00' }],
      dosesPerDay: 1,
    });
    // The projection would deduct today's dose (→ 28). The manual consume
    // deducts from durable currentPills only (NOT from effPills), so the
    // result is 30 - 2 = 28, NOT 26.
    const { updatedMed } = consumeDose(med, 'manual', '2026-09-11', now, 'd1');
    expect(updatedMed).not.toBeNull();
    expect(updatedMed!.currentPills).toBe(28);
    expect(updatedMed!.lastConsumedDate).toBe('2026-09-11');
  });

  // ─── 6. app closed before reminderTime, opened after → dose due ────
  it('app closed before reminderTime, opened after: today dose is due (reflected in the live balance)', () => {
    const now = at('2026-09-11T21:00:00Z'); // opened at 21:00 (> 20:00)
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    // The live balance reflects the now-due dose. The legacy day-based
    // catch-up that used to settle today's dose on app-open was removed
    // (Issue #268 / PR #271); today's dose stays a dynamic projection
    // (effectiveCurrentPills) until a manual Take or an Exact FIRED
    // occurrence settles it. The snapshot is not reduced, but the live
    // balance is correct.
    expect(countDueAutoDoses(med, now, '2026-09-11')).toBe(1);
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(28);
    expect(med.currentPills).toBe(30); // snapshot unchanged (no auto settlement)
  });

  it('app closed before reminderTime, opened after: the past day stays reflected in the live balance (not lost)', () => {
    // The dose that became due is not lost — it stays reflected in the live
    // balance (effectiveCurrentPills) the next day. There is no automatic
    // day-based settlement; a later mutation (refill / dose-change / toggle)
    // or an Exact FIRED occurrence settles it.
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const now = at('2026-09-12T15:00:00Z'); // next day at 15:00 (< 20:00)
    // 2026-09-11 (fully elapsed) due; 2026-09-12 (today, < 20:00) not due yet.
    expect(countDueAutoDoses(med, now, '2026-09-12')).toBe(1);
    expect(effectiveCurrentPills(med, '2026-09-12', now)).toBe(28);
  });

  // ─── 7. app closed a full day, open before next day's reminderTime ─
  it('app closed a full day, opened before next day reminderTime: no next-day deduction', () => {
    const now = at('2026-09-12T15:00:00Z'); // 09-12 15:00 < 20:00
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    // Live balance: 09-11 (fully elapsed) due, 09-12 (today, before 20:00) NOT due.
    expect(countDueAutoDoses(med, now, '2026-09-12')).toBe(1);
    expect(effectiveCurrentPills(med, '2026-09-12', now)).toBe(28);
    // Snapshot unchanged (no auto day-based settlement).
    expect(med.currentPills).toBe(30);
    // …but at 20:00 today's dose becomes due (projected, not yet settled).
    const nowAtTime = at('2026-09-12T20:00:00Z');
    expect(effectiveCurrentPills(med, '2026-09-12', nowAtTime)).toBe(26);
  });

  // ─── 8. app closed several days → count by times, not calendar days ─
  it('app closed several days, opened before today reminderTime: only fully-elapsed days due', () => {
    const now = at('2026-09-13T15:00:00Z'); // 09-13 15:00 < 20:00
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    // Calendar days = 3 (09-11, 09-12, 09-13). Gated: 09-11 + 09-12 due
    // (fully elapsed), 09-13 NOT due (before 20:00) → 2 doses, not 3.
    expect(countDueAutoDoses(med, now, '2026-09-13')).toBe(2);
    expect(effectiveCurrentPills(med, '2026-09-13', now)).toBe(26); // 30 - 2*2
  });

  it('app closed several days, opened after today reminderTime: today also due', () => {
    const now = at('2026-09-13T21:00:00Z'); // 09-13 21:00 > 20:00
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    // 09-11 + 09-12 (elapsed) + 09-13 (today, after 20:00) → 3 doses.
    expect(countDueAutoDoses(med, now, '2026-09-13')).toBe(3);
    expect(effectiveCurrentPills(med, '2026-09-13', now)).toBe(24); // 30 - 3*2
  });

  // ─── 9. reminder disabled → legacy calendar-day behavior ──────────
  it('reminder disabled: today dose due at the start of the calendar day (legacy)', () => {
    const now = at('2026-09-11T15:00:00Z'); // 15:00, reminderTime 20:00
    // reminderEnabled false → NOT gated. Legacy: today due at start of day.
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
      reminderEnabled: false,
    });
    expect(countDueAutoDoses(med, now, '2026-09-11')).toBe(1); // calendar day
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(28); // 30 - 1*2, even at 15:00
  });

  it('reminder disabled with no reminderTime: still legacy calendar-day (disabling notification does not disable auto-deduction)', () => {
    const now = at('2026-09-11T15:00:00Z');
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
      reminderEnabled: false,
      reminderTime: undefined,
    });
    expect(countDueAutoDoses(med, now, '2026-09-11')).toBe(1);
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(28);
  });

  // ─── 10. change reminderTime → no retroactive application to past ───
  it('change reminderTime: past-days projection (betweenDays) is unchanged — only today due-ness changes', () => {
    const now = at('2026-09-15T15:00:00Z'); // 09-15 15:00
    // reminderTime 09:00 (old): 4 past days (09-11..09-14) + today
    // (15:00 >= 09:00 → due) = 5 doses.
    const medOld = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
      reminderTime: '09:00',
    });
    expect(countDueAutoDoses(medOld, now, '2026-09-15')).toBe(5);

    // Change reminderTime to 20:00 (new): the SAME 4 past days are still
    // due (betweenDays is independent of reminderTime — a fully-elapsed
    // day's dose is due regardless of the time). Only today's due-ness
    // changes (15:00 < 20:00 → not due) → 4 doses.
    const medNew = { ...medOld, reminderTime: '20:00' };
    expect(countDueAutoDoses(medNew, now, '2026-09-15')).toBe(4);
    // The past-days deduction (betweenDays * dose = 4 * 2 = 8) is
    // identical before and after the change — no retroactive application.
    expect(effectiveCurrentPills(medOld, '2026-09-15', now)).toBe(20); // 30 - 5*2
    expect(effectiveCurrentPills(medNew, '2026-09-15', now)).toBe(22); // 30 - 4*2
  });

  // Issue #267: dose-change settlement was removed. `settleDoseChange` was
  // deleted; the durable `currentPills` is NOT changed by a dose edit. The
  // projection uses the current `dailyDose` for both past and today (there
  // is no historical settlement that bakes in the OLD dose anymore).

  // ─── 11. change dailyDose → snapshot unchanged; projection uses NEW dose ─
  it('change dailyDose: snapshot unchanged; projection uses NEW dose (no settlement, no OLD-dose past)', () => {
    const now = at('2026-09-13T15:00:00Z'); // 09-13 15:00 < 20:00
    const medBefore = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
    });
    // Pre-change projection: betweenDays=2 (Sep 11, Sep 12) at dose 2
    // → pastDueUnits=4. todayDue=0 (15:00 < 20:00). effPills=30-4=26.
    expect(effectiveCurrentPills(medBefore, '2026-09-13', now)).toBe(26);

    // Issue #267: dose edit changes configuration only. No settle, no
    // lastSyncDate change, no auto_daily log. The durable snapshot stays
    // at currentPills=30 and lastSyncDate='2026-09-10' (unchanged).
    const medAfter: Medication = { ...medBefore, dailyDose: 3 };
    expect(medAfter.currentPills).toBe(30);
    expect(medAfter.lastSyncDate).toBe('2026-09-10');
    expect(medAfter.dailyDose).toBe(3);

    // After the dose change, the projection uses the NEW dose 3 for both
    // past days and today (no OLD-dose past anymore — historicalDayDueUnits
    // reads the current med.dailyDose).
    // past days (Sep 11, Sep 12) at NEW dose 3 → 6. todayDue=0. effPills=30-6=24.
    expect(effectiveCurrentPills(medAfter, '2026-09-13', now)).toBe(24);
    // At 20:00, today's dose due at NEW dose (3) → effPills = 24 - 3 = 21.
    const nowAtTime = at('2026-09-13T20:00:00Z');
    expect(effectiveCurrentPills(medAfter, '2026-09-13', nowAtTime)).toBe(21);
  });

  // Issue #267: auto-deduct toggle settlement was removed. The toggle now
  // flips `autoDeductEnabled` only — no stock change, no log, no lastSyncDate
  // bump. The durable snapshot stays unchanged; projection starts/stops
  // applying on the next render.

  // ─── auto-deduct toggle (gated) ────────────────────────────────
  it('toggle true→false (gated): snapshot unchanged, projection frozen', () => {
    const now = at('2026-09-11T15:00:00Z'); // 09-11 15:00 < 20:00
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-09', // 2 days elapsed (09-09 → 09-11): betweenDays = 1 (09-10)
    });
    // Issue #267: toggle flips the flag only. No stock settlement, no log,
    // no lastSyncDate change. The durable snapshot stays at 30 / '2026-09-09'.
    const updatedMed: Medication = { ...med, autoDeductEnabled: false };
    expect(updatedMed.currentPills).toBe(30); // unchanged
    expect(updatedMed.lastSyncDate).toBe('2026-09-09'); // unchanged
    expect(updatedMed.autoDeductEnabled).toBe(false);
    // Frozen med → effectiveCurrentPills returns the snapshot unchanged.
    expect(effectiveCurrentPills(updatedMed, '2026-09-11', now)).toBe(30);
  });

  it('toggle false→true (gated): snapshot unchanged; projection starts from today forward', () => {
    const now = at('2026-09-11T15:00:00Z'); // 15:00 < 20:00
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-09',
      autoDeductEnabled: false,
    });
    // Issue #267: toggle flips the flag only. No retroactive deduction for
    // the frozen period. The durable snapshot stays at 30 / '2026-09-09'.
    const updatedMed: Medication = { ...med, autoDeductEnabled: true };
    expect(updatedMed.currentPills).toBe(30); // unchanged — no retroactive deduction
    expect(updatedMed.lastSyncDate).toBe('2026-09-09'); // unchanged
    expect(updatedMed.autoDeductEnabled).toBe(true);
    // Today (before 20:00) NOT due → pastDueUnits only (betweenDays=1 for
    // Sep 10 at dose 2) → effPills = 30 - 2 = 28. The past day's projection
    // is NOT zero — it stays a live projection (no settlement was baked in).
    expect(effectiveCurrentPills(updatedMed, '2026-09-11', now)).toBe(28);
    // At 20:00, today's dose also due → effPills = 30 - 2 (Sep 10) - 2 (today) = 26.
    const nowAtTime = at('2026-09-11T20:00:00Z');
    expect(effectiveCurrentPills(updatedMed, '2026-09-11', nowAtTime)).toBe(26);
  });

  // Issue #267: refill adds to durable currentPills only (no settlement).
  // The refill test below verifies the new contract directly.
  // ─── refill (gated) ────────────────────────────────
  it('refill after reminderTime (gated): adds to durable currentPills; projection still reflects today due (no double)', () => {
    const now = at('2026-09-11T21:00:00Z'); // 21:00 > 20:00 (today due)
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
    });
    // Issue #267: refill = currentPills + addedPills only. No settlement,
    // no lastSyncDate change. The durable snapshot becomes 40.
    const updatedMed: Medication = { ...med, currentPills: 40 };
    expect(updatedMed.currentPills).toBe(40);
    expect(updatedMed.lastSyncDate).toBe('2026-09-10'); // unchanged
    // Live balance projects today's due dose → 40 - 2 = 38 (no double).
    expect(effectiveCurrentPills(updatedMed, '2026-09-11', now)).toBe(38);
  });

  it('refill with elapsed past days (gated): adds to durable currentPills; projection still reflects past + today', () => {
    const now = at('2026-09-12T15:00:00Z'); // 09-12 15:00 < 20:00
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-09', // betweenDays = 2 (09-10, 09-11)
    });
    // Issue #267: refill = currentPills + addedPills only. No settlement.
    const updatedMed: Medication = { ...med, currentPills: 40 };
    expect(updatedMed.currentPills).toBe(40);
    expect(updatedMed.lastSyncDate).toBe('2026-09-09'); // unchanged
    // Today (09-12, before 20:00) NOT due → projection = past 2 days at 2 = 4
    // → effPills = 40 - 4 = 36.
    expect(effectiveCurrentPills(updatedMed, '2026-09-12', now)).toBe(36);
    // At 20:00, today due → 40 - 4 - 2 = 34.
    const nowAtTime = at('2026-09-12T20:00:00Z');
    expect(effectiveCurrentPills(updatedMed, '2026-09-12', nowAtTime)).toBe(34);
  });

  // ─── already-consumed-today guard (gated) ──────────────────────────
  it('a gated med already consumed today is not double-deducted (no auto settlement on top)', () => {
    const now = at('2026-09-11T21:00:00Z'); // after reminderTime
    // The user manually consumed today (lastConsumedDate = today); the
    // manual consume already settled the snapshot. The legacy day-based
    // catch-up that could have re-charged was removed (Issue #268 / PR #271),
    // so no automatic deduction runs on top — the snapshot stays settled.
    const med = makeRemindedMed({
      currentPills: 28, // 30 - 2 (already deducted by the manual consume)
      dailyDose: 2,
      lastSyncDate: '2026-09-11',
      lastConsumedDate: '2026-09-11',
    });
    expect(med.currentPills).toBe(28); // unchanged (no auto settlement)
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(28);
  });
});

/**
 * Same-day regression: `lastSyncDate === today` must NOT prevent today's
 * dose from becoming due at reminderTime. A med created/started today
 * (lastSyncDate = today) with reminderEnabled + a valid reminderTime has
 * today's dose pending reminderTime — the due-dose calculation must
 * evaluate todayDue independently of past elapsed days.
 */
describe('same-day lastSyncDate === today (reminderTime-gated)', () => {
  // ─── 1. same-day med before reminderTime → no deduction ─────────────
  it('same-day med before reminderTime: today dose NOT due → 0', () => {
    const now = at('2026-09-11T15:00:00Z'); // 15:00 < 20:00
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-11', // same day
    });
    expect(countDueAutoDoses(med, now, '2026-09-11')).toBe(0);
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(30); // no deduction
  });

  // ─── 2. same-day med exactly at reminderTime → due ──────────────────
  it('same-day med at reminderTime: today dose due → count=1, deduct dailyDose', () => {
    const now = at('2026-09-11T20:00:00Z'); // 20:00 = reminderTime
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-11', // same day
    });
    expect(countDueAutoDoses(med, now, '2026-09-11')).toBe(1);
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(28); // 30 - 2
  });

  // ─── 3. same-day med after reminderTime → due ───────────────────────
  it('same-day med after reminderTime: today dose due', () => {
    const now = at('2026-09-11T21:00:00Z'); // 21:00 > 20:00
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-11', // same day
    });
    expect(countDueAutoDoses(med, now, '2026-09-11')).toBe(1);
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(28);
  });

  // ─── breakdown: todayDue is true for same-day at/after reminderTime ──
  it('computeDueDoseBreakdown: same-day med reports todayDue=true at reminderTime, pastDueDoses=0', () => {
    const now = at('2026-09-11T20:00:00Z');
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-11',
    });
    const bd = computeDueDoseBreakdown(med, now, '2026-09-11');
    expect(bd.totalDays).toBe(0); // lastSyncDate === today
    expect(bd.betweenDays).toBe(0);
    expect(bd.todayDue).toBe(true);
    expect(bd.fullDueDoses).toBe(1); // 0 past + 1 today
    expect(bd.pastDueDoses).toBe(0); // today NOT settled by settlement
  });

  it('computeDueDoseBreakdown: same-day med before reminderTime reports todayDue=false', () => {
    const now = at('2026-09-11T15:00:00Z');
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-11',
    });
    const bd = computeDueDoseBreakdown(med, now, '2026-09-11');
    expect(bd.todayDue).toBe(false);
    expect(bd.fullDueDoses).toBe(0);
    expect(bd.pastDueDoses).toBe(0);
  });

  // ─── 4. same-day manual consume before reminderTime → no double at time
  it('same-day manual consume before reminderTime: deduct once, no double at reminderTime', () => {
    const now = at('2026-09-11T18:00:00Z'); // 18:00 < 20:00
    // Issue #267: consumeDose requires a doseSchedule (no Legacy fallback).
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-11', // same day
      doseSchedule: [{ id: 'd1', amount: 2, time: '20:00' }],
      dosesPerDay: 1,
    });
    const { updatedMed } = consumeDose(med, 'manual', '2026-09-11', now, 'd1');
    expect(updatedMed).not.toBeNull();
    expect(updatedMed!.currentPills).toBe(28); // 30 - 2 (the manual dose only)
    expect(updatedMed!.lastConsumedDate).toBe('2026-09-11');

    // At 20:00 (reminderTime), NO additional deduction — doseConsumption.d1
    // = today blocks today's auto-dose.
    const nowAtTime = at('2026-09-11T20:00:00Z');
    expect(countDueAutoDoses(updatedMed!, nowAtTime, '2026-09-11')).toBe(0);
    expect(effectiveCurrentPills(updatedMed!, '2026-09-11', nowAtTime)).toBe(28); // not 26
  });

  // ─── 5. same-day manual consume after reminderTime → no double ───────
  it('same-day manual consume after reminderTime: auto dose dynamic due, manual replaces (no double)', () => {
    const now = at('2026-09-11T20:01:00Z'); // 20:01 > 20:00 (today dose due)
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-11', // same day
      doseSchedule: [{ id: 'd1', amount: 2, time: '20:00' }],
      dosesPerDay: 1,
    });
    // The auto projection before consume = 28 (todayDue=1, betweenDays=0).
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(28);
    // Issue #267: consumeDose deducts from durable currentPills only
    // (NOT from effPills). Result = 30 - 2 = 28, NOT 26.
    const { updatedMed } = consumeDose(med, 'manual', '2026-09-11', now, 'd1');
    expect(updatedMed).not.toBeNull();
    expect(updatedMed!.currentPills).toBe(28); // not 26
    expect(updatedMed!.lastConsumedDate).toBe('2026-09-11');
  });

  // ─── 6. same-day med with lastConsumedDate === today → no auto deduction
  it('same-day med already consumed today: no auto deduction at any time', () => {
    // The user manually consumed today (lastConsumedDate = today).
    const med = makeRemindedMed({
      currentPills: 28,
      dailyDose: 2,
      lastSyncDate: '2026-09-11',
      lastConsumedDate: '2026-09-11',
    });
    // Before reminderTime: 0 due.
    expect(countDueAutoDoses(med, at('2026-09-11T15:00:00Z'), '2026-09-11')).toBe(0);
    // At reminderTime: still 0 (consumed today).
    expect(countDueAutoDoses(med, at('2026-09-11T20:00:00Z'), '2026-09-11')).toBe(0);
    // After reminderTime: still 0.
    expect(countDueAutoDoses(med, at('2026-09-11T21:00:00Z'), '2026-09-11')).toBe(0);
    expect(effectiveCurrentPills(med, '2026-09-11', at('2026-09-11T21:00:00Z'))).toBe(28);
  });

  // ─── 7. multi-day regression: past days still counted (PR #160 intact) ─
  it('multi-day regression: past elapsed days still counted (PR #160 behavior)', () => {
    const now = at('2026-09-13T15:00:00Z'); // 09-13 15:00 < 20:00
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10', // 3 days elapsed (09-10 → 09-13)
    });
    // betweenDays = 2 (09-11, 09-12); today (09-13) NOT due (before 20:00).
    expect(countDueAutoDoses(med, now, '2026-09-13')).toBe(2);
    expect(effectiveCurrentPills(med, '2026-09-13', now)).toBe(26); // 30 - 2*2
    // The live balance reflects the 2 past days (effectiveCurrentPills). The
    // legacy day-based catch-up that used to settle them into the snapshot
    // was removed (Issue #268 / PR #271); the snapshot is not auto-reduced.
    expect(med.currentPills).toBe(30);
  });

  it('multi-day regression: past days + today (after reminderTime)', () => {
    const now = at('2026-09-13T21:00:00Z'); // 09-13 21:00 > 20:00
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
    });
    // betweenDays = 2 + todayDue = 1 → 3 doses.
    expect(countDueAutoDoses(med, now, '2026-09-13')).toBe(3);
    expect(effectiveCurrentPills(med, '2026-09-13', now)).toBe(24); // 30 - 3*2
  });

  // ─── 8. legacy regression: reminderEnabled false → calendar-day behavior
  it('legacy regression (reminder disabled, same-day): today settled → 0 due', () => {
    const now = at('2026-09-11T15:00:00Z');
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-11', // same day
      reminderEnabled: false,
    });
    // Legacy: lastSyncDate === today → today settled → 0 due (even at 15:00,
    // and even at/after 20:00 — reminderTime is irrelevant for legacy).
    expect(countDueAutoDoses(med, now, '2026-09-11')).toBe(0);
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(30);
    expect(countDueAutoDoses(med, at('2026-09-11T20:00:00Z'), '2026-09-11')).toBe(0);
  });

  it('legacy regression (reminder disabled, multi-day): calendar-day count', () => {
    const now = at('2026-09-11T15:00:00Z');
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10', // 1 day elapsed
      reminderEnabled: false,
    });
    // Legacy: today (09-11) due at start of calendar day → 1 dose (even at 15:00).
    expect(countDueAutoDoses(med, now, '2026-09-11')).toBe(1);
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(28); // 30 - 1*2
  });
});
