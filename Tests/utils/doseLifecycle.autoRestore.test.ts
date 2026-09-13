import { describe, it, expect } from 'vitest';
import type { Medication } from '@/types';
import {
  todayDueUnits,
  effectiveCurrentPills,
  isDoseSkippedOnDate,
  recordDoseSkipped,
  clearDoseSkippedOnDate,
  syncAutoDailyDeductions,
  isDoseConsumedOnDate,
} from '@/utils/dateCalculations';
import { getCardDoseToggleTarget, isDoseCompletedToday } from '@/utils/doseSchedule';
import { consumeDose, settleAndAdjust, resolveRestoreDoseAmount } from '@/utils/medActions';

const TODAY = '2024-09-12';

function makeMulti(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Multi',
    currentPills: 30,
    dailyDose: 6,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: TODAY,
    autoDeductEnabled: true,
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 2, time: '14:00' },
      { id: 'd3', amount: 3, time: '20:00' },
    ],
    dosesPerDay: 3,
    ...overrides,
  };
}

function at(h: number, m = 0): Date {
  return new Date(`${TODAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
}

/** Pure restore path mirroring App.handleRestoreDose (stock + skip bookkeeping). */
function restoreDose(med: Medication, doseId: string, now: Date): Medication {
  const resolved = resolveRestoreDoseAmount(med, doseId);
  if (!resolved.ok) throw new Error(resolved.reason);
  const { updatedMed } = settleAndAdjust(med, resolved.amount, TODAY, now);
  const nextConsumption = { ...(updatedMed.doseConsumption ?? {}) };
  if (nextConsumption[doseId] === TODAY) delete nextConsumption[doseId];
  const nextHistory = { ...(updatedMed.doseConsumptionHistory ?? {}) };
  if (Array.isArray(nextHistory[doseId])) {
    nextHistory[doseId] = nextHistory[doseId].filter((d) => d !== TODAY);
    if (nextHistory[doseId].length === 0) delete nextHistory[doseId];
  }
  const { doseSkippedHistory } = recordDoseSkipped(updatedMed, doseId, TODAY);
  return {
    ...updatedMed,
    doseConsumption: nextConsumption,
    doseConsumptionHistory: nextHistory,
    doseSkippedHistory,
    lastConsumedDate: undefined,
  };
}

describe('Auto-Deduct → Restore → Take lifecycle', () => {
  it('Test 1 — expired single dose auto-projects exact amount', () => {
    const med = makeMulti({
      doseSchedule: [{ id: 'only', amount: 2, time: '08:00' }],
      dosesPerDay: 1,
      dailyDose: 2,
    });
    const now = at(15);
    expect(todayDueUnits(med, now, TODAY)).toBe(2);
    expect(effectiveCurrentPills(med, TODAY, now)).toBe(28);
    expect(isDoseCompletedToday(med, med.doseSchedule![0], TODAY, now)).toBe(true);
  });

  it('Test 2 — multiple expired doses at 15:00', () => {
    const med = makeMulti();
    const now = at(15);
    expect(todayDueUnits(med, now, TODAY)).toBe(1 + 2); // d1+d2
    expect(todayDueUnits(med, now, TODAY)).not.toBe(1 + 2 + 3);
    const t = getCardDoseToggleTarget(med, now, TODAY);
    // first completed auto → restore d1
    expect(t.canRestore).toBe(true);
    expect(t.doseId).toBe('d1');
  });

  it('Test 3 — Restore auto-deducted d2 restores exact amount and isolates siblings', () => {
    const med = makeMulti();
    const now = at(15);
    const beforeEff = effectiveCurrentPills(med, TODAY, now); // 30 - 3 = 27
    expect(beforeEff).toBe(27);

    // Restore d2 only (amount 2)
    const restored = restoreDose(med, 'd2', now);
    expect(isDoseSkippedOnDate(restored, 'd2', TODAY)).toBe(true);
    expect(isDoseSkippedOnDate(restored, 'd1', TODAY)).toBe(false);
    expect(todayDueUnits(restored, now, TODAY)).toBe(1); // only d1 still due
    expect(effectiveCurrentPills(restored, TODAY, now)).toBe(29); // 30-ish +skip d2
    // stock snapshot increased by settle+adjust of +2 from past-only base
    expect(restored.currentPills).toBeGreaterThanOrEqual(med.currentPills);
  });

  it('Test 4 — Restore must survive another auto-sync', () => {
    const med = makeMulti();
    const now = at(15);
    const restored = restoreDose(med, 'd2', now);
    const dueBefore = todayDueUnits(restored, now, TODAY);
    const effBefore = effectiveCurrentPills(restored, TODAY, now);

    const sync = syncAutoDailyDeductions([restored], TODAY, now);
    const after = sync.updatedMeds[0];
    expect(todayDueUnits(after, now, TODAY)).toBe(dueBefore);
    expect(effectiveCurrentPills(after, TODAY, now)).toBe(effBefore);
    expect(isDoseSkippedOnDate(after, 'd2', TODAY)).toBe(true);
    // d2 still not due
    expect(isDoseCompletedToday(after, after.doseSchedule!.find((d) => d.id === 'd2')!, TODAY, now)).toBe(false);
  });

  it('Test 5 — Restore then manual Take: exactly one final deduction', () => {
    let med = makeMulti();
    const now = at(15);
    med = restoreDose(med, 'd2', now);
    expect(isDoseSkippedOnDate(med, 'd2', TODAY)).toBe(true);

    const result = consumeDose(med, 'manual', TODAY, now, 'd2');
    expect(result.doseAmount).toBe(2);
    expect(result.updatedMed).not.toBeNull();
    med = result.updatedMed!;
    expect(isDoseConsumedOnDate(med, 'd2', TODAY)).toBe(true);
    expect(isDoseSkippedOnDate(med, 'd2', TODAY)).toBe(false);

    const sync = syncAutoDailyDeductions([med], TODAY, now);
    const after = sync.updatedMeds[0];
    expect(todayDueUnits(after, now, TODAY)).toBe(1); // only d1
    expect(isDoseConsumedOnDate(after, 'd2', TODAY)).toBe(true);
  });

  it('Test 6 — Manual Take → Restore still works', () => {
    let med = makeMulti();
    const now = at(15);
    const taken = consumeDose(med, 'manual', TODAY, now, 'd2');
    expect(taken.doseAmount).toBe(2);
    med = taken.updatedMed!;
    expect(isDoseConsumedOnDate(med, 'd2', TODAY)).toBe(true);

    med = restoreDose(med, 'd2', now);
    expect(isDoseConsumedOnDate(med, 'd2', TODAY)).toBe(false);
    expect(isDoseSkippedOnDate(med, 'd2', TODAY)).toBe(true);
    expect(todayDueUnits(med, now, TODAY)).toBe(1); // d1 only; d2 skipped
  });

  it('Test 7 — Sibling isolation on restore d2', () => {
    const med = makeMulti({
      doseConsumption: { d1: TODAY },
      doseConsumptionHistory: { d1: [TODAY] },
    });
    const now = at(15);
    // d1 manual, d2 auto-due
    const restored = restoreDose(med, 'd2', now);
    expect(isDoseConsumedOnDate(restored, 'd1', TODAY)).toBe(true);
    expect(isDoseSkippedOnDate(restored, 'd2', TODAY)).toBe(true);
    expect(isDoseSkippedOnDate(restored, 'd1', TODAY)).toBe(false);
    expect(isDoseSkippedOnDate(restored, 'd3', TODAY)).toBe(false);
    expect(todayDueUnits(restored, now, TODAY)).toBe(0);
  });

  it('Test 8 — Explicit doseId; invalid fails safely', () => {
    const med = makeMulti();
    expect(resolveRestoreDoseAmount(med, 'd2')).toEqual({
      ok: true,
      amount: 2,
      doseId: 'd2',
    });
    expect(resolveRestoreDoseAmount(med, 'nope').ok).toBe(false);
    expect(resolveRestoreDoseAmount(med).ok).toBe(false); // multi requires id
  });

  it('Test 9 — Reordered schedule restore still targets original doseId', () => {
    const med = makeMulti({
      doseSchedule: [
        { id: 'd3', amount: 3, time: '20:00' },
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 2, time: '14:00' },
      ],
    });
    const now = at(15);
    const restored = restoreDose(med, 'd2', now);
    expect(isDoseSkippedOnDate(restored, 'd2', TODAY)).toBe(true);
    expect(resolveRestoreDoseAmount(restored, 'd2').ok).toBe(true);
    expect(todayDueUnits(restored, now, TODAY)).toBe(1); // d1
  });

  it('Test 10 — Legacy medication retains existing behavior', () => {
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
    };
    const now = at(15);
    expect(effectiveCurrentPills(med, TODAY, now)).toBe(8);
    const t = getCardDoseToggleTarget(med, now, TODAY);
    expect(t.canTake).toBe(true);
    expect(t.doseId).toBeUndefined();
  });
});
