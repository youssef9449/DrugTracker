/**
 * Issue #268 / PR #271 — Legacy Single-Dose Exact fallback removed.
 *
 * A FIRED Exact occurrence is durable: the native AlarmManager created and
 * persisted it at schedule time with identity (medicationId + doseId +
 * calendarDate) and `event.amount`. The Medication's CURRENT `doseSchedule`
 * is the sole source for scheduling FUTURE occurrences, NOT a precondition
 * for reconciling a FIRED one. Editing or removing the dose from the current
 * schedule AFTER the alarm fired does NOT invalidate the already-occurred
 * event; `event.amount` remains the authoritative charge.
 *
 * No Legacy Single-Dose fallback:
 *   - no `LEGACY_DOSE_ID` sentinel,
 *   - no `dailyDose` / `reminderTime` / `reminderEnabled` / `lastConsumedDate`
 *     fallback for amount or identity,
 *   - no first-dose / next-dose / array-index fallback,
 *   - no empty / sentinel doseId.
 *
 * The ONLY identity failure that blocks a FIRED occurrence from applying is
 * a malformed identity (empty/missing doseId, bad calendarDate) — which is
 * terminal at the runner level (no infinite retry). Invalid amount stays
 * retryable with no ACK.
 *
 * `lastConsumedDate` is written ONLY when the Medication still has an
 * explicit non-empty `doseSchedule` AND every slot for the calendar day is
 * consumed. A med whose schedule was removed/edited still gets its FIRED
 * occurrence applied via event.amount, but with no schedule to test
 * all-consumed it does NOT write lastConsumedDate (no doseId-only write).
 */
import { describe, it, expect } from 'vitest';
import type { Medication } from '../../src/types';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNative';
import {
} from '../../src/utils/dateCalculations';
import {
  reconcileFiredEvents,
  exactAutoLogId,
  applyExactAutoEventToMedication } from '../../src/utils/autoDeductionReconciliation';

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

/** Exact FIRED event with a non-empty doseId for a med with no schedule. */
function noScheduleFiredEvent(amount: number): AutoDeductionEvent {
  return {
    medicationId: 'med-1',
    doseId: 'd1',
    calendarDate: TODAY,
    amount,
    status: 'FIRED',
    scheduledAtEpochMs: 1,
    createdAtEpochMs: 1,
    reconciledAtEpochMs: null,
  };
}

describe('legacy single-dose (no doseSchedule): FIRED is durable; no Legacy Single-Dose fallback (#268 / PR #271)', () => {
  it('applyExactAutoEventToMedication: no doseSchedule + non-empty doseId → applies event.amount (NOT dailyDose)', () => {
    const med = legacyMed({ dailyDose: 5 });
    const e = noScheduleFiredEvent(2);
    const applied = applyExactAutoEventToMedication(med, e, NOW);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // 10 − event.amount(2) = 8, NOT 10 − dailyDose(5) = 5.
      expect(applied.updatedMed.currentPills).toBe(8);
      expect(applied.log.amount).toBe(-2);
      expect(applied.log.doseId).toBe('d1');
      expect(applied.log.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
      // No schedule → no lastConsumedDate write.
      expect(applied.updatedMed.lastConsumedDate).toBeUndefined();
    }
  });

  it('applyExactAutoEventToMedication: empty doseSchedule array → applies event.amount', () => {
    const med = legacyMed({ doseSchedule: [] });
    const e = noScheduleFiredEvent(2);
    const applied = applyExactAutoEventToMedication(med, e, NOW);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.updatedMed.currentPills).toBe(8);
      expect(applied.log.amount).toBe(-2);
    }
  });

  it('applyExactAutoEventToMedication: doseId removed from current schedule after fire → applies event.amount', () => {
    // The med was scheduled with d1; the native created FIRED med-1+d1+TODAY.
    // The user then removed d1 from the current doseSchedule. The FIRED
    // occurrence already happened → reconciliation applies event.amount.
    const med = legacyMed({
      doseSchedule: [{ id: 'd2', amount: 1, time: '20:00' }],
    });
    const e = noScheduleFiredEvent(2);
    const applied = applyExactAutoEventToMedication(med, e, NOW);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.updatedMed.currentPills).toBe(8);
      expect(applied.log.amount).toBe(-2);
      expect(applied.log.doseId).toBe('d1');
      expect(applied.updatedMed.lastConsumedDate).toBeUndefined();
    }
  });

  it('applyExactAutoEventToMedication: empty doseId → ok:false (malformed identity, not applied)', () => {
    // Empty doseId is the ONLY identity failure that blocks application.
    const med = legacyMed();
    const e: AutoDeductionEvent = {
      ...noScheduleFiredEvent(2),
      doseId: '',
    };
    const applied = applyExactAutoEventToMedication(med, e, NOW);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.reason).toBe('invalid_dose_id');
    }
  });

  it('reconcileFiredEvents: no doseSchedule + non-empty doseId → applied once with event.amount; terminal ACK', () => {
    const med = legacyMed({ currentPills: 10, dailyDose: 5 });
    const r = reconcileFiredEvents([med], [], [noScheduleFiredEvent(2)], {
      now: NOW,
    });
    expect(r.details[0].outcome).toBe('applied');
    expect(r.mutated).toBe(true);
    // event.amount (2), NOT dailyDose (5).
    expect(r.medications[0].currentPills).toBe(8);
    expect(r.newExactLogs).toHaveLength(1);
    expect(r.newExactLogs[0].amount).toBe(-2);
    expect(r.newExactLogs[0].id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    expect(r.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY },
    ]);
    // No lastConsumedDate write (no schedule).
    expect(r.medications[0].lastConsumedDate).toBeUndefined();
  });

  it('reconcileFiredEvents: no doseSchedule + empty doseId → skipped_invalid, terminal ACK (malformed identity)', () => {
    // Empty doseId is a malformed identity → terminal ACK, no stock, no log.
    const med = legacyMed();
    const e: AutoDeductionEvent = { ...noScheduleFiredEvent(2), doseId: '' };
    const r = reconcileFiredEvents([med], [], [e], { now: NOW });
    expect(r.details[0].outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: '', calendarDate: TODAY },
    ]);
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it('reconcileFiredEvents: retry of the same FIRED after apply → already_applied, no duplicate deduction/log', () => {
    const med = legacyMed({ currentPills: 10 });
    const e = noScheduleFiredEvent(2);
    const r1 = reconcileFiredEvents([med], [], [e], { now: NOW });
    expect(r1.mutated).toBe(true);
    expect(r1.medications[0].currentPills).toBe(8);

    // Second pass re-lists the same FIRED; the durable exact log + consume
    // marker make it already_applied (no duplicate deduction or log).
    const r2 = reconcileFiredEvents(r1.medications, r1.logs, [e], { now: NOW });
    expect(r2.details[0].outcome).toBe('already_applied');
    expect(r2.mutated).toBe(false);
    expect(r2.medications[0].currentPills).toBe(8);
    expect(r2.newExactLogs).toEqual([]);
    expect(
      r2.logs.filter((l) => l.id === exactAutoLogId('med-1', 'd1', TODAY))
    ).toHaveLength(1);
  });

  it('reconcileFiredEvents: no doseSchedule + valid identity → durable consume marker written for the occurrence', () => {
    // The exact apply writes a per-occurrence consume marker (doseConsumption +
    // doseConsumptionHistory) keyed by doseId+calendarDate, independent of the
    // current schedule membership. This is the recovery source on retry.
    const med = legacyMed({ currentPills: 10 });
    const r = reconcileFiredEvents([med], [], [noScheduleFiredEvent(2)], {
      now: NOW,
    });
    expect(r.medications[0].doseConsumption?.['d1']).toBe(TODAY);
    expect(r.medications[0].doseConsumptionHistory?.['d1']).toContain(TODAY);
  });

  it('no Exact log id is ever built with an empty doseId', () => {
    // exactAutoLogId with an empty doseId is the historical legacy shape.
    // The malformed-identity path never reaches log construction.
    const med = legacyMed();
    const e: AutoDeductionEvent = { ...noScheduleFiredEvent(2), doseId: '' };
    const r = reconcileFiredEvents([med], [], [e], { now: NOW });
    const legacyLogId = exactAutoLogId('med-1', '', TODAY);
    expect(r.logs.find((l) => l.id === legacyLogId)).toBeUndefined();
  });
});

/**
 * Explicit-schedule semantics are unchanged and remain authoritative for
 * scheduling FUTURE occurrences. `event.amount` is the authoritative charge
 * for a FIRED occurrence even when it differs from the current schedule amount.
 */
describe('explicit doseSchedule: Exact Auto unchanged after legacy removal', () => {
  it('multi-dose semantics unchanged: slot-level timing still drives fullDueUnits', () => {
    const multiMed: Medication = {
      ...legacyMed(),
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      lastSyncDate: '2026-09-12',
    };
    const breakdown =(multiMed, NOW, TODAY);
    expect(breakdown.gated).toBe(true);
    expect(breakdown.pastDueUnits).toBe(1);
    expect(breakdown.todayDueUnits).toBe(1);
    expect(breakdown.fullDueUnits).toBe(2);
  });

  it('schedule amount 1 and exact amount 2 → final stock 8 (authoritative event.amount)', () => {
    const multiMed: Medication = {
      ...legacyMed(),
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      lastSyncDate: '2026-09-13',
    };
    const event: AutoDeductionEvent = {
      ...noScheduleFiredEvent(2),
      doseId: 'd1',
    };
    const r = reconcileFiredEvents([multiMed], [], [event], { now: NOW });
    expect(r.medications[0].currentPills).toBe(8);
    expect(r.newExactLogs[0].amount).toBe(-2);
    expect(r.newExactLogs[0].id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
  });
});
