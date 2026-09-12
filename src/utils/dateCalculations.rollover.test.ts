import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  effectiveCurrentPills,
  countDueAutoDoses,
  syncAutoDailyDeductions,
  settleDoseChange,
  settleAutoDeductToggle,
  reverseRefill,
} from './dateCalculations';
import { consumeDose, settleAndAdjust } from './medActions';
import type { Medication } from '../types';

/**
 * Day-rollover regression: the snapshot/projection model must stay correct
 * when the app stays open across midnight.
 *
 * Per the architecture: `currentPills` is the last SETTLED snapshot,
 * `lastSyncDate` is its date, and `effectiveCurrentPills()` is the live
 * projection computed on the fly from the doses that have become due.
 * The projection is pure/read-only — it never mutates state. Settlement
 * (syncAutoDailyDeductions / mutations) is the only thing that updates
 * currentPills + lastSyncDate + logs.
 *
 * IMPORTANT — what the app does NOT do: there is NO automatic settlement
 * at the calendar-day boundary while the app stays open. syncAutoDailyDeductions
 * runs only on app-open (App.tsx mount effect, once after hydration) and via
 * mutations (refill / consume / dose-change / auto-deduct toggle). So while
 * the app remains open across midnight, the snapshot is NOT physically
 * settled at 00:00 — the previous day's dose becomes part of the past-day
 * settlement basis (it shifts from `todayDue` to `betweenDays`) and is
 * settled at the next existing execution point.
 *
 * These tests explicitly DISTINGUISH the two concerns:
 *   (A) Dynamic projection across midnight — effectiveCurrentPills() is
 *       correct without any settlement (no sync call in the test).
 *   (B) Actual settlement execution — syncAutoDailyDeductions() (or a
 *       mutation) is explicitly called, and currentPills/lastSyncDate/logs
 *       are verified. No test implies sync fires automatically at midnight.
 *
 * Key projection invariant at the Sep 11 → Sep 12 rollover (reminderTime
 * 20:00): a dose becomes due only at its reminderTime, so crossing midnight
 * must NOT add Sep 12's dose. Sep 11's dose (which became due at 20:00)
 * stays counted (it shifts from `todayDue` to `betweenDays`), so the
 * projection is STABLE (28 → 28) across midnight until Sep 12 20:00 (→ 26).
 *
 * No polling, no timer, no background runner, no state machine was added.
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

/** Set the system clock to the given UTC instant and return a `now` Date. */
function at(utcIso: string): Date {
  const now = new Date(utcIso);
  vi.setSystemTime(now);
  return now;
}

// ─── A. Day rollover while the app remains open ──────────────────────
describe('day rollover while app remains open (dynamic projection, no settlement)', () => {
  // These tests call effectiveCurrentPills/countDueAutoDoses ONLY. They do NOT
  // call syncAutoDailyDeductions or any mutation — they verify the live
  // projection is correct across midnight WITHOUT any settlement, proving the
  // displayed balance is right even though the snapshot is not physically
  // settled at the calendar-day boundary.
  // A.1 Sep 11 21:00 → Sep 12 10:00 → Sep 12 20:00
  it('projection is stable across midnight: 28 → 28 → 26 (no premature next-day dose)', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });

    // Sep 11 21:00 — Sep 11's dose became due at 20:00 → 28.
    expect(effectiveCurrentPills(med, '2026-09-11', at('2026-09-11T21:00:00Z'))).toBe(28);

    // Sep 12 10:00 — Sep 11 now "past due" (betweenDays=1), Sep 12 NOT due (before 20:00) → still 28.
    expect(effectiveCurrentPills(med, '2026-09-12', at('2026-09-12T10:00:00Z'))).toBe(28);

    // Sep 12 19:59 — still 28.
    expect(effectiveCurrentPills(med, '2026-09-12', at('2026-09-12T19:59:00Z'))).toBe(28);

    // Sep 12 20:00 — Sep 12's dose now due → 26.
    expect(effectiveCurrentPills(med, '2026-09-12', at('2026-09-12T20:00:00Z'))).toBe(26);

    // Sep 12 23:59 — still 26.
    expect(effectiveCurrentPills(med, '2026-09-12', at('2026-09-12T23:59:00Z'))).toBe(26);
  });

  // C. No premature next-day deduction at 00:01
  it('Sep 12 00:01 does NOT deduct Sep 12 (projection = 28, not 26)', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    expect(effectiveCurrentPills(med, '2026-09-12', at('2026-09-12T00:01:00Z'))).toBe(28);
    expect(countDueAutoDoses(med, at('2026-09-12T00:01:00Z'), '2026-09-12')).toBe(1); // Sep 11 only
  });

  // The dose shifts from todayDue (Sep 11) to betweenDays (Sep 11) at midnight
  it('countDueAutoDoses recomposes at midnight: todayDue → betweenDays (count stable)', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    // Sep 11 23:59: betweenDays=0 + todayDue=1 (Sep 11) = 1
    expect(countDueAutoDoses(med, at('2026-09-11T23:59:00Z'), '2026-09-11')).toBe(1);
    // Sep 12 00:00: betweenDays=1 (Sep 11) + todayDue=0 (Sep 12 not due) = 1
    expect(countDueAutoDoses(med, at('2026-09-12T00:00:00Z'), '2026-09-12')).toBe(1);
    // Sep 12 00:01: same = 1
    expect(countDueAutoDoses(med, at('2026-09-12T00:01:00Z'), '2026-09-12')).toBe(1);
  });
});

// ─── B. Rollover settlement (when sync/mutation runs after rollover) ──
describe('rollover settlement: settles past-due only, not the new day', () => {
  // B.1 sync at Sep 12 10:00 (app open since Sep 11, sync runs e.g. on a re-mount)
  it('sync after rollover (before new reminderTime) settles Sep 11 only → currentPills=28, lastSyncDate=Sep 11', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const now = at('2026-09-12T10:00:00Z');
    const result = syncAutoDailyDeductions([med], '2026-09-12', now);
    // Sep 11 (betweenDays=1) settled; Sep 12 NOT settled (todayDue=0, before 20:00).
    expect(result.updatedMeds[0].currentPills).toBe(28); // 30 - 1*2 (NOT 26)
    expect(result.updatedMeds[0].lastSyncDate).toBe('2026-09-11'); // yesterday (NOT Sep 12)
    expect(result.newLogs).toHaveLength(1);
    expect(result.newLogs[0].amount).toBe(-2);
    // Projection after sync: Sep 12 still not due → 28.
    expect(effectiveCurrentPills(result.updatedMeds[0], '2026-09-12', now)).toBe(28);
  });

  // B.2 sync at Sep 12 21:00 (after new reminderTime) — settles Sep 11 AND Sep 12 is dynamic
  it('sync after rollover (after new reminderTime) settles Sep 11; Sep 12 stays dynamic (projection=26)', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const now = at('2026-09-12T21:00:00Z');
    const result = syncAutoDailyDeductions([med], '2026-09-12', now);
    // sync settles past only (betweenDays=1, Sep 11); Sep 12 is dynamic (todayDue, not settled).
    expect(result.updatedMeds[0].currentPills).toBe(28); // 30 - 1*2 (Sep 11 only)
    expect(result.updatedMeds[0].lastSyncDate).toBe('2026-09-11'); // yesterday
    // Projection: Sep 11 (settled) + Sep 12 (dynamic due) → 28 - 2 = 26.
    expect(effectiveCurrentPills(result.updatedMeds[0], '2026-09-12', now)).toBe(26);
  });

  // B.3 manual consume after rollover: past day settled first, then today's manual applied
  it('manual consume after rollover (before today reminderTime): settles Sep 11 first, then Sep 12 manual (no double)', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const now = at('2026-09-12T10:00:00Z'); // Sep 12 10:00 (< 20:00)
    const { updatedMed } = consumeDose(med, 'manual', '2026-09-12', now);
    // settleBase (past-only) = 30 - betweenDays(1)*2 = 28 (Sep 11 settled);
    // then the manual dose (2) replaces Sep 12's dynamic auto → 26.
    expect(updatedMed).not.toBeNull();
    expect(updatedMed!.currentPills).toBe(26); // 28 (Sep 11 settled) - 2 (manual Sep 12)
    expect(updatedMed!.lastSyncDate).toBe('2026-09-12'); // manual consume settles today
    expect(updatedMed!.lastConsumedDate).toBe('2026-09-12');
    // No double: Sep 12's auto was dynamic (not settled); the manual replaced it.
    expect(effectiveCurrentPills(updatedMed!, '2026-09-12', now)).toBe(26);
  });
});

// ─── B.mutations. Other mutation paths after rollover (settle past first) ──
describe('mutations after rollover settle past elapsed days before applying', () => {
  // refill (settleAndAdjust +delta) after rollover
  it('refill after rollover: settles Sep 11 (past), adds pills, Sep 12 stays dynamic', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const now = at('2026-09-12T10:00:00Z');
    const result = settleAndAdjust(med, 10, '2026-09-12', now); // refill +10
    // settleBase (past-only) = 30 - betweenDays(1)*2 = 28; +10 → 38.
    expect(result.updatedMed.currentPills).toBe(38);
    expect(result.updatedMed.lastSyncDate).toBe('2026-09-11'); // yesterday (Sep 12 dynamic)
    // Sep 12 (before 20:00) NOT due → projection = 38.
    expect(effectiveCurrentPills(result.updatedMed, '2026-09-12', now)).toBe(38);
    // At Sep 12 20:00, Sep 12 due → 38 - 2 = 36.
    expect(effectiveCurrentPills(result.updatedMed, '2026-09-12', at('2026-09-12T20:00:00Z'))).toBe(36);
  });

  // reverse-refill after rollover
  it('reverse-refill after rollover: settles Sep 11 (past), reverses from the live balance', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const now = at('2026-09-12T10:00:00Z');
    // reverse a +30 refill: settleBase (past-only) = 28 (Sep 11 projected).
    // reversedAmount = min(refillAmount=30, settleBase=28) = 28; newCurrentPills = 28 - 28 = 0.
    const result = reverseRefill(med, 30, '2026-09-12', now);
    expect(result.reversedAmount).toBe(28); // only 28 available (Sep 11 projected)
    expect(result.updatedMed.currentPills).toBe(0);
    expect(result.updatedMed.lastSyncDate).toBe('2026-09-11'); // yesterday (Sep 12 dynamic)
  });

  // auto-deduct toggle (true→false) after rollover
  it('auto-deduct toggle (true→false) after rollover: settles Sep 11 (past), freezes', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10', autoDeductEnabled: true });
    const now = at('2026-09-12T10:00:00Z');
    const { updatedMed, log } = settleAutoDeductToggle(med, false, '2026-09-12', now);
    // Settles Sep 11 (betweenDays=1) at 2 → 28. Sep 12 not settled (frozen now).
    expect(updatedMed.currentPills).toBe(28);
    expect(updatedMed.lastSyncDate).toBe('2026-09-11'); // yesterday (gated mutation rule)
    expect(updatedMed.autoDeductEnabled).toBe(false);
    expect(log).not.toBeNull();
    expect(log!.amount).toBe(-2);
    // Frozen → projection = snapshot unchanged.
    expect(effectiveCurrentPills(updatedMed, '2026-09-12', now)).toBe(28);
  });
});

// ─── D. Rollover + manual consume (no double deduction) ───────────────
describe('rollover + manual consume (no double deduction)', () => {
  it('Sep 11 18:00 manual → Sep 12 00:01 rollover → Sep 12 20:00: no double', () => {
    // Sep 11 18:00 (before reminderTime 20:00): manual consume.
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const nowConsume = at('2026-09-11T18:00:00Z');
    const { updatedMed } = consumeDose(med, 'manual', '2026-09-11', nowConsume);
    expect(updatedMed!.currentPills).toBe(28); // 30 - 2 (Sep 11 manual)
    expect(updatedMed!.lastConsumedDate).toBe('2026-09-11');
    expect(updatedMed!.lastSyncDate).toBe('2026-09-11');

    // Sep 12 00:01 (rollover): Sep 11 consumed (lastConsumedDate=Sep 11 != Sep 12);
    // Sep 12 not due → 0 due doses → projection = 28 (NOT 26).
    expect(effectiveCurrentPills(updatedMed!, '2026-09-12', at('2026-09-12T00:01:00Z'))).toBe(28);

    // Sep 12 20:00: Sep 12 now due → projection = 28 - 2 = 26 (one dose, not double).
    expect(effectiveCurrentPills(updatedMed!, '2026-09-12', at('2026-09-12T20:00:00Z'))).toBe(26);
  });

  it('Sep 11 20:05 manual (after reminderTime) → Sep 12 rollover → no double', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    // Sep 11 20:05: auto projection = 28 (Sep 11 due). Manual consume replaces → 28.
    const nowConsume = at('2026-09-11T20:05:00Z');
    expect(effectiveCurrentPills(med, '2026-09-11', nowConsume)).toBe(28); // auto projection before
    const { updatedMed } = consumeDose(med, 'manual', '2026-09-11', nowConsume);
    expect(updatedMed!.currentPills).toBe(28); // NOT 26 — manual replaces, not adds
    expect(updatedMed!.lastConsumedDate).toBe('2026-09-11');

    // Sep 12 00:01 rollover → 28 (Sep 11 consumed, Sep 12 not due).
    expect(effectiveCurrentPills(updatedMed!, '2026-09-12', at('2026-09-12T00:01:00Z'))).toBe(28);
    // Sep 12 20:00 → 26 (Sep 12 due).
    expect(effectiveCurrentPills(updatedMed!, '2026-09-12', at('2026-09-12T20:00:00Z'))).toBe(26);
  });
});

// ─── E. Rollover + app resume (reconciliation via the existing resume architecture) ─
describe('rollover + app resume (reconciliation via projection)', () => {
  it('on resume after a date change, the projection (used by schedulers + display) is correct', () => {
    // App backgrounded across midnight; the snapshot is stale (lastSyncDate=Sep 10).
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    // "Resume" at Sep 12 10:00 — the resume handler bumps resumeTicks → re-render →
    // effectiveCurrentPills is recomputed with the fresh date. The projection (used
    // by useStockAlerts / useCriticalAlarmScheduler / useDoseReminderScheduler and
    // the display) is correct even though the snapshot is stale.
    const now = at('2026-09-12T10:00:00Z');
    expect(effectiveCurrentPills(med, '2026-09-12', now)).toBe(28); // Sep 11 due, Sep 12 not
    expect(countDueAutoDoses(med, now, '2026-09-12')).toBe(1);
    // Sep 12's dose is NOT prematurely counted.
    expect(effectiveCurrentPills(med, '2026-09-12', at('2026-09-12T20:00:00Z'))).toBe(26);
  });

  it('the snapshot catches up correctly on the next sync (settle Sep 11, not Sep 12)', () => {
    // After resume, the next sync (e.g. re-mount) settles the past-due correctly.
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const now = at('2026-09-12T10:00:00Z');
    const result = syncAutoDailyDeductions([med], '2026-09-12', now);
    expect(result.updatedMeds[0].currentPills).toBe(28); // Sep 11 only
    expect(result.updatedMeds[0].lastSyncDate).toBe('2026-09-11'); // yesterday
  });
});

// ─── F. Multi-day catch-up (PR #160 intact) ───────────────────────────
describe('multi-day catch-up (app closed several days)', () => {
  it('open Sep 14 21:00 (after reminderTime): 4 due doses (Sep 11,12,13,14)', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const now = at('2026-09-14T21:00:00Z');
    expect(countDueAutoDoses(med, now, '2026-09-14')).toBe(4); // betweenDays=3 + todayDue=1
    expect(effectiveCurrentPills(med, '2026-09-14', now)).toBe(22); // 30 - 4*2
  });

  it('open Sep 14 15:00 (before reminderTime): 3 due doses (Sep 11,12,13) — Sep 14 NOT due', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const now = at('2026-09-14T15:00:00Z');
    expect(countDueAutoDoses(med, now, '2026-09-14')).toBe(3); // betweenDays=3 + todayDue=0
    expect(effectiveCurrentPills(med, '2026-09-14', now)).toBe(24); // 30 - 3*2
  });
});

// ─── G. Dose change across rollover (no retroactive recomputation) ───
describe('dose change across rollover (old dose for past, new for future)', () => {
  it('change dailyDose at Sep 12 10:00: Sep 11 at OLD dose, Sep 12 at NEW dose', () => {
    const med = makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });
    const now = at('2026-09-12T10:00:00Z');
    // Settle Sep 11 (betweenDays=1) at OLD dose 2 → 28; change to 3.
    const { updatedMed } = settleDoseChange(med, 3, '2026-09-12', now);
    expect(updatedMed.currentPills).toBe(28); // 30 - 1*2 (old dose)
    expect(updatedMed.dailyDose).toBe(3);
    expect(updatedMed.lastSyncDate).toBe('2026-09-11'); // yesterday (Sep 12 dynamic)
    // Sep 12 (before 20:00) NOT due → 28.
    expect(effectiveCurrentPills(updatedMed, '2026-09-12', now)).toBe(28);
    // Sep 12 20:00 → Sep 12 due at NEW dose 3 → 28 - 3 = 25.
    expect(effectiveCurrentPills(updatedMed, '2026-09-12', at('2026-09-12T20:00:00Z'))).toBe(25);
  });
});

// ─── H. Reminder-time change across rollover (no retroactive) ────────
describe('reminder-time change across rollover (no retroactive recomputation of past)', () => {
  it('change reminderTime 09:00 → 20:00 at Sep 12 10:00: past days unchanged, only today changes', () => {
    // reminderTime 09:00 (old): at Sep 12 10:00, Sep 11 (betweenDays=1) + Sep 12 (todayDue=1, 10:00>=09:00) = 2 doses.
    const medOld = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
      reminderTime: '09:00',
    });
    const now = at('2026-09-12T10:00:00Z');
    expect(countDueAutoDoses(medOld, now, '2026-09-12')).toBe(2);
    expect(effectiveCurrentPills(medOld, '2026-09-12', now)).toBe(26); // 30 - 2*2

    // Change reminderTime to 20:00 (new): the PAST (Sep 11, betweenDays=1) is unchanged;
    // only today's due-ness changes (10:00 < 20:00 → Sep 12 NOT due) → 1 dose.
    const medNew = { ...medOld, reminderTime: '20:00' };
    expect(countDueAutoDoses(medNew, now, '2026-09-12')).toBe(1); // Sep 11 only
    expect(effectiveCurrentPills(medNew, '2026-09-12', now)).toBe(28); // 30 - 1*2
    // At Sep 12 20:00, Sep 12 due (new 20:00) → 2 doses.
    expect(countDueAutoDoses(medNew, at('2026-09-12T20:00:00Z'), '2026-09-12')).toBe(2);
  });
});

// ─── Time/date boundary tests (section 10) ───────────────────────────
describe('time/date boundaries (reminderTime 20:00)', () => {
  const med = () => makeRemindedMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2026-09-10' });

  it('19:59 → 20:00: todayDue flips 0 → 1 (projection 30 → 28)', () => {
    expect(effectiveCurrentPills(med(), '2026-09-11', at('2026-09-11T19:59:00Z'))).toBe(30);
    expect(effectiveCurrentPills(med(), '2026-09-11', at('2026-09-11T20:00:00Z'))).toBe(28);
  });

  it('20:00 → 20:01: projection stable at 28', () => {
    expect(effectiveCurrentPills(med(), '2026-09-11', at('2026-09-11T20:00:00Z'))).toBe(28);
    expect(effectiveCurrentPills(med(), '2026-09-11', at('2026-09-11T20:01:00Z'))).toBe(28);
  });

  it('23:59 → 00:00 (rollover): projection stable at 28', () => {
    expect(effectiveCurrentPills(med(), '2026-09-11', at('2026-09-11T23:59:00Z'))).toBe(28);
    expect(effectiveCurrentPills(med(), '2026-09-12', at('2026-09-12T00:00:00Z'))).toBe(28);
  });

  it('23:59 → 00:01 (rollover): projection stable at 28', () => {
    expect(effectiveCurrentPills(med(), '2026-09-11', at('2026-09-11T23:59:00Z'))).toBe(28);
    expect(effectiveCurrentPills(med(), '2026-09-12', at('2026-09-12T00:01:00Z'))).toBe(28);
  });
});

describe('time/date boundaries with various reminderTimes', () => {
  // reminderTime 00:00 — the dose is due at midnight. So the rollover DOES add the new day's dose.
  it('reminderTime 00:00: Sep 11 00:00 → todayDue=1; rollover to Sep 12 00:00 → Sep 12 due', () => {
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-09', // so Sep 10 + Sep 11 are betweenDays on Sep 11
      reminderTime: '00:00',
    });
    // Sep 11 00:00: betweenDays=1 (Sep 10) + todayDue=1 (Sep 11, 00:00) = 2 → 26.
    expect(countDueAutoDoses(med, at('2026-09-11T00:00:00Z'), '2026-09-11')).toBe(2);
    expect(effectiveCurrentPills(med, '2026-09-11', at('2026-09-11T00:00:00Z'))).toBe(26);
    // Sep 12 00:00 (rollover): betweenDays=2 (Sep 10, Sep 11) + todayDue=1 (Sep 12, 00:00) = 3 → 24.
    expect(countDueAutoDoses(med, at('2026-09-12T00:00:00Z'), '2026-09-12')).toBe(3);
    expect(effectiveCurrentPills(med, '2026-09-12', at('2026-09-12T00:00:00Z'))).toBe(24);
  });

  it('reminderTime 08:00: before 08:00 today NOT due; at/after 08:00 due', () => {
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
      reminderTime: '08:00',
    });
    expect(countDueAutoDoses(med, at('2026-09-11T07:59:00Z'), '2026-09-11')).toBe(0); // before 08:00
    expect(countDueAutoDoses(med, at('2026-09-11T08:00:00Z'), '2026-09-11')).toBe(1); // at 08:00
    expect(countDueAutoDoses(med, at('2026-09-11T08:01:00Z'), '2026-09-11')).toBe(1); // after
  });

  it('reminderTime 12:30: boundary at 12:30', () => {
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
      reminderTime: '12:30',
    });
    expect(countDueAutoDoses(med, at('2026-09-11T12:29:00Z'), '2026-09-11')).toBe(0);
    expect(countDueAutoDoses(med, at('2026-09-11T12:30:00Z'), '2026-09-11')).toBe(1);
    expect(countDueAutoDoses(med, at('2026-09-11T12:31:00Z'), '2026-09-11')).toBe(1);
  });

  it('reminderTime 23:59: boundary at 23:59 (last minute of the day)', () => {
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
      reminderTime: '23:59',
    });
    expect(countDueAutoDoses(med, at('2026-09-11T23:58:00Z'), '2026-09-11')).toBe(0);
    expect(countDueAutoDoses(med, at('2026-09-11T23:59:00Z'), '2026-09-11')).toBe(1);
    // Rollover to Sep 12 00:00: Sep 11 now betweenDays=1, Sep 12 not due (before 23:59) → 1.
    expect(countDueAutoDoses(med, at('2026-09-12T00:00:00Z'), '2026-09-12')).toBe(1);
  });
});

// ─── Legacy regression (reminder disabled) — calendar-day behavior intact ─
describe('legacy regression (reminder disabled) across rollover', () => {
  it('legacy: rollover adds the new day at the start of the calendar day (calendar-day behavior)', () => {
    const med = makeRemindedMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2026-09-10',
      reminderEnabled: false,
    });
    // Sep 11 15:00 (legacy): today due at start of day → 1 dose → 28.
    expect(countDueAutoDoses(med, at('2026-09-11T15:00:00Z'), '2026-09-11')).toBe(1);
    expect(effectiveCurrentPills(med, '2026-09-11', at('2026-09-11T15:00:00Z'))).toBe(28);
    // Sep 12 00:01 (rollover, legacy): Sep 11 + Sep 12 both due (calendar days) → 2 doses → 26.
    expect(countDueAutoDoses(med, at('2026-09-12T00:01:00Z'), '2026-09-12')).toBe(2);
    expect(effectiveCurrentPills(med, '2026-09-12', at('2026-09-12T00:01:00Z'))).toBe(26);
  });
});
