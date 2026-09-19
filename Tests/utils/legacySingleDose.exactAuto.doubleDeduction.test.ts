/**
 * Issue #268 / PR #271 — Legacy Single-Dose Exact path removed.
 *
 * Pre-PR this file guarded the legacy single-dose Exact double-deduction
 * regression (a no-`doseSchedule` med charged once by Exact Auto then again
 * by legacy day-settlement). That whole path is gone: a Medication without an
 * explicit, non-empty `doseSchedule` whose array contains the event `doseId`
 * can no longer produce an Exact stock mutation, an Exact log, a consume
 * marker, or a `lastConsumedDate` write — `applyExactAutoEventToMedication`
 * returns `{ ok: false, reason: 'invalid_dose_schedule' }`.
 *
 * `doseSchedule` is now the SOLE source of dose identity / amount / time for
 * Exact Auto. There is no migration and no backward compatibility:
 *   - no `LEGACY_DOSE_ID` sentinel,
 *   - no `dailyDose` / `reminderTime` / `reminderEnabled` / `lastConsumedDate`
 *     fallback,
 *   - no first-dose / next-dose / array-index fallback,
 *   - no empty/sentinel doseId.
 *
 * What remains valid and unchanged: explicit multi-dose / single-slot
 * schedules (a Medication with `doseSchedule: [{ id, amount, time }]`) drive
 * Exact Auto normally, and `event.amount` is the authoritative charge.
 */
import { describe, it, expect } from 'vitest';
import type { Medication } from '../../src/types';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNative';
import {
  computeDueDoseBreakdown,
  syncAutoDailyDeductions,
  effectiveCurrentPills,
} from '../../src/utils/dateCalculations';
import {
  reconcileFiredEvents,
  exactAutoLogId,
  applyExactAutoEventToMedication,
  isExactDoseScheduleMember,
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

/** Exact FIRED event for a no-schedule med — the pre-PR legacy shape. */
function legacyFiredEvent(amount: number): AutoDeductionEvent {
  return {
    medicationId: 'med-1',
    // Empty doseId: the pre-PR LEGACY_DOSE_ID shape. Under the new contract
    // this is a malformed identity → terminal ACK at the runner level (no
    // stock, no log) before ever reaching applyExactAutoEventToMedication.
    doseId: '',
    calendarDate: TODAY,
    amount,
    status: 'FIRED',
    scheduledAtEpochMs: 1,
    createdAtEpochMs: 1,
    reconciledAtEpochMs: null,
  };
}

describe('legacy single-dose (no doseSchedule): Exact path is removed (#268 / PR #271)', () => {
  it('applyExactAutoEventToMedication: no doseSchedule → ok:false invalid_dose_schedule, no deduction', () => {
    const med = legacyMed();
    const e = legacyFiredEvent(2);
    const applied = applyExactAutoEventToMedication(med, e, NOW);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.reason).toBe('invalid_dose_schedule');
    }
  });

  it('applyExactAutoEventToMedication: empty doseSchedule array → ok:false invalid_dose_schedule', () => {
    const med = legacyMed({ doseSchedule: [] });
    const e = { ...legacyFiredEvent(2), doseId: 'any-id' };
    const applied = applyExactAutoEventToMedication(med, e, NOW);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.reason).toBe('invalid_dose_schedule');
    }
  });

  it('applyExactAutoEventToMedication: schedule present but doseId not a member → ok:false invalid_dose_schedule', () => {
    const med = legacyMed({
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    });
    const e = { ...legacyFiredEvent(2), doseId: 'd2' };
    const applied = applyExactAutoEventToMedication(med, e, NOW);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.reason).toBe('invalid_dose_schedule');
    }
  });

  it('isExactDoseScheduleMember: false for no/empty schedule, false for non-member, true for member', () => {
    const noSchedule = legacyMed();
    expect(isExactDoseScheduleMember(noSchedule, 'd1')).toBe(false);
    expect(isExactDoseScheduleMember(noSchedule, '')).toBe(false);

    const empty = legacyMed({ doseSchedule: [] });
    expect(isExactDoseScheduleMember(empty, 'd1')).toBe(false);

    const scheduled = legacyMed({
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    });
    expect(isExactDoseScheduleMember(scheduled, 'd1')).toBe(true);
    expect(isExactDoseScheduleMember(scheduled, 'd2')).toBe(false);
    expect(isExactDoseScheduleMember(scheduled, '')).toBe(false);
  });

  it('reconcileFiredEvents: no doseSchedule + empty doseId → skipped_invalid, no stock, no log (terminal ACK)', () => {
    const med = legacyMed();
    const r = reconcileFiredEvents([med], [], [legacyFiredEvent(2)], {
      now: NOW,
    });
    expect(r.details[0].outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: '', calendarDate: TODAY },
    ]);
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.logs).toEqual([]);
    // lastConsumedDate untouched (no legacy doseId-only write)
    expect(r.medications[0].lastConsumedDate).toBeUndefined();
  });

  it('reconcileFiredEvents: no doseSchedule + non-empty doseId → skipped_invalid (no ACK), stock/log unchanged, retryable', () => {
    // Identity is well-formed (med + non-empty doseId + valid date + positive
    // amount), but the med has no schedule so the occurrence cannot apply.
    // This is NOT terminal — the event may become applicable after the med
    // is edited to add a matching schedule, so it stays unreconciled.
    const med = legacyMed({ currentPills: 10 });
    const e: AutoDeductionEvent = {
      ...legacyFiredEvent(2),
      doseId: 'some-id',
    };
    const r = reconcileFiredEvents([med], [], [e], { now: NOW });
    expect(r.details[0].outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([]);
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it('reconcileFiredEvents: legacy sync after a no-op Exact still settles the window (no double-charge because Exact charged 0)', () => {
    // The pre-PR double-deduction bug (Exact −2 then legacy −1 for the same
    // day → 7) is structurally impossible now: Exact charges nothing for a
    // no-schedule med, so legacy sync is the only deduction. 10 − 1 = 9.
    const med = legacyMed();
    const r = reconcileFiredEvents([med], [], [legacyFiredEvent(2)], {
      now: NOW,
    });
    const afterExact = r.medications[0];
    expect(afterExact.currentPills).toBe(10);

    const synced = syncAutoDailyDeductions([afterExact], TODAY, NOW);
    // One day settled at dailyDose 1 → 9 (the only deduction; no Exact
    // charge preceded it).
    expect(synced.updatedMeds[0].currentPills).toBe(9);
    expect(synced.newLogs).toHaveLength(1);
    expect(synced.newLogs[0].amount).toBe(-1);
  });

  it('effectiveCurrentPills: no-schedule med after a no-op Exact reflects only the legacy projection (10 − 1 = 9)', () => {
    const med = legacyMed();
    const r = reconcileFiredEvents([med], [], [legacyFiredEvent(2)], {
      now: NOW,
    });
    expect(effectiveCurrentPills(r.medications[0], TODAY, NOW)).toBe(9);
  });

  it('no Exact log id is ever built with an empty doseId for a no-schedule med', () => {
    // exactAutoLogId with an empty doseId is the historical legacy shape.
    // The runner never calls it for a no-schedule med because the apply
    // gate rejects before any log construction.
    const med = legacyMed();
    const r = reconcileFiredEvents([med], [], [legacyFiredEvent(2)], {
      now: NOW,
    });
    const legacyLogId = exactAutoLogId('med-1', '', TODAY);
    expect(r.logs.find((l) => l.id === legacyLogId)).toBeUndefined();
  });
});

/**
 * Explicit-schedule semantics are unchanged and remain authoritative.
 */
describe('explicit doseSchedule: Exact Auto unchanged after legacy removal', () => {
  it('multi-dose semantics unchanged: slot-level timing still drives fullDueUnits', () => {
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

  it('schedule amount 1 and exact amount 2 → final stock 8 (authoritative event.amount)', () => {
    const multiMed: Medication = {
      ...legacyMed(),
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      lastSyncDate: '2026-09-13',
    };
    const event: AutoDeductionEvent = {
      ...legacyFiredEvent(2),
      doseId: 'd1',
    };
    const r = reconcileFiredEvents([multiMed], [], [event], { now: NOW });
    expect(r.medications[0].currentPills).toBe(8);
    expect(r.newExactLogs[0].amount).toBe(-2);
    expect(r.newExactLogs[0].id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
  });
});
