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
const YESTERDAY = '2024-09-11';

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
  it('1 — expired slots project exact amounts; Card targets auto-completed d1', () => {
    const med = makeMulti();
    const now = at(15);
    // Real projection path used by UI
    expect(todayDueUnits(med, now, TODAY)).toBe(1 + 1); // d1+d2
    expect(effectiveCurrentPills(med, TODAY, now)).toBe(28);

    const t = getCardDoseToggleTarget(med, now, TODAY);
    expect(t.canRestore).toBe(true);
    expect(t.doseId).toBe('d1');
    expect(t.amount).toBe(1);
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

    expect(result.wasManual).toBe(false);
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
    const med = makeMulti({ lastSyncDate: YESTERDAY, currentPills: 30 });
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
    expect(restored.wasManual).toBe(true);
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
});
