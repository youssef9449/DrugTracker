
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { makeMedication as baseMed, makeAutoDeductionEvent as fired } from '../fixtures/testFixtures';
import { exactAutoLogId, applyExactAutoEventToMedication } from '../../src/utils/autoDeductionReconciliation';

import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNativeTypes';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';




describe('runAutoDeductionReconciliation — FIRED durable regardless of current schedule (#268 / PR #271)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('no doseSchedule + valid non-empty doseId: FIRED applies with event.amount; ACK terminal (no retry)', async () => {
    // The med has no schedule at all, but a FIRED event with a well-formed
    // identity (non-empty doseId + valid date + positive amount) is durable
    // and MUST be reconciled via event.amount. amount is event.amount (not
    // dailyDose — no Legacy Single-Dose fallback). The occurrence is ACKed
    // once and dropped from the native FIRED set (terminal, no infinite retry).
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: undefined,
      dailyDose: 5,
    });
    const e: AutoDeductionEvent = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let nativeFired: AutoDeductionEvent[] = [e];
    const markCalls: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }> = [];

    const r = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        nativeFired = nativeFired.filter(
          (ev) =>
            !(
              ev.medicationId === medicationId &&
              String(ev.doseId ?? '') === doseId &&
              ev.calendarDate === calendarDate
            )
        );
        return { ok: true, changed: true };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(r.details[0]?.outcome).toBe('applied');
    expect(r.mutated).toBe(true);
    // event.amount (2) applied, NOT dailyDose (5).
    expect(r.medications[0].currentPills).toBe(8);
    // No schedule → no lastConsumedDate write.
    expect(r.medications[0].lastConsumedDate).toBe('2026-09-12');
    expect(r.newExactLogs).toHaveLength(1);
    expect(r.newExactLogs[0].amount).toBe(-2);
    expect(r.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
    expect(r.markedCount).toBe(1);
    expect(markCalls).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
    // Terminal: the row is gone from the FIRED set → no infinite retry.
    expect(nativeFired).toEqual([]);
  });

  it('doseId removed from current schedule after fire: FIRED applies with event.amount; ACK once, no duplicate on retry', async () => {
    // Scenario from Finding 1: med was scheduled with d1 (amount 2). Native
    // created FIRED med-1+d1+2026-09-14+amount=2. User then removed d1 from
    // current doseSchedule. Reconciliation applies event.amount=2 once;
    // a second pass re-lists the same FIRED (before ACK lands) but finds the
    // durable consume marker / exact log → already_applied, no duplicate.
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      // Current schedule no longer contains d1.
      doseSchedule: [{ id: 'd2', amount: 1, time: '20:00' }],
    });
    const e: AutoDeductionEvent = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let nativeFired: AutoDeductionEvent[] = [e];
    const markCalls: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }> = [];

    const first = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        nativeFired = nativeFired.filter(
          (ev) =>
            !(
              ev.medicationId === medicationId &&
              String(ev.doseId ?? '') === doseId &&
              ev.calendarDate === calendarDate
            )
        );
        return { ok: true, changed: true };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(first.details[0]?.outcome).toBe('applied');
    expect(first.mutated).toBe(true);
    expect(first.medications[0].currentPills).toBe(8);
    expect(first.newExactLogs).toHaveLength(1);
    expect(first.newExactLogs[0].amount).toBe(-2);
    expect(first.newExactLogs[0].id).toBe(exactAutoLogId('med-1', 'd1', '2026-09-14'));
    expect(first.newExactLogs[0].type).toBe('exact_auto');
    // Returned `logs` is the COMPLETE new durable logs array — it includes the
    // newly applied exact_auto log (newExactLogs is the sub-set of logs the
    // run created, not a separate carry-through collection).
    expect(first.logs.filter((l) => l.type === 'exact_auto')).toHaveLength(1);
    expect(first.logs[0].id).toBe(exactAutoLogId('med-1', 'd1', '2026-09-14'));
    expect(first.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
    expect(first.markedCount).toBe(1);
    expect(nativeFired).toEqual([]);

    // Second pass: simulate the native still listing the same FIRED before
    // the ACK landed (or a retry). The durable exact log + consume marker
    // make it already_applied → no duplicate deduction, no duplicate log.
    const sameFired: AutoDeductionEvent[] = [e];
    const second = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: first.medications,
      logs: first.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: sameFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        return { ok: true, changed: false };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(second.mutated).toBe(false);
    // Stock unchanged (no second deduction).
    expect(second.medications[0].currentPills).toBe(8);
    expect(second.newExactLogs).toEqual([]);
    // The single durable exact log remains (no duplicate).
    expect(second.logs.filter((l) => l.id === exactAutoLogId('med-1', 'd1', '2026-09-14'))).toHaveLength(1);
    expect(second.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
  });

  it('valid identity + invalid amount: no ACK, retryable (unchanged)', async () => {
    // Invalid amount with a well-formed identity stays retryable (no ACK).
    // This contract is unchanged by the schedule-durability fix.
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const invalidAmount = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 0,
    });
    const nativeFired: AutoDeductionEvent[] = [invalidAmount];
    const markCalls: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }> = [];

    const r = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        return { ok: true, changed: true };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(r.details[0]?.outcome).toBe('skipped_invalid');
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.toAcknowledge).toEqual([]);
    expect(r.markedCount).toBe(0);
    expect(markCalls).toEqual([]);
    // Retryable: still listed in the native FIRED set.
    expect(nativeFired).toHaveLength(1);
  });
});

describe('applyExactAutoEventToMedication — FIRED occurrence is durable; event.amount is authoritative (#268 / PR #271)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('nativeStockApplied_doesNotSubtractCurrentPillsAgain_butRecordsActualCharge', () => {
    const med = baseMed({
      currentPills: 8,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
      nativeStockApplied: true,
      actualDeducted: 2,
    });

    const applied = applyExactAutoEventToMedication(med, e, [], new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // Native has already moved 10 -> 8; JS must not perform 8 -> 6.
      expect(applied.updatedMed.currentPills).toBe(8);
      expect(applied.updatedMed.doseConsumptionHistory?.d1).toEqual(['2026-09-14']);
      expect(applied.log.amount).toBe(-2);
    }
  });

  it('with explicit doseSchedule: Exact applies; lastConsumedDate updates only when all slots consumed', () => {
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '20:00' },
      ],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const applied = applyExactAutoEventToMedication(med, e, [], new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // Only one of two slots consumed → lastConsumedDate unchanged
      expect(applied.updatedMed.lastConsumedDate).toBe('2026-09-12');
      expect(applied.updatedMed.currentPills).toBe(9);
      expect(applied.log.id).toBe(exactAutoLogId('med-1', 'd1', '2026-09-14'));
      expect(applied.log.type).toBe('exact_auto');
      expect(applied.log.doseId).toBe('d1');
    }
  });

  it('doseId removed from current doseSchedule AFTER fire: FIRED event still applies with event.amount (#268 / PR #271)', () => {
    // Scenario from Finding 1: the med was scheduled with d1 (amount 2). The
    // native created a FIRED event med-1+d1+2026-09-20+amount=2. The user then
    // removed d1 from the current doseSchedule. Reconciliation MUST still
    // apply event.amount=2 (the FIRED occurrence already happened). No
    // Legacy Single-Dose fallback: amount is event.amount, NOT dailyDose.
    // lastConsumedDate is NOT written (no schedule to test all-consumed).
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      // Current schedule no longer contains d1 — it was removed after fire.
      doseSchedule: [{ id: 'd2', amount: 1, time: '20:00' }],
      dailyDose: 1,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const applied = applyExactAutoEventToMedication(med, e, [], new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // event.amount (2) is authoritative, NOT dailyDose (1).
      expect(applied.updatedMed.currentPills).toBe(8);
      // No schedule contains d1 → no all-consumed write → lastConsumedDate
      // unchanged. There is NO Legacy Single-Dose doseId-only write.
      expect(applied.updatedMed.lastConsumedDate).toBe('2026-09-12');
      // Exact log is created once with the full identity.
      expect(applied.log.id).toBe(exactAutoLogId('med-1', 'd1', '2026-09-14'));
      expect(applied.log.type).toBe('exact_auto');
      expect(applied.log.doseId).toBe('d1');
      expect(applied.log.amount).toBe(-2);
    }
  });

  it('no doseSchedule at all: FIRED event still applies with event.amount (no Legacy Single-Dose fallback)', () => {
    // The med never had a schedule. A FIRED event with a well-formed identity
    // (non-empty doseId + valid date + positive amount) is durable and must be
    // reconciled via event.amount. There is NO Legacy Single-Dose fallback:
    // amount is event.amount (2), NOT dailyDose. lastConsumedDate is NOT
    // written (no schedule to test all-consumed → no doseId-only write).
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      // no doseSchedule — would be the pre-PR legacy single-dose shape
      doseSchedule: undefined,
      dailyDose: 2,
      reminderTime: '08:00',
      reminderEnabled: true,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'some-id',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const applied = applyExactAutoEventToMedication(med, e, [], new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // event.amount (2) authoritative, NOT dailyDose (2 here, but the point
      // is that dailyDose is never the source — see the next assertion's logic).
      expect(applied.updatedMed.currentPills).toBe(8);
      // No schedule → no all-consumed → lastConsumedDate unchanged
      // (no Legacy Single-Dose doseId-only write).
      expect(applied.updatedMed.lastConsumedDate).toBe('2026-09-12');
      expect(applied.log.doseId).toBe('some-id');
      expect(applied.log.id).toBe(exactAutoLogId('med-1', 'some-id', '2026-09-14'));
      expect(applied.log.amount).toBe(-2);
    }
  });

  it('no doseSchedule + event.amount differs from dailyDose: amount is event.amount, NOT dailyDose', () => {
    // Proves there is no Legacy Single-Dose fallback to dailyDose for amount.
    // dailyDose = 5 but the FIRED event carries amount = 2 → stock drops by 2.
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: undefined,
      dailyDose: 5,
      reminderTime: '08:00',
      reminderEnabled: true,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'x',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const applied = applyExactAutoEventToMedication(med, e, [], new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // 10 − event.amount(2) = 8, NOT 10 − dailyDose(5) = 5.
      expect(applied.updatedMed.currentPills).toBe(8);
      expect(applied.log.amount).toBe(-2);
    }
  });

  it('empty doseSchedule array: FIRED event still applies with event.amount', () => {
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: [],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'orphan',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const applied = applyExactAutoEventToMedication(med, e, [], new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.updatedMed.currentPills).toBe(9);
      expect(applied.updatedMed.lastConsumedDate).toBe('2026-09-12');
      expect(applied.log.amount).toBe(-1);
    }
  });

  it('empty doseId: ok:false invalid_dose_id (malformed identity — not applied)', () => {
    // Empty doseId is the ONLY identity failure that blocks a FIRED occurrence
    // from applying. It is a malformed identity (terminal at the runner level).
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: '',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const applied = applyExactAutoEventToMedication(med, e, [], new Date());
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.reason).toBe('invalid_dose_id');
    }
    expect(med.currentPills).toBe(10);
  });

  it('valid doseId member with multi-slot schedule + all consumed → lastConsumedDate set', () => {
    // Same explicit schedule as the first test, but pre-mark the other slot
    // consumed so this Exact apply completes the day → lastConsumedDate moves.
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '20:00' },
      ],
      doseConsumptionHistory: { d2: ['2026-09-14'] },
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const applied = applyExactAutoEventToMedication(med, e, [], new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.updatedMed.lastConsumedDate).toBe('2026-09-14');
      expect(applied.updatedMed.currentPills).toBe(9);
    }
  });

  it('current schedule amount differs from event.amount → deduction is event.amount, NOT the schedule amount (#265)', () => {
    // The current doseSchedule says d1 amount=3, but the FIRED event carries
    // amount=1. The deduction is event.amount (1), NOT the current schedule
    // amount (3). event.amount is the authoritative charge for a FIRED
    // occurrence; the current schedule is only for scheduling FUTURE ones.
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: [{ id: 'd1', amount: 3, time: '08:00' }],
      dailyDose: 3,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const applied = applyExactAutoEventToMedication(med, e, [], new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // 10 − event.amount(1) = 9, NOT 10 − schedule amount(3) = 7.
      expect(applied.updatedMed.currentPills).toBe(9);
      expect(applied.log.amount).toBe(-1);
    }
  });

  it('past FIRED occurrence adds no historical sibling/day deductions (#265)', () => {
    // A single FIRED event on a past calendar day deducts ONLY its own
    // event.amount. No historical / sibling-day settlement is folded into
    // the apply — other elapsed days (e.g. between lastSync and the event
    // lastSync=09-10, event=09-13 amount 2 → 10 − 2 = 8. Days 09-11/09-12
    // are NOT charged here (they stay a live projection until a mutation or
    // their own FIRED occurrences settle them).
    const med = baseMed({
      doseSchedule: [
        { id: 'd1', amount: 2, time: '08:00' },
        { id: 'd2', amount: 2, time: '20:00' },
      ],
      currentPills: 10,
      lastConsumedDate: '2026-09-09',
      dailyDose: 4,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-13',
      amount: 2,
    });
    const applied = applyExactAutoEventToMedication(med, e, [], new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // Only the FIRED occurrence's amount (2). No sibling d2, no days
      // 09-11/09-12, no dailyDose(4)-based catch-up.
      expect(applied.updatedMed.currentPills).toBe(8);
      // Only one exact log (this occurrence).
      expect(applied.log.amount).toBe(-2);
      expect(applied.log.doseId).toBe('d1');
    }
  });

  it('old elapsed-day settlement does not increase the Exact deduction (#265)', () => {
    // deduction amount.
    const recent = baseMed({
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
      currentPills: 10,
      dailyDose: 2,
    });
    const old = baseMed({
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
      currentPills: 10,
      dailyDose: 2,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const r1 = applyExactAutoEventToMedication(recent, e, [], new Date());
    const r2 = applyExactAutoEventToMedication(old, e, [], new Date());
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.updatedMed.currentPills).toBe(8);
      expect(r2.updatedMed.currentPills).toBe(8);
    }
  });
});
