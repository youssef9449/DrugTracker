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
      // lastSync = 2026-09-15. Today = 2026-09-18.
      // Exact covered: 09-16 dA (1), 09-17 dB (2) — event.amount authoritative.
      // 09-16 dB+dC and 09-17 dA+dC remain unrecorded → legacy past catch-up.
      const med = multiMed({ currentPills: 30, lastSyncDate: THREE_DAYS_AGO });
      const events = [
        fired('dA', DAY_BEFORE, 1, 100),
        fired('dB', YESTERDAY, 2, 200),
      ];
      // Afternoon today so today's elapsed slots exist for projection only;
      // multi sync must not settle today.
      const now = new Date(2026, 8, 18, 15, 0, 0);

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
      // 30 - 1 - 2 = 27 from Exact alone (prior hist fold may also settle
      // unrecorded slots on event days before the event — design allows
      // priorHistoricalUnits for gated meds). Stock must be strictly lower.
      expect(afterExact.currentPills).toBeLessThan(30);

      // Markers for Exact occurrences
      expect(isDoseConsumedOnDate(afterExact, 'dA', DAY_BEFORE)).toBe(true);
      expect(isDoseConsumedOnDate(afterExact, 'dB', YESTERDAY)).toBe(true);
      expect(isExactAutoOccurrenceApplied(afterExact, 'dA', DAY_BEFORE, TODAY)).toBe(
        true
      );
      expect(isExactAutoOccurrenceApplied(afterExact, 'dB', YESTERDAY, TODAY)).toBe(
        true
      );

      // Exact logs only for Exact path
      const exactIds = [
        exactAutoLogId('med-multi', 'dA', DAY_BEFORE),
        exactAutoLogId('med-multi', 'dB', YESTERDAY),
      ];
      for (const id of exactIds) {
        expect(recon.newExactLogs.some((l) => l.id === id)).toBe(true);
      }

      // Re-running Exact on same events must be already_applied (once)
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
      expect(second.medications[0].currentPills).toBe(afterExact.currentPills);

      // Legacy sync after Exact: may catch up remaining past units, but must
      // not produce exact-auto:* logs and must not re-apply Exact slots.
      expect(sync.newLogs.every((l) => !String(l.id).startsWith('exact-auto:'))).toBe(
        true
      );
      const final = finalMeds[0];
      expect(isDoseConsumedOnDate(final, 'dA', DAY_BEFORE)).toBe(true);
      expect(isDoseConsumedOnDate(final, 'dB', YESTERDAY)).toBe(true);

      // auto_daily is catch-up audit only — presence does not prove Exact identity
      for (const log of sync.newLogs) {
        expect(log.type).toBe('auto_daily');
        expect(log.id.startsWith('exact-auto:')).toBe(false);
      }

      // Idempotent startup second pass: no further Exact mutation
      const pass2 = startupExactThenLegacy(
        finalMeds,
        finalLogs,
        events,
        TODAY,
        now
      );
      expect(pass2.recon.mutated).toBe(false);
      expect(pass2.finalMeds[0].currentPills).toBe(final.currentPills);
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
