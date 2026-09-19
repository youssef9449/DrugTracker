/**
 * Phase 7 (T7-1) — Exact-before-legacy catch-up contract.
 *
 * Startup ordering under test (same as useStartupAutoDeduction):
 *   reconcileFiredEvents (Exact)
 *   → syncAutoDailyDeductions (legacy catch-up only)
 *
 * Does not invent an occurrence ledger inside legacy sync.
 * auto_daily remains day/window audit, not Exact occurrence evidence.
 */
import { describe, it, expect } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNative';
import {
  reconcileFiredEvents,
  exactAutoLogId,
  isExactAutoOccurrenceApplied,
} from '../../src/utils/autoDeductionReconciliation';
import {
  syncAutoDailyDeductions,
  effectiveCurrentPills,
  todayDueUnits,
  isDoseConsumedOnDate,
  isDoseSkippedOnDate,
  recordDoseSkipped,
} from '../../src/utils/dateCalculations';

const TODAY = '2026-09-18';
const YESTERDAY = '2026-09-17';
const DAY_BEFORE = '2026-09-16';
const THREE_DAYS_AGO = '2026-09-15';

function multiMed(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-multi',
    name: 'MultiMed',
    currentPills: 30,
    dailyDose: 6,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSyncDate: THREE_DAYS_AGO,
    autoDeductEnabled: true,
    doseSchedule: [
      { id: 'dA', amount: 1, time: '08:00' },
      { id: 'dB', amount: 2, time: '14:00' },
      { id: 'dC', amount: 3, time: '22:00' },
    ],
    ...over,
  };
}

function fired(
  doseId: string,
  calendarDate: string,
  amount: number,
  scheduledAtEpochMs: number
): AutoDeductionEvent {
  return {
    medicationId: 'med-multi',
    doseId,
    calendarDate,
    amount,
    status: 'FIRED',
    scheduledAtEpochMs,
    createdAtEpochMs: scheduledAtEpochMs,
    reconciledAtEpochMs: null,
  };
}

/** Simulate startup: Exact reconcile then legacy sync. */
function startupExactThenLegacy(
  meds: Medication[],
  logs: ConsumptionLog[],
  events: AutoDeductionEvent[],
  todayStr: string,
  now: Date
) {
  const recon = reconcileFiredEvents(meds, logs, events, { now });
  const sync = syncAutoDailyDeductions(recon.medications, todayStr, now);
  const finalMeds =
    sync.newLogs.length > 0 ? sync.updatedMeds : recon.medications;
  const finalLogs =
    sync.newLogs.length > 0 ? [...sync.newLogs, ...recon.logs] : recon.logs;
  return { recon, sync, finalMeds, finalLogs };
}

describe('Phase 7 Exact-before-legacy catch-up (T7-1)', () => {
  describe('Case A — multi-day history: Exact FIRED + unrecorded catch-up', () => {
    it('applies each Exact event.amount once; legacy does not re-charge those slots; unrecorded past may catch up', () => {
      // Fixture:
      //   start currentPills = 30, lastSyncDate = 2026-09-15, today = 2026-09-18
      //   schedule: dA@08:00=1, dB@14:00=2, dC@22:00=3 (daily total 6)
      // Exact FIRED (in scheduled order):
      //   1) dA @ 2026-09-16 amount=1
      //   2) dB @ 2026-09-17 amount=2
      //
      // Exact apply math (gated multi + priorHistoricalUnits):
      //   Event1 dA@09-16: prior hist (lastSync, 09-16) empty → 30 − 1 = 29
      //   Event2 dB@09-17: prior hist day 09-16 unrecorded slots dB+dC = 2+3 = 5
      //                    settleBase = 29 − 5 = 24; deduct event 2 → 22
      //                    lastSync advances to day-before event = 09-16
      //   EXPECTED_EXACT_RESULT = 22
      //
      // Legacy sync after Exact (multi past-only; today not settled):
      //   past window (lastSync 09-16, today 09-18) → day 09-17 only
      //   09-17: dB consumed by Exact → remaining dA+dC = 1+3 = 4
      //   22 − 4 = 18
      //   EXPECTED_FINAL_RESULT = 18
      //
      // Exact occurrences must not be charged again by legacy (markers exclude them).
      const med = multiMed({ currentPills: 30, lastSyncDate: THREE_DAYS_AGO });
      const events = [
        fired('dA', DAY_BEFORE, 1, 100),
        fired('dB', YESTERDAY, 2, 200),
      ];
      // Afternoon today: elapsed today slots affect projection only; multi sync
      // does not settle today.
      const now = new Date(2026, 8, 18, 15, 0, 0);

      const EXPECTED_EXACT_RESULT = 22;
      const EXPECTED_FINAL_RESULT = 18;
      const EXPECTED_EXACT_LOG_COUNT = 2;
      const EXPECTED_LEGACY_CATCHUP_UNITS = 4;

      const { recon, sync, finalMeds, finalLogs } = startupExactThenLegacy(
        [med],
        [],
        events,
        TODAY,
        now
      );

      expect(recon.details.filter((d) => d.outcome === 'applied')).toHaveLength(2);
      expect(recon.details.every((d) => d.outcome === 'applied')).toBe(true);

      const afterExact = recon.medications[0];
      expect(afterExact.currentPills).toBe(EXPECTED_EXACT_RESULT);

      // Markers for Exact occurrences only
      expect(isDoseConsumedOnDate(afterExact, 'dA', DAY_BEFORE)).toBe(true);
      expect(isDoseConsumedOnDate(afterExact, 'dB', YESTERDAY)).toBe(true);
      expect(isExactAutoOccurrenceApplied(afterExact, 'dA', DAY_BEFORE, TODAY)).toBe(
        true
      );
      expect(isExactAutoOccurrenceApplied(afterExact, 'dB', YESTERDAY, TODAY)).toBe(
        true
      );

      // Exact logs: one per successful Exact occurrence; never auto_daily
      expect(recon.newExactLogs).toHaveLength(EXPECTED_EXACT_LOG_COUNT);
      const exactIds = [
        exactAutoLogId('med-multi', 'dA', DAY_BEFORE),
        exactAutoLogId('med-multi', 'dB', YESTERDAY),
      ];
      expect(recon.newExactLogs.map((l) => l.id).sort()).toEqual([...exactIds].sort());
      expect(
        recon.newExactLogs.every((l) => String(l.id).startsWith('exact-auto:'))
      ).toBe(true);

      // Re-running Exact on same events: already_applied, stock stays 22
      const second = reconcileFiredEvents(
        recon.medications,
        recon.logs,
        events,
        { now }
      );
      expect(second.details.every((d) => d.outcome === 'already_applied')).toBe(
        true
      );
      expect(second.mutated).toBe(false);
      expect(second.medications[0].currentPills).toBe(EXPECTED_EXACT_RESULT);
      expect(second.newExactLogs).toHaveLength(0);

      // Legacy catch-up: only unrecorded past units (4), not Exact slots
      expect(sync.newLogs).toHaveLength(1);
      expect(sync.newLogs[0].type).toBe('auto_daily');
      expect(String(sync.newLogs[0].id).startsWith('exact-auto:')).toBe(false);
      expect(sync.newLogs[0].amount).toBe(-EXPECTED_LEGACY_CATCHUP_UNITS);
      expect(sync.deductedSummary).toHaveLength(1);
      expect(sync.deductedSummary[0].pillsDeducted).toBe(EXPECTED_LEGACY_CATCHUP_UNITS);

      const afterLegacy = finalMeds[0];
      expect(afterLegacy.currentPills).toBe(EXPECTED_FINAL_RESULT);
      // Exact markers still present — legacy did not clear or re-charge them
      expect(isDoseConsumedOnDate(afterLegacy, 'dA', DAY_BEFORE)).toBe(true);
      expect(isDoseConsumedOnDate(afterLegacy, 'dB', YESTERDAY)).toBe(true);

      // Total durable reduction = Exact path effect to 22 + legacy 4 → 18
      // Equivalent check: never double-count Exact amounts 1+2 into legacy total
      expect(30 - EXPECTED_FINAL_RESULT).toBe(
        30 - EXPECTED_EXACT_RESULT + EXPECTED_LEGACY_CATCHUP_UNITS
      );

      // Idempotent second startup: no further Exact or legacy mutation
      const pass2 = startupExactThenLegacy(
        finalMeds,
        finalLogs,
        events,
        TODAY,
        now
      );
      expect(pass2.recon.mutated).toBe(false);
      expect(pass2.sync.newLogs).toHaveLength(0);
      expect(pass2.finalMeds[0].currentPills).toBe(EXPECTED_FINAL_RESULT);
    });
  });

  describe('Case B — Exact event for today + startup after event', () => {
    it('Exact deducts once; legacy does not deduct the same occurrence', () => {
      const med = multiMed({
        currentPills: 20,
        lastSyncDate: TODAY, // no past window
      });
      const events = [fired('dB', TODAY, 2, 300)];
      const now = new Date(2026, 8, 18, 16, 0, 0); // after 14:00

      const { recon, sync, finalMeds } = startupExactThenLegacy(
        [med],
        [],
        events,
        TODAY,
        now
      );

      expect(recon.details[0]?.outcome).toBe('applied');
      expect(recon.medications[0].currentPills).toBe(18);
      expect(isDoseConsumedOnDate(recon.medications[0], 'dB', TODAY)).toBe(true);
      expect(recon.newExactLogs).toHaveLength(1);
      expect(recon.newExactLogs[0].id).toBe(
        exactAutoLogId('med-multi', 'dB', TODAY)
      );

      // Multi gated: sync settles past only — today Exact slot must not
      // produce additional stock change for that occurrence.
      expect(sync.newLogs.length).toBe(0);
      expect(finalMeds[0].currentPills).toBe(18);

      // Second Exact pass: already_applied, stock still 18
      const again = reconcileFiredEvents(
        finalMeds,
        recon.logs,
        events,
        { now }
      );
      expect(again.details[0]?.outcome).toBe('already_applied');
      expect(again.medications[0].currentPills).toBe(18);
    });
  });

  describe('Case C — app opens before Exact dose time', () => {
    it('projection does not mutate currentPills; Exact later decreases once', () => {
      const med = multiMed({
        currentPills: 20,
        lastSyncDate: TODAY,
      });
      // 13:00 — before 14:00 slot
      const before = new Date(2026, 8, 18, 13, 0, 0);

      const pillsBefore = med.currentPills;
      const effBefore = effectiveCurrentPills(med, TODAY, before);
      // 08:00 (1) elapsed, 14:00/22:00 not → project −1
      expect(effBefore).toBe(19);
      // Projection must not write durable snapshot
      expect(med.currentPills).toBe(pillsBefore);
      expect(todayDueUnits(med, before, TODAY)).toBe(1);

      // No FIRED yet — reconcile is no-op; sync multi with lastSync=today → no past
      const idle = startupExactThenLegacy([med], [], [], TODAY, before);
      expect(idle.recon.mutated).toBe(false);
      expect(idle.sync.newLogs.length).toBe(0);
      expect(idle.finalMeds[0].currentPills).toBe(20);

      // After Exact for 14:00 amount 2
      const afterTime = new Date(2026, 8, 18, 14, 30, 0);
      const events = [fired('dB', TODAY, 2, 400)];
      const applied = reconcileFiredEvents(
        idle.finalMeds,
        idle.finalLogs,
        events,
        { now: afterTime }
      );
      expect(applied.details[0]?.outcome).toBe('applied');
      expect(applied.medications[0].currentPills).toBe(18);

      const syncAfter = syncAutoDailyDeductions(
        applied.medications,
        TODAY,
        afterTime
      );
      expect(syncAfter.newLogs.length).toBe(0);
      expect(applied.medications[0].currentPills).toBe(18);
    });
  });

  describe('Case D — consumed / skipped occurrence excluded from due math', () => {
    it('consumed and skipped slots are excluded from projection and legacy due', () => {
      let med = multiMed({
        currentPills: 20,
        lastSyncDate: TODAY,
      });
      // Mark dA consumed and dB skipped for today
      const consumed = {
        ...med,
        doseConsumption: { dA: [TODAY] },
        doseConsumptionHistory: { dA: [TODAY] },
      };
      const skipped = recordDoseSkipped(consumed, 'dB', TODAY);
      med = {
        ...consumed,
        doseSkippedHistory: skipped.doseSkippedHistory,
      };

      const now = new Date(2026, 8, 18, 23, 0, 0);
      // Only dC (3) remains due among today's slots
      expect(todayDueUnits(med, now, TODAY)).toBe(3);
      expect(effectiveCurrentPills(med, TODAY, now)).toBe(17);
      expect(isDoseConsumedOnDate(med, 'dA', TODAY)).toBe(true);
      expect(isDoseSkippedOnDate(med, 'dB', TODAY)).toBe(true);

      // Legacy sync: no past days; must not invent auto_daily for consumed/skipped
      const sync = syncAutoDailyDeductions([med], TODAY, now);
      expect(sync.newLogs.length).toBe(0);
      expect(sync.updatedMeds[0].currentPills).toBe(20);

      // FIRED for already-consumed dA → already_applied, no stock change
      const recon = reconcileFiredEvents(
        [med],
        [],
        [fired('dA', TODAY, 1, 500)],
        { now }
      );
      expect(recon.details[0]?.outcome).toBe('already_applied');
      expect(recon.medications[0].currentPills).toBe(20);
      expect(recon.mutated).toBe(false);
    });
  });

  describe('effectiveCurrentPills projection-only (D7-1)', () => {
    it('never mutates currentPills, lastSyncDate, or creates logs', () => {
      const med = multiMed({ currentPills: 12, lastSyncDate: YESTERDAY });
      const snapshot = JSON.parse(JSON.stringify(med)) as Medication;
      const now = new Date(2026, 8, 18, 15, 0, 0);
      const eff = effectiveCurrentPills(med, TODAY, now);
      expect(eff).toBeLessThan(med.currentPills);
      expect(med).toEqual(snapshot);
      expect(med.currentPills).toBe(12);
      expect(med.lastSyncDate).toBe(YESTERDAY);
    });

    it('returns currentPills unchanged when autoDeductEnabled is false', () => {
      const med = multiMed({
        currentPills: 12,
        lastSyncDate: THREE_DAYS_AGO,
        autoDeductEnabled: false,
      });
      const now = new Date(2026, 8, 18, 15, 0, 0);
      expect(effectiveCurrentPills(med, TODAY, now)).toBe(12);
    });
  });
});
