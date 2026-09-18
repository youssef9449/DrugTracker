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

/**
 * Phase 4 — HISTORICAL legacy Exact Auto double-deduction regression.
 *
 * The same-day scenario above is not the only hole. The Exact Auto event for
 * a legacy single-dose med can be HISTORICAL (calendarDate strictly between
 * lastSyncDate and today). applyExactAutoEventToMedication() deducts the
 * authoritative event.amount, records the durable LEGACY_DOSE_ID consume
 * marker for that calendar date, and (legacy non-gated → not gated) leaves
 * lastSyncDate behind. The legacy settlement window (lastSyncDate, todayStr]
 * then still contains the already-charged historical day, and an aggregate
 * `totalDays * dailyDose` re-charges it — the historical double-deduction:
 *
 *   currentPills = 50, dailyDose = 1
 *   lastSyncDate = 2026-09-09, todayStr = 2026-09-14
 *   Exact FIRED 2026-09-12 amount = 2 → 50 → 48
 *   legacy settlement used to charge 5 days (48 → 43), re-charging 09-12.
 *   Correct: 4 unconsumed days (09-10, 09-11, 09-13, 09-14) → 48 → 44.
 *
 * The contract under test:
 *   legacy due units =
 *     sum over every day in (lastSyncDate, todayStr] of dailyDose
 *     minus days with a durable legacy consume/skip marker.
 * A consumed TODAY excludes ONLY today — it must never block settlement of
 * the historical unconsumed days.
 */
describe('legacy single-dose: historical exact events must not be charged twice', () => {
  const HIST_LAST_SYNC = '2026-09-09';

  /** Fixture from the audit: 50 pills, lastSync 09-09, today 09-14. */
  function historicalMed(over: Partial<Medication> = {}): Medication {
    return legacyMed({
      currentPills: 50,
      lastSyncDate: HIST_LAST_SYNC,
      ...over,
    });
  }

  /** Exact FIRED event for the implicit legacy dose on an arbitrary date. */
  function legacyFiredEventOn(calendarDate: string, amount: number): AutoDeductionEvent {
    return { ...legacyFiredEvent(amount), calendarDate };
  }

  /** Run the legacy app-open sync against the reconciled state. */
  function legacySync(meds: Medication[]) {
    return syncAutoDailyDeductions(meds, TODAY, NOW);
  }

  it('Test A — historical Exact event (09-12) must not be charged twice: 50 → 48 → 44 (not 43)', () => {
    const r = reconcileFiredEvents(
      [historicalMed()],
      [],
      [legacyFiredEventOn('2026-09-12', 2)],
      { now: NOW }
    );
    const afterExact = r.medications[0];
    // Authoritative event.amount applied exactly once.
    expect(afterExact.currentPills).toBe(48);
    // Durable per-occurrence marker for the historical day (primary source).
    expect(afterExact.doseConsumptionHistory?.legacy).toContain('2026-09-12');
    // Legacy non-gated exact apply leaves lastSyncDate behind.
    expect(afterExact.lastSyncDate).toBe(HIST_LAST_SYNC);

    const synced = legacySync(r.medications);
    // 09-10 + 09-11 + 09-13 + 09-14 = 4 units; 09-12 already consumed → skip.
    expect(synced.updatedMeds[0].currentPills).toBe(44);
    // Settled days reflected in the sync log (4 days, 4 units).
    expect(synced.newLogs).toHaveLength(1);
    expect(synced.newLogs[0].amount).toBe(-4);
    // Snapshot advanced so the settled window cannot be re-charged.
    expect(synced.updatedMeds[0].lastSyncDate).toBe(TODAY);
    // Idempotent: a second sync is a no-op.
    const resynced = legacySync(synced.updatedMeds);
    expect(resynced.updatedMeds[0].currentPills).toBe(44);
    expect(resynced.newLogs).toHaveLength(0);
  });

  it('Test B — exact today (09-14) + historical legacy settlement: 50 → 48 → 44 (consumedToday is not a global blocker)', () => {
    const r = reconcileFiredEvents(
      [historicalMed()],
      [],
      [legacyFiredEventOn(TODAY, 2)],
      { now: NOW }
    );
    const afterExact = r.medications[0];
    expect(afterExact.currentPills).toBe(48);
    expect(afterExact.lastConsumedDate).toBe(TODAY);

    // 09-10..09-13 due (4), 09-14 consumed by Exact → excluded.
    // The old `!consumedToday` guard swallowed the whole sync (stayed 48).
    const synced = legacySync(r.medications);
    expect(synced.updatedMeds[0].currentPills).toBe(44);
    expect(synced.newLogs).toHaveLength(1);
    expect(synced.newLogs[0].amount).toBe(-4);
    expect(synced.updatedMeds[0].lastSyncDate).toBe(TODAY);
  });

  it('Test C — multiple historical Exact events: 50 → 44 (exact −6) → 42 (legacy settles 09-11 + 09-13)', () => {
    const r = reconcileFiredEvents(
      [historicalMed()],
      [],
      [
        legacyFiredEventOn('2026-09-10', 2),
        legacyFiredEventOn('2026-09-12', 2),
        legacyFiredEventOn(TODAY, 2),
      ],
      { now: NOW }
    );
    // Exact total = 6.
    expect(r.medications[0].currentPills).toBe(44);
    // All three occurrences durably marked by date (primary source — the
    // mid-window days are excluded via history, not lastConsumedDate alone,
    // which only records the latest date 09-14).
    expect(r.medications[0].doseConsumptionHistory?.legacy).toEqual([
      '2026-09-10',
      '2026-09-12',
      TODAY,
    ]);
    expect(r.medications[0].lastConsumedDate).toBe(TODAY);

    const synced = legacySync(r.medications);
    // Remaining unconsumed days: 09-11 + 09-13 = 2 units.
    expect(synced.updatedMeds[0].currentPills).toBe(42);
    expect(synced.newLogs[0].amount).toBe(-2);
  });

  it('Test D — no markers preserves legacy behavior: 5 units settled, 50 → 45', () => {
    // computeDueDoseBreakdown keeps the pre-change aggregate semantics when
    // no consume/skip markers exist inside the window.
    const breakdown = computeDueDoseBreakdown(historicalMed(), NOW, TODAY);
    expect(breakdown.consumedToday).toBe(false);
    expect(breakdown.fullDueDoses).toBe(5);
    expect(breakdown.fullDueUnits).toBe(5);

    const synced = legacySync([historicalMed()]);
    expect(synced.updatedMeds[0].currentPills).toBe(45);
    expect(synced.newLogs[0].amount).toBe(-5);
    expect(synced.deductedSummary[0].daysPassed).toBe(5);
  });

  it('Test E — historical exact then settleDoseChange: exact-consumed 09-12 not re-deducted (48 → 44)', () => {
    const applied = reconcileFiredEvents(
      [historicalMed()],
      [],
      [legacyFiredEventOn('2026-09-12', 2)],
      { now: NOW }
    );
    const med = applied.medications[0];
    expect(med.currentPills).toBe(48);

    const { updatedMed, log } = settleDoseChange(med, 2, TODAY, NOW);
    // Settles the 4 unconsumed days at the OLD dose (1), never 09-12 again.
    expect(updatedMed.currentPills).toBe(44);
    expect(updatedMed.dailyDose).toBe(2);
    expect(log).not.toBeNull();
    expect(log!.amount).toBe(-4);
    // The historical exact marker survives the mutation.
    expect(updatedMed.doseConsumptionHistory?.legacy).toContain('2026-09-12');
  });

  it('Test F — historical exact then settleAutoDeductToggle: exact-consumed day skipped, unconsumed days settled (48 → 44)', () => {
    const applied = reconcileFiredEvents(
      [historicalMed()],
      [],
      [legacyFiredEventOn('2026-09-12', 2)],
      { now: NOW }
    );
    const med = applied.medications[0];
    expect(med.currentPills).toBe(48);

    const { updatedMed, log } = settleAutoDeductToggle(med, false, TODAY, NOW);
    // Historical unconsumed days (4 units) settled; 09-12 not re-charged.
    expect(updatedMed.currentPills).toBe(44);
    expect(updatedMed.autoDeductEnabled).toBe(false);
    expect(log).not.toBeNull();
    expect(log!.amount).toBe(-4);
  });

  it('Test G — effectiveCurrentPills projection reflects only unconsumed days/occurrences', () => {
    const applied = reconcileFiredEvents(
      [historicalMed()],
      [],
      [legacyFiredEventOn('2026-09-12', 2)],
      { now: NOW }
    );
    // Projection after the historical exact marker: 48 − 4 unconsumed days.
    expect(effectiveCurrentPills(applied.medications[0], TODAY, NOW)).toBe(44);

    const multi = reconcileFiredEvents(
      [historicalMed()],
      [],
      [
        legacyFiredEventOn('2026-09-10', 2),
        legacyFiredEventOn('2026-09-12', 2),
        legacyFiredEventOn(TODAY, 2),
      ],
      { now: NOW }
    );
    // Projection after three historical markers: 44 − 2 (09-11 + 09-13).
    expect(effectiveCurrentPills(multi.medications[0], TODAY, NOW)).toBe(42);
  });

  it('skip marker (Restore) on a historical day is also excluded by date, not period', () => {
    // Restore writes a durable skip marker for the legacy occurrence.
    const med = historicalMed({
      doseSkippedHistory: { legacy: ['2026-09-12'] },
    });
    const breakdown = computeDueDoseBreakdown(med, NOW, TODAY);
    // 5 days minus skipped 09-12 = 4 units.
    expect(breakdown.fullDueUnits).toBe(4);
    expect(breakdown.fullDueDoses).toBe(4);
  });
});
