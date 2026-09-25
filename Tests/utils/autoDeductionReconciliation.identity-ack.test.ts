import { requireDefined } from '../helpers/requireDefined';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMedication as baseMed, makeAutoDeductionEvent as fired } from '../fixtures/testFixtures';
import { reconcileFiredEvents } from '../../src/utils/autoDeductionReconciliation';

import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNativeTypes';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';





describe('reconcileFiredEvents — malformed identity is terminal ACK (#262 Finding 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('missing medicationId: no stock/log, skipped_invalid, ACK terminal', () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: '',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(requireDefined(r.details[0], 'r.details[0]').outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([
      { medicationId: '', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
    expect(r.mutated).toBe(false);
    expect(requireDefined(r.medications[0], 'r.medications[0]').currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it('missing calendarDate: no stock/log, skipped_invalid, ACK terminal', () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '',
      amount: 2,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(requireDefined(r.details[0], 'r.details[0]').outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '' },
    ]);
    expect(r.mutated).toBe(false);
    expect(requireDefined(r.medications[0], 'r.medications[0]').currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
  });

  it('malformed calendarDate (not YYYY-MM-DD): terminal ACK, no stock/log', () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: 'bad-date',
      amount: 2,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(requireDefined(r.details[0], 'r.details[0]').outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: 'bad-date' },
    ]);
    expect(r.mutated).toBe(false);
    expect(requireDefined(r.medications[0], 'r.medications[0]').currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it('second reconciliation of same malformed event does not mutate stock or add logs', () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: 'bad-date',
      amount: 2,
    });
    const r1 = reconcileFiredEvents([med], [], [e]);
    expect(r1.toAcknowledge).toHaveLength(1);
    expect(requireDefined(r1.medications[0], 'r1.medications[0]').currentPills).toBe(10);

    // Simulate native still listing the same malformed payload before ACK lands
    const r2 = reconcileFiredEvents(r1.medications, r1.logs, [e]);
    expect(requireDefined(r2.details[0], 'r2.details[0]').outcome).toBe('skipped_invalid');
    expect(r2.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: 'bad-date' },
    ]);
    expect(r2.mutated).toBe(false);
    expect(requireDefined(r2.medications[0], 'r2.medications[0]').currentPills).toBe(10);
    expect(r2.newExactLogs).toEqual([]);
    expect(r2.logs).toEqual([]);
  });

  it('malformed identity terminal ACK does not block a distinct valid occurrence', () => {
    // Fixing calendarDate changes occurrence identity — not same-occurrence retry.
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const invalid = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: 'bad-date',
      amount: 2,
    });
    const r1 = reconcileFiredEvents([med], [], [invalid]);
    expect(r1.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: 'bad-date' },
    ]);
    expect(requireDefined(r1.medications[0], 'r1.medications[0]').currentPills).toBe(10);

    const valid = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const r2 = reconcileFiredEvents(r1.medications, r1.logs, [valid]);
    expect(requireDefined(r2.details[0], 'r2.details[0]').outcome).toBe('applied');
    expect(r2.mutated).toBe(true);
    expect(requireDefined(r2.medications[0], 'r2.medications[0]').currentPills).toBe(8);
    expect(r2.newExactLogs).toHaveLength(1);
    expect(requireDefined(r2.newExactLogs[0], 'r2.newExactLogs[0]').amount).toBe(-2);
    expect(r2.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
  });
});

describe('runAutoDeductionReconciliation — malformed identity terminal native ACK (#262 F3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('malformed FIRED reaches markReconciled once; stock/log unchanged; no second ACK after terminal', async () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    // Malformed identity (invalid calendarDate) with positive amount
    const malformed: AutoDeductionEvent = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: 'bad-date',
      amount: 2,
    });

    // Simulated native FIRED store: present until markReconciled succeeds
    let nativeFired: AutoDeductionEvent[] = [malformed];
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
        // Terminal native ACK: drop from unreconciled FIRED set
        nativeFired = nativeFired.filter(
          (e) =>
            !(
              e.medicationId === medicationId &&
              e.doseId === doseId &&
              e.calendarDate === calendarDate
            )
        );
        return { ok: true, changed: true };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(first.details[0]?.outcome).toBe('skipped_invalid');
    expect(first.mutated).toBe(false);
    expect(requireDefined(first.medications[0], 'first.medications[0]').currentPills).toBe(10);
    expect(first.newExactLogs).toEqual([]);
    expect(first.logs).toEqual([]);
    expect(first.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: 'bad-date' },
    ]);
    // Existing ACK path (markAll → markReconciled) invoked once
    expect(markCalls).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: 'bad-date' },
    ]);
    expect(first.markedCount).toBe(1);
    expect(nativeFired).toEqual([]);

    // Second run: event no longer listed → no re-ACK, no mutation
    const second = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: first.medications,
      logs: first.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
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
    expect(requireDefined(second.medications[0], 'second.medications[0]').currentPills).toBe(10);
    expect(second.newExactLogs).toEqual([]);
    expect(second.toAcknowledge).toEqual([]);
    expect(second.markedCount).toBe(0);
    expect(markCalls).toHaveLength(1);
  });

  it('valid identity + invalid amount does not call markReconciled (remains retryable)', async () => {
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
    expect(requireDefined(r.medications[0], 'r.medications[0]').currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.toAcknowledge).toEqual([]);
    expect(r.markedCount).toBe(0);
    expect(markCalls).toEqual([]);
    // Still unreconciled FIRED in native mock
    expect(nativeFired).toHaveLength(1);
  });

  it('empty doseId FIRED: runner path terminal ACK via markAll; no stock/log/marker (#268)', async () => {
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const emptyDose: AutoDeductionEvent = fired({
      medicationId: 'med-1',
      doseId: '',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let nativeFired: AutoDeductionEvent[] = [emptyDose];
    const markCalls: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }> = [];

    // Production native ACK contract for malformed identity (mirrors
    // AutoDeductionEventStore.markReconciled in EventStoreMarkReconciledGuardTest):
    // the corrupt FIRED row is terminalized to REJECTED (NOT acknowledged as
    // RECONCILED). The native returns ok:true (handled, no retry needed) and
    // changed:false (nothing was RECONCILED). The JS runner's markAll treats
    // ok:true as a successful terminal ack regardless of `changed`.
    const first = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        // Terminal native ACK: drop the corrupt row from the FIRED set.
        nativeFired = nativeFired.filter(
          (e) =>
            !(
              e.medicationId === medicationId &&
              String(e.doseId ?? '') === doseId &&
              e.calendarDate === calendarDate
            )
        );
        // Native terminalization to REJECTED → ok:true, changed:false.
        return { ok: true, changed: false };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(first.details[0]?.outcome).toBe('skipped_invalid');
    expect(first.mutated).toBe(false);
    expect(requireDefined(first.medications[0], 'first.medications[0]').currentPills).toBe(10);
    expect(requireDefined(first.medications[0], 'first.medications[0]').lastConsumedDate).toBe('2026-09-12');
    expect(first.newExactLogs).toEqual([]);
    expect(first.logs).toEqual([]);
    expect(first.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: '', calendarDate: '2026-09-14' },
    ]);
    // Production ACK path: markAll → markReconciled invoked exactly once.
    expect(markCalls).toEqual([
      { medicationId: 'med-1', doseId: '', calendarDate: '2026-09-14' },
    ]);
    expect(first.markedCount).toBe(1);
    // The corrupt row is gone from the FIRED set → no infinite retry.
    expect(nativeFired).toEqual([]);

    // Second pass: the corrupt row is no longer listed → no re-processing,
    // no re-ACK, no mutation. Terminal: never re-applied in a later pass.
    const second = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: first.medications,
      logs: first.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
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
    expect(requireDefined(second.medications[0], 'second.medications[0]').currentPills).toBe(10);
    expect(second.newExactLogs).toEqual([]);
    expect(second.toAcknowledge).toEqual([]);
    expect(second.markedCount).toBe(0);
    // markReconciled was called at most once (only the first pass).
    expect(markCalls).toHaveLength(1);
  });

  it('missing doseId FIRED: runner path terminal ACK via markAll; no stock/log/marker (#268)', async () => {
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const missingDose: AutoDeductionEvent = fired({
      medicationId: 'med-1',
      doseId: undefined as unknown as string,
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let nativeFired: AutoDeductionEvent[] = [missingDose];
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
          (e) =>
            !(
              e.medicationId === medicationId &&
              String(e.doseId ?? '') === doseId &&
              e.calendarDate === calendarDate
            )
        );
        // Native terminalization to REJECTED → ok:true, changed:false.
        return { ok: true, changed: false };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(first.details[0]?.outcome).toBe('skipped_invalid');
    expect(first.mutated).toBe(false);
    expect(requireDefined(first.medications[0], 'first.medications[0]').currentPills).toBe(10);
    expect(requireDefined(first.medications[0], 'first.medications[0]').lastConsumedDate).toBe('2026-09-12');
    expect(first.newExactLogs).toEqual([]);
    expect(first.logs).toEqual([]);
    expect(first.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: '', calendarDate: '2026-09-14' },
    ]);
    expect(markCalls).toEqual([
      { medicationId: 'med-1', doseId: '', calendarDate: '2026-09-14' },
    ]);
    expect(first.markedCount).toBe(1);
    // Terminal: the corrupt row is gone → no infinite retry.
    expect(nativeFired).toEqual([]);
  });

  it('native markReconciled web contract: empty doseId returns ok:false (not a valid occurrence)', async () => {
    // Direct contract assertion for the JS-level guard in
    // markAutoDeductionEventReconciled (autoDeductionNativeEvents.ts): on a non-Android
    // platform it refuses to bless an empty doseId as a valid occurrence. The
    // native Android path terminalizes the corrupt row to REJECTED instead
    // (covered by EventStoreMarkReconciledGuardTest). This guard is what
    // prevents JS from passing an empty doseId to native markReconciled as a
    // valid occurrence on web.
    const { markAutoDeductionEventReconciled } = await import(
      '../../src/utils/autoDeductionNativeEvents'
    );
    const r = await markAutoDeductionEventReconciled('med-1', '', '2026-09-14');
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(false);
  });
});
