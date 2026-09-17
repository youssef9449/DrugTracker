/**
 * Phase 4 regression — legacy single-dose (no doseSchedule) after Exact Auto.
 *
 * Scenario (exact numbers from the Phase 4 audit):
 *   medication: legacy single-dose, no doseSchedule
 *   currentPills = 10, dailyDose = 1
 *   lastSyncDate = '2026-09-13', todayStr = '2026-09-14'
 *   now = new Date('2026-09-14T09:00:00')
 *   Exact FIRED event amount = 2 for calendarDate '2026-09-14'
 *
 * applyExactAutoEventToMedication() deducts the authoritative event.amount (2)
 * and leaves lastSyncDate behind (legacy non-gated has no prior-historical
 * window). A Phase 4 mutation that then runs legacy settlement
 * (settleAutoDeductToggle / settleDoseChange) used to charge today's dose
 * AGAIN because computeDueDoseBreakdown()'s legacy path folded today into
 * fullDueUnits even though today's occurrence was already consumed:
 *   10 → 8 (exact) → 7 (legacy settlement double-charge)  ← the bug
 * The corrected contract:
 *   10 → 8 (exact) → 8 (legacy settlement must be a no-op for that occurrence)
 *
 * Invariants preserved:
 *   - Legacy semantics unchanged when today's dose is NOT consumed.
 *   - Multi-dose semantics unchanged (slot-level timing + todayDueUnits).
 *   - occurrence identity = medicationId + doseId + calendarDate.
 */
import { describe, it, expect } from 'vitest';
import type { Medication } from '../../src/types';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNative';
import {
  computeDueDoseBreakdown,
  settleAutoDeductToggle,
  settleDoseChange,
  syncAutoDailyDeductions,
  effectiveCurrentPills,
} from '../../src/utils/dateCalculations';
import {
  reconcileFiredEvents,
  exactAutoLogId,
} from '../../src/utils/autoDeductionReconciliation';

const TODAY = '2026-09-14';
const NOW = new Date('2026-09-14T09:00:00');

function legacyMed(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'LegacyMed',
    currentPills: 10,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSyncDate: '2026-09-13',
    autoDeductEnabled: true,
    ...over,
  };
}

function legacyFiredEvent(amount: number): AutoDeductionEvent {
  return {
    medicationId: 'med-1',
    // Empty doseId normalizes to the LEGACY_DOSE_ID sentinel.
    doseId: '',
    calendarDate: TODAY,
    amount,
    status: 'FIRED',
    scheduledAtEpochMs: 1,
    createdAtEpochMs: 1,
    reconciledAtEpochMs: null,
  };
}

describe('legacy single-dose: exact reconciliation then legacy settlement', () => {
  it('applyExactAutoEventToMedication path: amount 2 applied, lastSyncDate left behind', () => {
    const med = legacyMed();
    const r = reconcileFiredEvents([med], [], [legacyFiredEvent(2)], {
      now: NOW,
    });
    expect(r.medications[0].currentPills).toBe(8);
    // Exact leaves lastSyncDate before the event day for legacy non-gated.
    expect(r.medications[0].lastSyncDate).toBe('2026-09-13');
    // The occurrence is durably marked consumed (identity: med + legacy dose + date).
    expect(r.medications[0].lastConsumedDate).toBe(TODAY);
    expect(r.newExactLogs).toHaveLength(1);
    expect(r.newExactLogs[0].id).toBe(exactAutoLogId('med-1', 'legacy', TODAY));
    expect(r.newExactLogs[0].amount).toBe(-2);
  });

  it('computeDueDoseBreakdown: today already consumed by exact → fullDueUnits excludes today', () => {
    const applied = reconcileFiredEvents([legacyMed()], [], [legacyFiredEvent(2)], {
      now: NOW,
    });
    const med = applied.medications[0];
    const breakdown = computeDueDoseBreakdown(med, NOW, TODAY);
    expect(breakdown.consumedToday).toBe(true);
    // The exact event already charged the occurrence (amount 2). Legacy
    // settlement must not count today's dose again → due window is empty.
    expect(breakdown.fullDueUnits).toBe(0);
    expect(breakdown.fullDueDoses).toBe(0);
  });

  it('computeDueDoseBreakdown: today NOT consumed → legacy semantics preserved', () => {
    // Same lastSyncDate/today as the bug scenario but no consumption marker:
    // the legacy path must keep charging the full (lastSync, today] window.
    const med = legacyMed();
    const breakdown = computeDueDoseBreakdown(med, NOW, TODAY);
    expect(breakdown.consumedToday).toBe(false);
    expect(breakdown.fullDueDoses).toBe(1);
    expect(breakdown.fullDueUnits).toBe(1);
  });

  it('settleAutoDeductToggle (ON→OFF) after exact reconciliation: stock stays 8, no settlement log', () => {
    const applied = reconcileFiredEvents([legacyMed()], [], [legacyFiredEvent(2)], {
      now: NOW,
    });
    const med = applied.medications[0];
    const { updatedMed, log } = settleAutoDeductToggle(med, false, TODAY, NOW);
    // Double-deduction regression: legacy settlement after exact reconciliation
    // must NOT deduct the same occurrence a second time (8, not 7).
    expect(updatedMed.currentPills).toBe(8);
    expect(log).toBeNull();
    expect(updatedMed.autoDeductEnabled).toBe(false);
  });

  it('settleDoseChange (dailyDose 1→3) after exact reconciliation: stock stays 8, no settlement log', () => {
    const applied = reconcileFiredEvents([legacyMed()], [], [legacyFiredEvent(2)], {
      now: NOW,
    });
    const med = applied.medications[0];
    const { updatedMed, log } = settleDoseChange(med, 3, TODAY, NOW);
    expect(updatedMed.currentPills).toBe(8);
    expect(updatedMed.dailyDose).toBe(3);
    expect(log).toBeNull();
  });

  it('full chain: exact → toggle settle → dose-change settle → sync never re-deducts the occurrence', () => {
    const applied = reconcileFiredEvents([legacyMed()], [], [legacyFiredEvent(2)], {
      now: NOW,
    });
    const afterExact = applied.medications[0];

    const toggled = settleAutoDeductToggle(
      { ...afterExact, autoDeductEnabled: true },
      false,
      TODAY,
      NOW
    ).updatedMed;
    expect(toggled.currentPills).toBe(8);

    const reEnabled = { ...toggled, autoDeductEnabled: true };
    const doseChanged = settleDoseChange(reEnabled, 2, TODAY, NOW).updatedMed;
    expect(doseChanged.currentPills).toBe(8);

    const synced = syncAutoDailyDeductions(
      [{ ...doseChanged, autoDeductEnabled: true }],
      TODAY,
      NOW
    );
    expect(synced.updatedMeds[0].currentPills).toBe(8);
    expect(synced.newLogs).toHaveLength(0);
  });

  it('effectiveCurrentPills displays 8 (not the double-charged 7 projection)', () => {
    const applied = reconcileFiredEvents([legacyMed()], [], [legacyFiredEvent(2)], {
      now: NOW,
    });
    const med = applied.medications[0];
    expect(effectiveCurrentPills(med, TODAY, NOW)).toBe(8);
  });

  it('multi-dose semantics unchanged: slot-level timing still drives fullDueUnits', () => {
    // Multi-dose guard: no recorded consumption; today's slot elapsed and
    // unconsumed at 09:00 → past(1) + today(1) = 2 units. The legacy fix
    // must not touch the multi branch.
    const multiMed: Medication = {
      ...legacyMed(),
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      lastSyncDate: '2026-09-12',
    };
    const breakdown = computeDueDoseBreakdown(multiMed, NOW, TODAY);
    expect(breakdown.gated).toBe(true);
    expect(breakdown.pastDueUnits).toBe(1);
    expect(breakdown.todayDueUnits).toBe(1);
    expect(breakdown.fullDueUnits).toBe(2);
  });

  it('multi-dose with schedule amount 1 and exact amount 2 → final stock 8 (authoritative event.amount)', () => {
    const multiMed: Medication = {
      ...legacyMed(),
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      // lastSync strictly before the event day so the exact occurrence is
      // reconcilable (past-day horizon guard does not swallow it).
      lastSyncDate: '2026-09-13',
    };
    const event: AutoDeductionEvent = {
      ...legacyFiredEvent(2),
      doseId: 'd1',
    };
    const r = reconcileFiredEvents([multiMed], [], [event], { now: NOW });
    expect(r.medications[0].currentPills).toBe(8);
    expect(r.newExactLogs[0].amount).toBe(-2);
  });
});
