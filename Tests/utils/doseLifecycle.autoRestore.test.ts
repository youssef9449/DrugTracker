import { describe, it, expect } from 'vitest';
import type { Medication } from '@/types';
import {
  todayDueUnits,
  effectiveCurrentPills,
  isDoseSkippedOnDate,
  isDoseConsumedOnDate,
  syncAutoDailyDeductions,
} from '@/utils/dateCalculations';
import {
  getCardDoseToggleTarget,
  isDoseCompletedToday,
} from '@/utils/doseSchedule';
import {
  consumeDose,
  restoreDose,
  resolveRestoreDoseAmount,
} from '@/utils/medActions';

/**
 * Lifecycle tests for Auto-Deduct → Restore → Take.
 *
 * Production helpers only:
 * - syncAutoDailyDeductions (real auto-settlement path)
 * - restoreDose (extracted from App.handleRestoreDose)
 * - consumeDose (real manual Take path)
 *
 * Stock model note:
 * For multi-dose, today's elapsed slots are projected (todayDueUnits) and
 * only past calendar days are settled into currentPills by sync.
 * Restoring an auto-only today slot records doseSkippedHistory without
 * inflating currentPills (would double-count). Manual restore undoes the
 * consume settlement (+amount).
 */

const TODAY = '2024-09-12';

function makeMulti(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Multi',
    currentPills: 30,
    dailyDose: 4,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: TODAY,
    autoDeductEnabled: true,
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 1, time: '14:00' },
      { id: 'd3', amount: 2, time: '20:00' },
    ],
    dosesPerDay: 3,
    ...overrides,
  };
}

function at(h: number, m = 0): Date {
  return new Date(
    `${TODAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
  );
}

describe('production restoreDose + syncAutoDailyDeductions lifecycle', () => {
  it('1 — expired slots project exact amounts; Card Take advances past auto-only d1', () => {
    const med = makeMulti();
    const now = at(15);
    // Real projection path used by UI
    expect(todayDueUnits(med, now, TODAY)).toBe(1 + 1); // d1+d2
    expect(effectiveCurrentPills(med, TODAY, now)).toBe(28);

    // PR #196: auto-elapsed only is NOT Card Restore; Take advances to next incomplete.
    const t = getCardDoseToggleTarget(med, now, TODAY);
    expect(t.canRestore).toBe(false);
    expect(t.canTake).toBe(true);
    expect(t.doseId).toBe('d3'); // d1+d2 auto-completed at 15:00; d3@20:00 still open
    expect(t.amount).toBe(2);
    expect(
      isDoseCompletedToday(med, med.doseSchedule![0], TODAY, now)
    ).toBe(true);
  });

  it('2 — restoreDose (production) undoes auto-projected d1 without inflating snapshot', () => {
    const med = makeMulti();
    const now = at(15);
    const pillsBefore = med.currentPills;
    const dueBefore = todayDueUnits(med, now, TODAY);
    const effBefore = effectiveCurrentPills(med, TODAY, now);

    const result = restoreDose(med, 'd1', TODAY, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.wasActuallyConsumed).toBe(false);
    expect(result.restoredAmount).toBe(1);
    expect(result.doseId).toBe('d1');
    // Auto-only: currentPills unchanged (projection undo via skip)
    expect(result.updatedMed.currentPills).toBe(pillsBefore);
    expect(isDoseSkippedOnDate(result.updatedMed, 'd1', TODAY)).toBe(true);
    expect(isDoseConsumedOnDate(result.updatedMed, 'd1', TODAY)).toBe(false);
    // Due units drop by exact d1 amount; effective rises by 1
    expect(todayDueUnits(result.updatedMed, now, TODAY)).toBe(dueBefore - 1);
    expect(effectiveCurrentPills(result.updatedMed, TODAY, now)).toBe(
      effBefore + 1
    );
    // Siblings not skipped
    expect(isDoseSkippedOnDate(result.updatedMed, 'd2', TODAY)).toBe(false);
    expect(isDoseSkippedOnDate(result.updatedMed, 'd3', TODAY)).toBe(false);
  });

  it('3 — after restore, real syncAutoDailyDeductions does not re-deduct d1', () => {
    // lastSync must be strictly before the past day to settle (exclusive range).
    const med = makeMulti({ lastSyncDate: '2024-09-10', currentPills: 30 });
    const now = at(15);

    // First sync settles YESTERDAY fully into snapshot (past days only).
    const first = syncAutoDailyDeductions([med], TODAY, now);
    const afterFirst = first.updatedMeds[0];
    // past day full schedule = 4; lastSync advances to yesterday boundary
    expect(afterFirst.currentPills).toBe(26); // 30 - 4
    // today still projects d1+d2
    expect(todayDueUnits(afterFirst, now, TODAY)).toBe(2);

    // Restore auto d1 (skip only)
    const restored = restoreDose(afterFirst, 'd1', TODAY, now);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const afterRestore = restored.updatedMed;
    expect(isDoseSkippedOnDate(afterRestore, 'd1', TODAY)).toBe(true);
    const pillsAfterRestore = afterRestore.currentPills;
    const dueAfterRestore = todayDueUnits(afterRestore, now, TODAY);
    const effAfterRestore = effectiveCurrentPills(afterRestore, TODAY, now);

    // Run sync AGAIN — past already settled; must not touch d1 skip
    const second = syncAutoDailyDeductions([afterRestore], TODAY, now);
    const afterSecond = second.updatedMeds[0];
    expect(afterSecond.currentPills).toBe(pillsAfterRestore);
    expect(todayDueUnits(afterSecond, now, TODAY)).toBe(dueAfterRestore);
    expect(effectiveCurrentPills(afterSecond, TODAY, now)).toBe(effAfterRestore);
    expect(isDoseSkippedOnDate(afterSecond, 'd1', TODAY)).toBe(true);
    // d1 still available for Take (not completed)
    expect(
      isDoseCompletedToday(
        afterSecond,
        afterSecond.doseSchedule!.find((d) => d.id === 'd1')!,
        TODAY,
        now
      )
    ).toBe(false);
  });

  it('4 — Restore → production consumeDose: exactly one manual deduction', () => {
    let med = makeMulti();
    const now = at(15);

    const r = restoreDose(med, 'd2', TODAY, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    med = r.updatedMed;
    expect(isDoseSkippedOnDate(med, 'd2', TODAY)).toBe(true);

    const taken = consumeDose(med, 'manual', TODAY, now, 'd2');
    expect(taken.doseAmount).toBe(1); // exact d2.amount, not dailyDose
    expect(taken.updatedMed).not.toBeNull();
    med = taken.updatedMed!;
    expect(isDoseConsumedOnDate(med, 'd2', TODAY)).toBe(true);
    expect(isDoseSkippedOnDate(med, 'd2', TODAY)).toBe(false);
    expect(taken.log?.doseId).toBe('d2');

    // Sync again — must not double-deduct d2
    const sync = syncAutoDailyDeductions([med], TODAY, now);
    const after = sync.updatedMeds[0];
    expect(isDoseConsumedOnDate(after, 'd2', TODAY)).toBe(true);
    expect(todayDueUnits(after, now, TODAY)).toBe(1); // only d1 still due
  });

  it('5 — Manual Take → production restoreDose undoes settlement +amount', () => {
    let med = makeMulti({ currentPills: 30, lastSyncDate: TODAY });
    const now = at(15);

    const taken = consumeDose(med, 'manual', TODAY, now, 'd2');
    expect(taken.doseAmount).toBe(1);
    med = taken.updatedMed!;
    const pillsAfterTake = med.currentPills;
    expect(isDoseConsumedOnDate(med, 'd2', TODAY)).toBe(true);

    const restored = restoreDose(med, 'd2', TODAY, now);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.wasActuallyConsumed).toBe(true);
    expect(restored.restoredAmount).toBe(1);
    // Manual path: snapshot increases by exact amount
    expect(restored.updatedMed.currentPills).toBe(pillsAfterTake + 1);
    expect(isDoseConsumedOnDate(restored.updatedMed, 'd2', TODAY)).toBe(false);
    expect(isDoseSkippedOnDate(restored.updatedMed, 'd2', TODAY)).toBe(true);
    // Future sync must not re-deduct (skip)
    const sync = syncAutoDailyDeductions([restored.updatedMed], TODAY, now);
    expect(isDoseSkippedOnDate(sync.updatedMeds[0], 'd2', TODAY)).toBe(true);
    expect(todayDueUnits(sync.updatedMeds[0], now, TODAY)).not.toBeGreaterThan(
      todayDueUnits(restored.updatedMed, now, TODAY)
    );
  });

  it('6 — sibling isolation: restore d1 leaves manual d2 intact', () => {
    let med = makeMulti();
    const now = at(15);
    const taken = consumeDose(med, 'manual', TODAY, now, 'd2');
    med = taken.updatedMed!;
    expect(isDoseConsumedOnDate(med, 'd2', TODAY)).toBe(true);

    const restored = restoreDose(med, 'd1', TODAY, now);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(isDoseSkippedOnDate(restored.updatedMed, 'd1', TODAY)).toBe(true);
    expect(isDoseConsumedOnDate(restored.updatedMed, 'd2', TODAY)).toBe(true);
    expect(isDoseSkippedOnDate(restored.updatedMed, 'd2', TODAY)).toBe(false);
    expect(isDoseSkippedOnDate(restored.updatedMed, 'd3', TODAY)).toBe(false);
  });

  it('7 — restore d3 amount 2 never uses dailyDose', () => {
    const med = makeMulti();
    const now = at(21); // all elapsed
    const resolved = resolveRestoreDoseAmount(med, 'd3');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.amount).toBe(2);
    expect(resolved.amount).not.toBe(med.dailyDose);

    const result = restoreDose(med, 'd3', TODAY, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredAmount).toBe(2);
  });

  it('8 — reordered schedule still restores by doseId', () => {
    const med = makeMulti({
      doseSchedule: [
        { id: 'd3', amount: 2, time: '20:00' },
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
      ],
    });
    const now = at(15);
    const result = restoreDose(med, 'd2', TODAY, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doseId).toBe('d2');
    expect(isDoseSkippedOnDate(result.updatedMed, 'd2', TODAY)).toBe(true);
    expect(isDoseSkippedOnDate(result.updatedMed, 'd1', TODAY)).toBe(false);
  });

  it('9 — invalid / missing doseId fails safely on production restoreDose', () => {
    const med = makeMulti();
    expect(restoreDose(med, 'nope', TODAY, at(15)).ok).toBe(false);
    expect(restoreDose(med, undefined, TODAY, at(15)).ok).toBe(false);
  });

  it('10 — legacy medication: restoreDose keeps dailyDose semantics', () => {
    const med: Medication = {
      id: 'leg',
      name: 'Legacy',
      currentPills: 10,
      dailyDose: 2,
      unit: 'قرص',
      warningThresholdDays: 5,
      colorTag: 'teal',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastSyncDate: TODAY,
      autoDeductEnabled: true,
      reminderEnabled: true,
      reminderTime: '09:00',
      lastConsumedDate: TODAY,
    };
    const now = at(15);
    // After manual consume settlement would have currentPills already reduced;
    // restore adds dailyDose back via settleAndAdjust.
    const result = restoreDose(med, undefined, TODAY, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredAmount).toBe(2);
    expect(result.updatedMed.lastConsumedDate).toBeUndefined();
    expect(result.updatedMed.currentPills).toBeGreaterThanOrEqual(med.currentPills);
  });

  it('11 — Card after auto-restore exposes Take for the same doseId', () => {
    const med = makeMulti();
    const now = at(15);
    const restored = restoreDose(med, 'd1', TODAY, now);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const t = getCardDoseToggleTarget(restored.updatedMed, now, TODAY);
    expect(t.canTake).toBe(true);
    expect(t.doseId).toBe('d1');
    expect(t.amount).toBe(1);
  });

  it('12 — skip state is on the medication object (durable with med persistence)', () => {
    const med = makeMulti();
    const now = at(15);
    const restored = restoreDose(med, 'd1', TODAY, now);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    // doseSkippedHistory is part of Medication — same object graph App persists
    expect(restored.updatedMed.doseSkippedHistory).toEqual({ d1: [TODAY] });
    // Round-trip through JSON like localStorage path
    const reloaded = JSON.parse(
      JSON.stringify(restored.updatedMed)
    ) as Medication;
    expect(isDoseSkippedOnDate(reloaded, 'd1', TODAY)).toBe(true);
    const sync = syncAutoDailyDeductions([reloaded], TODAY, now);
    expect(isDoseSkippedOnDate(sync.updatedMeds[0], 'd1', TODAY)).toBe(true);
    expect(todayDueUnits(sync.updatedMeds[0], now, TODAY)).toBe(
      todayDueUnits(reloaded, now, TODAY)
    );
  });

  /**
   * Regression gap 1 — REAL production Auto-Deduct → Restore → Auto-Sync.
   *
   * Multi-dose sync settles only *past* calendar days into currentPills.
   * We make Sep 11 due solely for d1 (d2/d3 already recorded consumed that day)
   * so syncAutoDailyDeductions deducts exactly d1.amount = 1.
   *
   * After restoreDose(d1, Sep 11), skip is durable. To prove the skip rule
   * itself (not merely lastSync advancing past the day), we re-open Sep 11
   * by setting lastSyncDate back to Sep 10 and run sync again — the same
   * production historicalDayDueUnits path must exclude d1 and must not
   * deduct a second time.
   */
  it('REGRESSION: production sync auto-deducts d1 → restoreDose → re-sync does not re-deduct d1', () => {
    const pastDay = '2024-09-11';
    const today = '2024-09-12';
    const nowBeforeTodaySlots = new Date('2024-09-12T07:00:00');

    const med: Medication = {
      id: 'med-1',
      name: 'Multi',
      currentPills: 30,
      dailyDose: 4,
      unit: 'قرص',
      warningThresholdDays: 5,
      colorTag: 'teal',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastSyncDate: '2024-09-10',
      autoDeductEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
        { id: 'd3', amount: 2, time: '20:00' },
      ],
      dosesPerDay: 3,
      // Sep 11: only d1 still auto-due; d2/d3 already consumed that day
      doseConsumption: { d2: pastDay, d3: pastDay },
      doseConsumptionHistory: {
        d2: [pastDay],
        d3: [pastDay],
      },
    };

    // 1) Real production auto-deduction — exactly d1.amount
    const sync1 = syncAutoDailyDeductions([med], today, nowBeforeTodaySlots);
    const afterSync1 = sync1.updatedMeds[0];
    expect(sync1.deductedSummary.length).toBe(1);
    expect(sync1.deductedSummary[0].pillsDeducted).toBe(1);
    expect(afterSync1.currentPills).toBe(29);
    expect(afterSync1.lastSyncDate).not.toBe('2024-09-10');

    // Sibling consumption marks intact
    expect(isDoseConsumedOnDate(afterSync1, 'd2', pastDay)).toBe(true);
    expect(isDoseConsumedOnDate(afterSync1, 'd3', pastDay)).toBe(true);
    expect(isDoseConsumedOnDate(afterSync1, 'd1', pastDay)).toBe(false);

    // 2) Production restore for the same doseId + pastDay that was settled
    const restored = restoreDose(afterSync1, 'd1', pastDay, nowBeforeTodaySlots);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.doseId).toBe('d1');
    expect(restored.restoredAmount).toBe(1);
    expect(restored.wasActuallyConsumed).toBe(false);
    // Auto-only path: skip recorded (durable identity)
    expect(isDoseSkippedOnDate(restored.updatedMed, 'd1', pastDay)).toBe(true);
    // d2/d3 unchanged
    expect(isDoseConsumedOnDate(restored.updatedMed, 'd2', pastDay)).toBe(true);
    expect(isDoseConsumedOnDate(restored.updatedMed, 'd3', pastDay)).toBe(true);
    expect(isDoseSkippedOnDate(restored.updatedMed, 'd2', pastDay)).toBe(false);
    expect(isDoseSkippedOnDate(restored.updatedMed, 'd3', pastDay)).toBe(false);

    // 3) Re-open pastDay eligibility (lastSync rewound) so second sync is NOT a
    // no-op from lastSync alone — it re-enters historicalDayDueUnits for pastDay.
    // Skip must cause past due for pastDay to be 0 (d1 skipped; d2/d3 consumed).
    const reopened: Medication = {
      ...restored.updatedMed,
      lastSyncDate: '2024-09-10',
      currentPills: restored.updatedMed.currentPills, // still 29 after auto-only restore
    };
    const pillsBeforeSecond = reopened.currentPills;
    const sync2 = syncAutoDailyDeductions([reopened], today, nowBeforeTodaySlots);
    const afterSync2 = sync2.updatedMeds[0];

    // No second deduction of d1 (and no other past units left)
    expect(afterSync2.currentPills).toBe(pillsBeforeSecond);
    expect(sync2.deductedSummary.length).toBe(0);
    expect(isDoseSkippedOnDate(afterSync2, 'd1', pastDay)).toBe(true);
    // Siblings still untouched
    expect(isDoseConsumedOnDate(afterSync2, 'd2', pastDay)).toBe(true);
    expect(isDoseConsumedOnDate(afterSync2, 'd3', pastDay)).toBe(true);
  });

  /**
   * Regression gap 2 — Double Restore must not credit stock twice.
   *
   * Pure production restoreDose:
   * - First auto-only restore records skip; currentPills unchanged (projection model).
   * - Second restoreDose on same doseId+date: still wasActuallyConsumed=false, skip idempotent,
   *   currentPills still unchanged (no second credit).
   *
   * Manual path (stock moves): first restore +amount once; second sees wasActuallyConsumed=false
   * after consumption cleared, so does not settleAndAdjust again.
   *
   * App-layer skipped_day log guard remains the UI duplicate-restore protection;
   * this test covers the production pure helper stock contract.
   */
  it('REGRESSION: double production restoreDose does not credit dose.amount twice', () => {
    const today = '2024-09-12';
    const now = new Date('2024-09-12T15:00:00');

    // --- Auto-only double restore (today projected slot) ---
    const medAuto: Medication = {
      id: 'med-1',
      name: 'Multi',
      currentPills: 30,
      dailyDose: 4,
      unit: 'قرص',
      warningThresholdDays: 5,
      colorTag: 'teal',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastSyncDate: today,
      autoDeductEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
        { id: 'd3', amount: 2, time: '20:00' },
      ],
      dosesPerDay: 3,
    };

    const firstAuto = restoreDose(medAuto, 'd1', today, now);
    expect(firstAuto.ok).toBe(true);
    if (!firstAuto.ok) return;
    expect(firstAuto.wasActuallyConsumed).toBe(false);
    expect(firstAuto.restoredAmount).toBe(1);
    expect(firstAuto.updatedMed.currentPills).toBe(30);
    expect(isDoseSkippedOnDate(firstAuto.updatedMed, 'd1', today)).toBe(true);
    expect(firstAuto.updatedMed.doseSkippedHistory?.d1).toEqual([today]);

    const secondAuto = restoreDose(firstAuto.updatedMed, 'd1', today, now);
    expect(secondAuto.ok).toBe(true);
    if (!secondAuto.ok) return;
    // No second stock credit
    expect(secondAuto.updatedMed.currentPills).toBe(30);
    // Skip remains a single date entry (idempotent recordDoseSkipped)
    expect(secondAuto.updatedMed.doseSkippedHistory?.d1).toEqual([today]);
    // Siblings never skipped
    expect(isDoseSkippedOnDate(secondAuto.updatedMed, 'd2', today)).toBe(false);
    expect(isDoseSkippedOnDate(secondAuto.updatedMed, 'd3', today)).toBe(false);

    // --- Manual Take → Restore → Restore again (stock moves once) ---
    let medManual: Medication = {
      ...medAuto,
      currentPills: 30,
    };
    const taken = consumeDose(medManual, 'manual', today, now, 'd2');
    expect(taken.doseAmount).toBe(1);
    medManual = taken.updatedMed!;
    const pillsAfterTake = medManual.currentPills;

    const firstManualRestore = restoreDose(medManual, 'd2', today, now);
    expect(firstManualRestore.ok).toBe(true);
    if (!firstManualRestore.ok) return;
    expect(firstManualRestore.wasActuallyConsumed).toBe(true);
    expect(firstManualRestore.restoredAmount).toBe(1);
    expect(firstManualRestore.updatedMed.currentPills).toBe(pillsAfterTake + 1);
    const pillsAfterFirstRestore = firstManualRestore.updatedMed.currentPills;

    const secondManualRestore = restoreDose(
      firstManualRestore.updatedMed,
      'd2',
      today,
      now
    );
    expect(secondManualRestore.ok).toBe(true);
    if (!secondManualRestore.ok) return;
    // Second restore is no longer "manual" (consume cleared) → no second +amount
    expect(secondManualRestore.wasActuallyConsumed).toBe(false);
    expect(secondManualRestore.updatedMed.currentPills).toBe(pillsAfterFirstRestore);
    expect(isDoseSkippedOnDate(secondManualRestore.updatedMed, 'd2', today)).toBe(
      true
    );
    // d1/d3 still not skipped/consumed
    expect(isDoseSkippedOnDate(secondManualRestore.updatedMed, 'd1', today)).toBe(
      false
    );
    expect(isDoseConsumedOnDate(secondManualRestore.updatedMed, 'd3', today)).toBe(
      false
    );
  });

  /**
   * Future restore must NOT durable-skip the slot: when the scheduled time
   * arrives, time-gated Auto-Deduct (todayDueUnits) must still count it.
   */
  it('Test A/B — future restored dose is not skipped and becomes due at scheduled time', () => {
    // d3 = 20:00 amount 2; now = 17:00 (still ahead)
    const nowEarly = at(17);
    const nowAtDue = at(20);
    let med = makeMulti({ currentPills: 30, lastSyncDate: TODAY });

    // Premature manual deduction of future d3, then Restore
    const taken = consumeDose(med, 'manual', TODAY, nowEarly, 'd3');
    expect(taken.doseAmount).toBe(2);
    med = taken.updatedMed!;
    expect(isDoseConsumedOnDate(med, 'd3', TODAY)).toBe(true);

    const restored = restoreDose(med, 'd3', TODAY, nowEarly);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.wasActuallyConsumed).toBe(true);
    expect(restored.restoredAmount).toBe(2);
    // Future restore: NO durable skip
    expect(isDoseSkippedOnDate(restored.updatedMed, 'd3', TODAY)).toBe(false);
    expect(isDoseConsumedOnDate(restored.updatedMed, 'd3', TODAY)).toBe(false);

    // Test B — immediately after restore, still before 20:00: not due
    expect(todayDueUnits(restored.updatedMed, nowEarly, TODAY)).toBe(
      todayDueUnits(makeMulti({ lastSyncDate: TODAY }), nowEarly, TODAY)
    );
    // d1+d2 elapsed (08:00, 14:00) = 2; d3 not yet
    expect(todayDueUnits(restored.updatedMed, nowEarly, TODAY)).toBe(1 + 1);

    // Test A — at 20:00, d3 becomes due exactly once (amount 2)
    expect(todayDueUnits(restored.updatedMed, nowAtDue, TODAY)).toBe(1 + 1 + 2);
    const effAtDue = effectiveCurrentPills(restored.updatedMed, TODAY, nowAtDue);
    expect(effAtDue).toBe(restored.updatedMed.currentPills - (1 + 1 + 2));
  });

  /**
   * Strengthened lifecycle: premature consume → Restore → production
   * syncAutoDailyDeductions at 19:59 / 20:00 / again.
   *
   * Multi-dose sync is gated: it settles only *past calendar days* into
   * currentPills; today's slots stay projected via effectiveCurrentPills
   * (todayDueUnits). Assertions therefore check both the snapshot path
   * (sync must not invent a same-day snapshot deduction for d3) and the
   * live Auto-Deduct balance (exactly d3.amount=2 appears at 20:00, once).
   */
  it('Test A/B strengthened — sync + effective balance: no d3 before 20:00, exact -2 at 20:00, no second -2', () => {
    const nowEarly = at(17);
    const nowBeforeDue = new Date(`${TODAY}T19:59:00`);
    const nowAtDue = at(20);
    const nowAfterDue = at(21);

    let med = makeMulti({ currentPills: 30, lastSyncDate: TODAY });

    // Premature consume of future d3 (amount 2), then Restore
    const taken = consumeDose(med, 'manual', TODAY, nowEarly, 'd3');
    expect(taken.doseAmount).toBe(2);
    med = taken.updatedMed!;
    const pillsAfterTake = med.currentPills;

    const restored = restoreDose(med, 'd3', TODAY, nowEarly);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    med = restored.updatedMed;

    // Restored amount is back in the snapshot; no durable skip
    expect(med.currentPills).toBe(pillsAfterTake + 2);
    expect(isDoseSkippedOnDate(med, 'd3', TODAY)).toBe(false);
    expect(isDoseConsumedOnDate(med, 'd3', TODAY)).toBe(false);

    const pillsAfterRestore = med.currentPills;
    // Baseline live balance before d3 is due: only d1+d2 projected (2 units)
    const effBeforeD3 = effectiveCurrentPills(med, TODAY, nowBeforeDue);
    expect(todayDueUnits(med, nowBeforeDue, TODAY)).toBe(1 + 1);
    expect(effBeforeD3).toBe(pillsAfterRestore - (1 + 1));

    // --- sync at 19:59: d3 must NOT be deducted yet ---
    const syncBefore = syncAutoDailyDeductions([med], TODAY, nowBeforeDue);
    const medBefore = syncBefore.updatedMeds[0];
    // Gated same-day: no past-day units to settle → snapshot unchanged
    expect(medBefore.currentPills).toBe(pillsAfterRestore);
    expect(isDoseSkippedOnDate(medBefore, 'd3', TODAY)).toBe(false);
    expect(todayDueUnits(medBefore, nowBeforeDue, TODAY)).toBe(1 + 1);
    expect(effectiveCurrentPills(medBefore, TODAY, nowBeforeDue)).toBe(effBeforeD3);
    // No auto_daily log for a zero same-day settlement
    expect(
      syncBefore.newLogs.some(
        (l) => l.medicationId === med.id && l.type === 'auto_daily'
      )
    ).toBe(false);

    // --- sync at 20:00: d3 becomes due (live balance -2); snapshot still gated ---
    const syncAtDue = syncAutoDailyDeductions([medBefore], TODAY, nowAtDue);
    const medAtDue = syncAtDue.updatedMeds[0];
    expect(isDoseSkippedOnDate(medAtDue, 'd3', TODAY)).toBe(false);
    // Snapshot: still no past-day settlement (lastSync is TODAY)
    expect(medAtDue.currentPills).toBe(pillsAfterRestore);
    // Live Auto-Deduct: d3.amount (2) is now included exactly once
    expect(todayDueUnits(medAtDue, nowAtDue, TODAY)).toBe(1 + 1 + 2);
    const effAtDue = effectiveCurrentPills(medAtDue, TODAY, nowAtDue);
    expect(effAtDue).toBe(pillsAfterRestore - (1 + 1 + 2));
    // Exact d3 contribution vs pre-due balance
    expect(effAtDue).toBe(effBeforeD3 - 2);

    // --- second sync at/after 20:00: must NOT deduct d3 again ---
    const syncAgain = syncAutoDailyDeductions([medAtDue], TODAY, nowAfterDue);
    const medAgain = syncAgain.updatedMeds[0];
    expect(isDoseSkippedOnDate(medAgain, 'd3', TODAY)).toBe(false);
    expect(medAgain.currentPills).toBe(pillsAfterRestore);
    expect(todayDueUnits(medAgain, nowAfterDue, TODAY)).toBe(1 + 1 + 2);
    expect(effectiveCurrentPills(medAgain, TODAY, nowAfterDue)).toBe(effAtDue);
    // Still no skip-based "solution" and no extra snapshot drain
    expect(medAgain.currentPills).toBe(medAtDue.currentPills);
  });

  /**
   * When the calendar day of a future-restored slot is fully past, production
   * syncAutoDailyDeductions settles that day into currentPills. Prove d3
   * (amount 2) is deducted exactly once and a second sync does not repeat it.
   */
  it('Test A/B past-day settlement — future-restored d3 deducts exact amount once via syncAutoDailyDeductions', () => {
    const pastDay = '2024-09-11';
    const today = '2024-09-12';
    const nowOnPastDayEarly = new Date('2024-09-11T17:00:00');
    const nowToday = new Date('2024-09-12T10:00:00');

    // Start synced through day before pastDay so pastDay is unsettled history.
    let med = makeMulti({
      currentPills: 30,
      lastSyncDate: '2024-09-10',
      // d1/d2 already recorded consumed on pastDay → only d3 remains due historically
      doseConsumption: { d1: pastDay, d2: pastDay },
      doseConsumptionHistory: { d1: [pastDay], d2: [pastDay] },
    });

    // Premature consume of d3 on pastDay at 17:00 (before 20:00), then Restore
    const taken = consumeDose(med, 'manual', pastDay, nowOnPastDayEarly, 'd3');
    expect(taken.doseAmount).toBe(2);
    med = taken.updatedMed!;
    const restored = restoreDose(med, 'd3', pastDay, nowOnPastDayEarly);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    med = restored.updatedMed;
    expect(isDoseSkippedOnDate(med, 'd3', pastDay)).toBe(false);
    expect(isDoseConsumedOnDate(med, 'd3', pastDay)).toBe(false);

    const pillsBeforeSync = med.currentPills;

    // First sync on the next calendar day settles pastDay: only d3 (2 units)
    const first = syncAutoDailyDeductions([med], today, nowToday);
    const afterFirst = first.updatedMeds[0];
    expect(isDoseSkippedOnDate(afterFirst, 'd3', pastDay)).toBe(false);
    expect(afterFirst.currentPills).toBe(pillsBeforeSync - 2);
    expect(
      first.newLogs.some(
        (l) =>
          l.medicationId === med.id &&
          l.type === 'auto_daily' &&
          l.amount === -2
      )
    ).toBe(true);

    // Second sync: lastSync advanced; must not deduct d3 again
    const second = syncAutoDailyDeductions([afterFirst], today, nowToday);
    const afterSecond = second.updatedMeds[0];
    expect(afterSecond.currentPills).toBe(afterFirst.currentPills);
    expect(
      second.newLogs.some(
        (l) => l.medicationId === med.id && l.type === 'auto_daily'
      )
    ).toBe(false);
  });

  it('Test C — past-due auto restore still records skip and blocks re-deduct', () => {
    const med = makeMulti();
    const now = at(15); // d1 and d2 elapsed
    const result = restoreDose(med, 'd1', TODAY, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isDoseSkippedOnDate(result.updatedMed, 'd1', TODAY)).toBe(true);
    const dueAfter = todayDueUnits(result.updatedMed, now, TODAY);
    const sync = syncAutoDailyDeductions([result.updatedMed], TODAY, now);
    expect(isDoseSkippedOnDate(sync.updatedMeds[0], 'd1', TODAY)).toBe(true);
    expect(todayDueUnits(sync.updatedMeds[0], now, TODAY)).toBe(dueAfter);
  });

  it('Test D — past-due manual Take → Restore remains protected from auto re-deduct', () => {
    let med = makeMulti({ currentPills: 30, lastSyncDate: TODAY });
    const now = at(15);
    const taken = consumeDose(med, 'manual', TODAY, now, 'd2');
    med = taken.updatedMed!;
    const restored = restoreDose(med, 'd2', TODAY, now);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(isDoseSkippedOnDate(restored.updatedMed, 'd2', TODAY)).toBe(true);
    expect(todayDueUnits(restored.updatedMed, now, TODAY)).toBe(1); // only d1
    const sync = syncAutoDailyDeductions([restored.updatedMed], TODAY, now);
    expect(isDoseSkippedOnDate(sync.updatedMeds[0], 'd2', TODAY)).toBe(true);
    expect(todayDueUnits(sync.updatedMeds[0], now, TODAY)).toBe(1);
  });

  it('Test E — sibling isolation: future restore of d3 does not touch d1/d2', () => {
    let med = makeMulti({ currentPills: 30, lastSyncDate: TODAY });
    const now = at(17);
    const taken = consumeDose(med, 'manual', TODAY, now, 'd3');
    med = taken.updatedMed!;
    // Also mark d1 consumed so we can see isolation
    const takenD1 = consumeDose(med, 'manual', TODAY, now, 'd1');
    med = takenD1.updatedMed!;

    const restored = restoreDose(med, 'd3', TODAY, now);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(isDoseSkippedOnDate(restored.updatedMed, 'd3', TODAY)).toBe(false);
    expect(isDoseConsumedOnDate(restored.updatedMed, 'd1', TODAY)).toBe(true);
    expect(isDoseSkippedOnDate(restored.updatedMed, 'd1', TODAY)).toBe(false);
    expect(isDoseSkippedOnDate(restored.updatedMed, 'd2', TODAY)).toBe(false);
    expect(isDoseConsumedOnDate(restored.updatedMed, 'd3', TODAY)).toBe(false);
  });

  it('Test F — future restore of d3 adjusts by exact amount 2 not dailyDose', () => {
    let med = makeMulti({ currentPills: 30, lastSyncDate: TODAY });
    const now = at(17);
    const taken = consumeDose(med, 'manual', TODAY, now, 'd3');
    expect(taken.doseAmount).toBe(2);
    med = taken.updatedMed!;
    const pillsAfter = med.currentPills;
    const restored = restoreDose(med, 'd3', TODAY, now);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.restoredAmount).toBe(2);
    expect(restored.restoredAmount).not.toBe(med.dailyDose);
    expect(restored.updatedMed.currentPills).toBe(pillsAfter + 2);
  });

  it('future restore then evaluate after scheduled time still due once (app reopen path)', () => {
    // Simulate app reopen after scheduled time: same med state, later `now`.
    const nowEarly = at(17);
    let med = makeMulti({ currentPills: 30, lastSyncDate: TODAY });
    const taken = consumeDose(med, 'manual', TODAY, nowEarly, 'd3');
    med = taken.updatedMed!;
    const restored = restoreDose(med, 'd3', TODAY, nowEarly);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const afterRestore = restored.updatedMed;
    expect(isDoseSkippedOnDate(afterRestore, 'd3', TODAY)).toBe(false);

    // "Reopen" at 21:00 — d3 due via projection; still not skipped
    const nowLate = at(21);
    expect(isDoseSkippedOnDate(afterRestore, 'd3', TODAY)).toBe(false);
    expect(todayDueUnits(afterRestore, nowLate, TODAY)).toBe(1 + 1 + 2);
    // Sync settles past days only (gated); today's due stays projected
    const sync = syncAutoDailyDeductions([afterRestore], TODAY, nowLate);
    expect(isDoseSkippedOnDate(sync.updatedMeds[0], 'd3', TODAY)).toBe(false);
    expect(todayDueUnits(sync.updatedMeds[0], nowLate, TODAY)).toBe(1 + 1 + 2);
  });

  /**
   * Section 1 — Auto (with durable consume marker + auto_daily log) → Restore
   * must leave a durable skip for the SAME occurrence so the projection path
   * (todayDueUnits / effectiveCurrentPills) cannot re-project the dose and a
   * later legacy syncAutoDailyDeductions cannot re-deduct it. This is the
   * projection-only sibling of the gated "Auto → Restore → reconcile" test.
   */
  it('Section 1 — Auto consume marker → Restore → no re-projection via effectiveCurrentPills', () => {
    // Simulate Exact Auto having applied d1: consume marker set, auto_daily
    // log durable, currentPills already deducted by 1 (30 → 29).
    const autoApplied: Medication = {
      ...makeMulti({ currentPills: 29, lastSyncDate: TODAY }),
      doseConsumption: { d1: TODAY },
      doseConsumptionHistory: { d1: [TODAY] },
    };
    const autoLogs = [
      {
        id: 'auto-section1-d1',
        medicationId: 'med-1',
        medicationName: 'Multi',
        type: 'auto_daily' as const,
        amount: -1,
        date: TODAY,
        timestamp: '',
        description: '',
        doseId: 'd1',
      },
    ];
    const now = at(15); // d1 (08:00) and d2 (14:00) elapsed; d3 (20:00) not yet.

    // Before restore: d1 consumed → todayDueUnits excludes d1 → d2 only = 1.
    expect(todayDueUnits(autoApplied, now, TODAY)).toBe(1);
    expect(effectiveCurrentPills(autoApplied, TODAY, now)).toBe(28);

    const restored = restoreDose(autoApplied, 'd1', TODAY, now, autoLogs);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.wasActuallyConsumed).toBe(true);
    expect(restored.restoredAmount).toBe(1);

    const after = restored.updatedMed;
    // Stock restored (29 + 1 = 30).
    expect(after.currentPills).toBe(30);
    // Consume marker cleared so Take is eligible again.
    expect(isDoseConsumedOnDate(after, 'd1', TODAY)).toBe(false);
    // Durable skip left for the SAME occurrence (d1 + TODAY).
    expect(isDoseSkippedOnDate(after, 'd1', TODAY)).toBe(true);
    // Sibling d2 untouched.
    expect(isDoseSkippedOnDate(after, 'd2', TODAY)).toBe(false);
    expect(isDoseConsumedOnDate(after, 'd2', TODAY)).toBe(false);

    // Projection: d1 skipped (excluded), d2 elapsed (1), d3 not yet → 1.
    // effectiveCurrentPills = 30 - 1 = 29 (NOT 28 — no re-projection of d1).
    expect(todayDueUnits(after, now, TODAY)).toBe(1);
    expect(effectiveCurrentPills(after, TODAY, now)).toBe(29);
    expect(effectiveCurrentPills(after, TODAY, now)).not.toBe(28);

    // Legacy sync must not re-deduct d1 (skip blocks historicalDayDueUnits).
    const sync = syncAutoDailyDeductions([after], TODAY, now);
    const afterSync = sync.updatedMeds[0];
    expect(isDoseSkippedOnDate(afterSync, 'd1', TODAY)).toBe(true);
    expect(afterSync.currentPills).toBe(30);
    expect(todayDueUnits(afterSync, now, TODAY)).toBe(1);
    expect(effectiveCurrentPills(afterSync, TODAY, now)).toBe(29);
  });
});
