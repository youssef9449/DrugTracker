import { requireDefined } from '../helpers/requireDefined';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import { makeMedication as baseMed, makeAutoDeductionEvent as fired } from '../fixtures/testFixtures';
import { exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';

import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';




describe('BLOCKER 2 — partial native acknowledgement', () => {

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('partialNativeAcknowledgementIsRecoverable', async () => {
    const med = baseMed({
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 2, time: '14:00' },
      ],
      currentPills: 10,
    });
    const events = [
      fired({
        medicationId: 'med-1',
        doseId: 'a',
        calendarDate: '2026-09-14',
        amount: 1,
        scheduledAtEpochMs: 1,
      }),
      fired({
        medicationId: 'med-1',
        doseId: 'b',
        calendarDate: '2026-09-14',
        amount: 2,
        scheduledAtEpochMs: 2,
      }),
    ];
    let medsStore: Medication[] = [med];
    let logsStore: ConsumptionLog[] = [];
    let envelope: unknown = null;
    const marked = new Set<string>();
    let failB = true;

    const first = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: events }),
      markReconciled: async (_medicationId, doseId, _calendarDate) => {
        const k = `${doseId}`;
        if (k === 'b' && failB) return { ok: false, changed: false };
        marked.add(k);
        return { ok: true, changed: true };
      },
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => envelope as never,
      saveEnvelope: (env) => {
        envelope = env;
        return null;
      },
    });
    expect(requireDefined(first.medications[0], 'first.medications[0]').currentPills).toBe(7);
    expect(first.partialNativeAck).toBe(true);
    expect(marked.has('a')).toBe(true);
    // Envelope cleared under Option B after JS commit
    expect(envelope).toBeNull();

    // Restart: B still FIRED; JS markers prevent second deduct
    failB = false;
    const stillFired = events.filter((e) => !marked.has(e.doseId));
    const second = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: stillFired }),
      markReconciled: async (_m, doseId) => {
        marked.add(doseId);
        return { ok: true, changed: true };
      },
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });
    expect(second.details.every((d) => d.outcome === 'already_applied')).toBe(true);
    expect(requireDefined(second.medications[0], 'second.medications[0]').currentPills).toBe(7);
    expect(logsStore.filter((l) => l.id.startsWith('exact-auto:')).length).toBe(2);
    expect(marked.has('b')).toBe(true);
  });

  it('markFailureDoesNotCauseSecondDeduction', async () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let medsStore = [med];
    let logsStore: ConsumptionLog[] = [];
    await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [e] }),
      markReconciled: async () => {
        return { ok: false, changed: false };
      },
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });
    expect(requireDefined(medsStore[0], 'medsStore[0]').currentPills).toBe(8);
    const retry = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [e] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });
    expect(requireDefined(retry.details[0], 'retry.details[0]').outcome).toBe('already_applied');
    expect(requireDefined(retry.medications[0], 'retry.medications[0]').currentPills).toBe(8);
    expect(logsStore.filter((l) => l.id === exactAutoLogId('med-1', 'd', '2026-09-14')).length).toBe(
      1
    );
  });

  it('resolvedPromiseWithOkFalseIsAcknowledgementFailure', async () => {
    // Resolved Promise + ok=false must be treated as failure (not throw).
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let medsStore = [med];
    let logsStore: ConsumptionLog[] = [];
    let markCalls = 0;

    const first = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [e] }),
      markReconciled: async () => {
        markCalls += 1;
        return { ok: false, changed: false };
      },
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(requireDefined(first.medications[0], 'first.medications[0]').currentPills).toBe(8);
    expect(first.partialNativeAck).toBe(true);
    expect(first.markedCount).toBe(0);
    expect(logsStore.filter((l) => l.id === exactAutoLogId('med-1', 'd', '2026-09-14')).length).toBe(
      1
    );
    expect(markCalls).toBe(1);

    // Retry: markers prove already applied; no second stock/log; ack succeeds
    const second = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [e] }),
      markReconciled: async () => {
        markCalls += 1;
        return { ok: true, changed: true };
      },
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(requireDefined(second.details[0], 'second.details[0]').outcome).toBe('already_applied');
    expect(requireDefined(second.medications[0], 'second.medications[0]').currentPills).toBe(8);
    expect(second.partialNativeAck).toBe(false);
    expect(second.markedCount).toBe(1);
    expect(logsStore.filter((l) => l.id === exactAutoLogId('med-1', 'd', '2026-09-14')).length).toBe(
      1
    );
    expect(markCalls).toBe(2);
  });

  it('alreadyReconciledOkTrueChangedFalseIsSuccessfulTerminalAck', async () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let medsStore = [med];
    let logsStore: ConsumptionLog[] = [];

    const result = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [e] }),
      markReconciled: async () => ({ ok: true, changed: false }),
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(requireDefined(result.medications[0], 'result.medications[0]').currentPills).toBe(8);
    expect(result.partialNativeAck).toBe(false);
    expect(result.markedCount).toBe(1);
    expect(logsStore.filter((l) => l.id === exactAutoLogId('med-1', 'd', '2026-09-14')).length).toBe(
      1
    );
  });

  it('envelopePersistenceFailureDoesNotSetPartialNativeAck', async () => {
    // Envelope present + JS recovery persist fails → recoveredEnvelope true,
    // but no markReconciled attempt occurred, so partialNativeAck must be false.
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 8,
    });
    const envelope = {
      version: 1 as const,
      status: 'js_ready' as const,
      medications: [med],
      logs: [],
      toAcknowledge: [
        { medicationId: 'med-1', doseId: 'd', calendarDate: '2026-09-14' },
      ],
      createdAt: '2026-09-14T12:00:00.000Z',
      mutationSeq: 1,
      globalAutoDeductEnabled: true,
    };
    let markCalls = 0;

    const result = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [baseMed({ currentPills: 10})],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async () => {
        markCalls += 1;
        return { ok: true, changed: true };
      },
      persistMeds: () => 'persist_failed',
      persistLogs: () => null,
      loadEnvelope: () => envelope as never,
      saveEnvelope: () => null,
    });

    expect(result.recoveredEnvelope).toBe(true);
    expect(result.partialNativeAck).toBe(false);
    expect(result.markedCount).toBe(0);
    expect(markCalls).toBe(0);
  });
});
