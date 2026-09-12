import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  effectiveCurrentPills,
  countDueAutoDoses,
  syncAutoDailyDeductions,
  settleDoseChange,
  settleAutoDeductToggle,
} from './dateCalculations';
import { consumeDose, settleAndAdjust } from './medActions';
import type { Medication } from '../types';

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
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const { updatedMed } = consumeDose(med, 'manual', '2026-09-11', now);
    expect(updatedMed).not.toBeNull();
    expect(updatedMed!.currentPills).toBe(28); // 30 - 2 (the manual dose only)
    expect(updatedMed!.lastConsumedDate).toBe('2026-09-11');

    // At 20:00 (reminderTime), NO additional deduction: the manual
    // consume marked today's dose complete (lastConsumedDate = today).
    const nowAtTime = at('2026-09-11T20:00:00Z');
    expect(effectiveCurrentPills(updatedMed!, '2026-09-11', nowAtTime)).toBe(28);
  });

  // ─── 5. manual consume after reminderTime → no double deduction ────
  it('manual consume after reminderTime: no double deduction', () => {
    const now = at('2026-09-11T20:01:00Z'); // 20:01 > 20:00 (today dose due)
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    // The projection would deduct today's dose (→ 28). The manual consume
    // REPLACES today's auto-dose (does not add to it), so the result is
    // 28, not 26.
    const { updatedMed } = consumeDose(med, 'manual', '2026-09-11', now);
    expect(updatedMed).not.toBeNull();
    expect(updatedMed!.currentPills).toBe(28);
    expect(updatedMed!.lastConsumedDate).toBe('2026-09-11');
  });

  // ─── 6. app closed before reminderTime, opened after → dose due ────
  it('app closed before reminderTime, opened after: today dose is due (reflected in the live balance)', () => {
    const now = at('2026-09-11T21:00:00Z'); // opened at 21:00 (> 20:00)
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    // The live balance reflects the now-due dose.
    expect(countDueAutoDoses(med, now, '2026-09-11')).toBe(1);
    expect(effectiveCurrentPills(med, '2026-09-11', now)).toBe(28);

    // sync on open settles ONLY past days (there are none here: betweenDays
    // = 0); today's dose stays dynamic and is settled on day rollover or
    // a later mutation. The snapshot is not yet reduced, but the live
    // balance (effectiveCurrentPills) is correct.
    const result = syncAutoDailyDeductions([med], '2026-09-11', now);
    expect(result.updatedMeds[0].currentPills).toBe(30); // today NOT settled by sync
    expect(result.newLogs).toHaveLength(0); // nothing past to settle
    expect(effectiveCurrentPills(result.updatedMeds[0], '2026-09-11', now)).toBe(28);
  });

  it('app closed before reminderTime, opened after: the due dose is settled on the next day rollover', () => {
    // Continuation of the above: the dose that became due is not lost —
    // it is settled when the next calendar day's sync treats it as a
    // fully-elapsed past day.
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const now = at('2026-09-12T15:00:00Z'); // next day at 15:00 (< 20:00)
    const result = syncAutoDailyDeductions([med], '2026-09-12', now);
    // 2026-09-11 (fully elapsed) settled; 2026-09-12 (today, < 20:00) not.
    expect(result.updatedMeds[0].currentPills).toBe(28); // 30 - 1*2
    expect(result.updatedMeds[0].lastSyncDate).toBe('2026-09-11'); // yesterday
    expect(result.newLogs).toHaveLength(1);
    expect(result.newLogs[0].amount).toBe(-2);
  });

  // ─── 7. app closed a full day, open before next day's reminderTime ─
  it('app closed a full day, opened before next day reminderTime: no next-day deduction', () => {
    const now = at('2026-09-12T15:00:00Z'); // 09-12 15:00 < 20:00
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    // Live balance: 09-11 (fully elapsed) due, 09-12 (today, before 20:00) NOT due.
    expect(countDueAutoDoses(med, now, '2026-09-12')).toBe(1);
    expect(effectiveCurrentPills(med, '2026-09-12', now)).toBe(28);
    // sync settles 09-11 only.
    const result = syncAutoDailyDeductions([med], '2026-09-12', now);
    expect(result.updatedMeds[0].currentPills).toBe(28);
    expect(result.updatedMeds[0].lastSyncDate).toBe('2026-09-11');
    // After sync, today (09-12, before 20:00) is still NOT due.
    expect(effectiveCurrentPills(result.updatedMeds[0], '2026-09-12', now)).toBe(28);
    // …but at 20:00 today's dose becomes due (projected, not yet settled).
    const nowAtTime = at('2026-09-12T20:00:00Z');
    expect(effectiveCurrentPills(result.updatedMeds[0], '2026-09-12', nowAtTime)).toBe(26);
  });

  // ─── 8. app closed several days → count by times, not calendar days ─
  it('app closed several days, opened before today reminderTime: only fully-elapsed days due', () => {
    const now = at('2026-09-13T15:00:00Z'); // 09-13 15:00 < 20:00
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    // Calendar days = 3 (09-11, 09-12, 09-13). Gated: 09-11 + 09-12 due
    // (fully elapsed), 09-13 NOT due (before 20:00) → 2 doses, not 3.
    expect(countDueAutoDoses(med, now, '2026-09-13')).toBe(2);
    expect(effectiveCurrentPills(med, '2026-09-13', now)).toBe(26); // 30 - 2*2
    const result = syncAutoDailyDeductions([med], '2026-09-13', now);
    expect(result.updatedMeds[0].currentPills).toBe(26);
    expect(result.updatedMeds[0].lastSyncDate).toBe('2026-09-12');
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

  // ─── 11. change dailyDose → old dose for past, new dose for future ─
  it('settleDoseChange: settles elapsed PAST days at OLD dose, then applies NEW dose going forward', () => {
    const now = at('2026-09-13T15:00:00Z'); // 09-13 15:00 < 20:00
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
    });
    // Elapsed past days (09-11, 09-12) = 2, settled at OLD dose 2 → 4.
    // Today (09-13, before 20:00) NOT settled (left dynamic).
    const { updatedMed, log } = settleDoseChange(med, 3, '2026-09-13', now);
    expect(updatedMed.currentPills).toBe(26); // 30 - 2*2 (old dose)
    expect(updatedMed.dailyDose).toBe(3); // new dose from today forward
    expect(updatedMed.lastSyncDate).toBe('2026-09-12'); // yesterday (today dynamic)
    expect(log).not.toBeNull();
    expect(log!.amount).toBe(-4);

    // Before today's reminderTime: today NOT due → effPills = settled 26.
    expect(effectiveCurrentPills(updatedMed, '2026-09-13', now)).toBe(26);
    // At 20:00, today's dose due at the NEW dose (3) → effPills = 26 - 3 = 23.
    const nowAtTime = at('2026-09-13T20:00:00Z');
    expect(effectiveCurrentPills(updatedMed, '2026-09-13', nowAtTime)).toBe(23);
  });

  // ─── settleAutoDeductToggle (gated) ────────────────────────────────
  it('toggle true→false (gated): settles past days only, freezes the balance', () => {
    const now = at('2026-09-11T15:00:00Z'); // 09-11 15:00 < 20:00
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-09', // 2 days elapsed (09-09 → 09-11): betweenDays = 1 (09-10)
    });
    const { updatedMed, log } = settleAutoDeductToggle(med, false, '2026-09-11', now);
    // Past day 09-10 settled at 2 → 28. Today (09-11, before 20:00) not.
    expect(updatedMed.currentPills).toBe(28);
    expect(updatedMed.lastSyncDate).toBe('2026-09-10'); // yesterday (today stays dynamic if re-enabled)
    expect(updatedMed.autoDeductEnabled).toBe(false);
    expect(log).not.toBeNull();
    expect(log!.amount).toBe(-2);
    // Frozen med → effectiveCurrentPills returns the snapshot unchanged.
    expect(effectiveCurrentPills(updatedMed, '2026-09-11', now)).toBe(28);
  });

  it('toggle false→true (gated): no retroactive deduction for the frozen period; today stays dynamic', () => {
    const now = at('2026-09-11T15:00:00Z'); // 15:00 < 20:00
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-09',
      autoDeductEnabled: false,
    });
    const { updatedMed, log } = settleAutoDeductToggle(med, true, '2026-09-11', now);
    expect(updatedMed.currentPills).toBe(30); // unchanged — no retroactive deduction
    expect(updatedMed.lastSyncDate).toBe('2026-09-10'); // yesterday (today dynamic, no retro)
    expect(updatedMed.autoDeductEnabled).toBe(true);
    expect(log).toBeNull();
    // Today (before 20:00) NOT due → effPills = 30.
    expect(effectiveCurrentPills(updatedMed, '2026-09-11', now)).toBe(30);
    // At 20:00, today's dose due (NEW schedule from today) → effPills = 28.
    const nowAtTime = at('2026-09-11T20:00:00Z');
    expect(effectiveCurrentPills(updatedMed, '2026-09-11', nowAtTime)).toBe(28);
  });

  // ─── refill (settleAndAdjust, gated) ────────────────────────────────
  it('refill after reminderTime (gated): settles past-only, today stays dynamic (no double)', () => {
    const now = at('2026-09-11T21:00:00Z'); // 21:00 > 20:00 (today due)
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
    });
    const result = settleAndAdjust(med, 10, '2026-09-11', now); // refill +10
    // Past-only settle (betweenDays=0) → 30, +10 → 40. today's dose NOT
    // baked in (left dynamic). lastSyncDate kept (yesterday).
    expect(result.updatedMed.currentPills).toBe(40);
    expect(result.updatedMed.lastSyncDate).toBe('2026-09-10');
    // Live balance projects today's due dose → 40 - 2 = 38 (no double).
    expect(effectiveCurrentPills(result.updatedMed, '2026-09-11', now)).toBe(38);
  });

  it('refill with elapsed past days (gated): settles past days, today stays dynamic', () => {
    const now = at('2026-09-12T15:00:00Z'); // 09-12 15:00 < 20:00
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-09', // betweenDays = 2 (09-10, 09-11)
    });
    const result = settleAndAdjust(med, 10, '2026-09-12', now); // refill +10
    // Past 2 days (09-10, 09-11) settled at 2 → 30 - 4 = 26. +10 → 36.
    expect(result.updatedMed.currentPills).toBe(36);
    expect(result.updatedMed.lastSyncDate).toBe('2026-09-11'); // yesterday (today dynamic)
    // Today (09-12, before 20:00) NOT due → effPills = 36.
    expect(effectiveCurrentPills(result.updatedMed, '2026-09-12', now)).toBe(36);
    // At 20:00, today due → 36 - 2 = 34.
    const nowAtTime = at('2026-09-12T20:00:00Z');
    expect(effectiveCurrentPills(result.updatedMed, '2026-09-12', nowAtTime)).toBe(34);
  });

  // ─── already-consumed-today guard (gated) ──────────────────────────
  it('sync skips a gated med already consumed today (no double-deduction)', () => {
    const now = at('2026-09-11T21:00:00Z'); // after reminderTime
    // The user manually consumed today (lastConsumedDate = today); the
    // manual consume already settled the snapshot.
    const med = makeRemindedMed({
      currentPills: 28, // 30 - 2 (already deducted by the manual consume)
      dailyDose: 2,
      lastSyncDate: '2026-09-11',
      lastConsumedDate: '2026-09-11',
    });
    const result = syncAutoDailyDeductions([med], '2026-09-11', now);
    expect(result.updatedMeds[0].currentPills).toBe(28); // unchanged
    expect(result.newLogs).toHaveLength(0);
    expect(effectiveCurrentPills(result.updatedMeds[0], '2026-09-11', now)).toBe(28);
  });
});
