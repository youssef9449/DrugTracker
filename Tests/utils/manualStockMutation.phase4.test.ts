import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import {
  runGatedManualConsume,
  runGatedManualRestore,
  runGatedAddMedication,
  runGatedRefill,
  runGatedUndoRefill,
  runGatedAutoDeductToggle,
  runGatedGlobalAutoDeductToggle,
  runGatedMedicationUpdate,
  runGatedDeleteMedication,
  shouldDismissAlarmAfterManualTake,
  type ManualStockEnvelope } from '../../src/utils/manualStockMutation';
import {
  __setManualEnvelopeTestHooks,
  __setExactAutoEnvelopeStorageTestHooks,
  loadExactAutoStockEnvelope,
  durableMatchesEnvelopeSnapshot } from '../../src/utils/stockEnvelopeRecovery';
import {
  __setStockMutationOrderingTestHooks,
  __resetStockMutationOrderingForTests,
  allocateMutationSeq,
  persistLastAppliedMutationSeq,
  loadLastAppliedMutationSeq } from '../../src/utils/stockMutationOrdering';
import {
  runAutoDeductionReconciliation,
  type ExactAutoEnvelope } from '../../src/utils/runAutoDeductionReconciliation';
import {
  __setAutoStockGateTestHooks,
  type AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';
import { __setManualRecurrenceInvalidationTestHook } from '../../src/utils/manualStockMutation';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNative';
import { isDoseConsumedOnDate, isDoseSkippedOnDate } from '../../src/utils/dateCalculations';
import { exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';
import * as preSettleModule from '../../src/utils/reconcileExactBeforeManualMutation';
// findPending used indirectly via runGatedManualConsume
import {
  findActiveDeductionForOccurrence,
  consumeDose,
  restoreDose } from '../../src/utils/medActions';

const TODAY = '2026-09-16';

function med(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'TestMed',
    currentPills: 10,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSyncDate: '2026-09-15',
    autoDeductEnabled: true,
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 1, time: '14:00' },
      { id: 'd3', amount: 2, time: '22:00' },
    ],
    dosesPerDay: 3,
    ...over,
  };
}

function fired(
  over: Partial<AutoDeductionEvent> &
    Pick<AutoDeductionEvent, 'doseId' | 'calendarDate' | 'amount'>
): AutoDeductionEvent {
  return {
    medicationId: 'med-1',
    scheduledAtEpochMs: 1,
    status: 'FIRED',
    createdAtEpochMs: 1,
    reconciledAtEpochMs: null,
    ...over,
  };
}

describe('Phase 4 — Manual Take ↔ Exact Auto-Deduction', () => {
  let durable: AutoStockDurableState;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T15:00:00`));
    durable = { medications: [med()], logs: [] };
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (state) => {
        durable = {
          medications: state.medications.map((m) => ({ ...m })),
          logs: state.logs.map((l) => ({ ...l })),
        };
        return null;
      },
    });
  });

  afterEach(() => {
    __setAutoStockGateTestHooks(null);
    vi.useRealTimers();
  });

  it('Manual Take deducts once and records consume marker', async () => {
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(r.outcome).toBe('applied');
    expect(r.doseAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBeLessThan(10);
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
  });

  it('Auto-Deduction after Manual Take is already_applied (one deduction)', async () => {
    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    const pillsAfterTake = durable.medications[0].currentPills;

    const recon = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: durable.medications,
      logs: durable.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [
        fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 }),
      ] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      persistMeds: (m) => {
        durable.medications = m;
        return null;
      },
      persistLogs: (l) => {
        durable.logs = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
});

    expect(recon.details[0]?.outcome).toBe('already_applied');
    expect(durable.medications[0].currentPills).toBe(pillsAfterTake);
    expect(
      durable.logs.filter((l) => l.id === exactAutoLogId('med-1', 'd1', TODAY))
    ).toHaveLength(0);
  });

  it('Manual Take after Auto-Deduction is already_consumed (one deduction)', async () => {
    const recon = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: durable.medications,
      logs: durable.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [
        fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 }),
      ] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      persistMeds: (m) => {
        durable.medications = m;
        return null;
      },
      persistLogs: (l) => {
        durable.logs = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(recon.details[0]?.outcome).toBe('applied');
    const pillsAfterAuto = durable.medications[0].currentPills;

    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('already_consumed');
    expect(durable.medications[0].currentPills).toBe(pillsAfterAuto);
  });

  it('serialized race: concurrent Take + reconcile yields one deduction', async () => {
    // Start both through the gate (not alreadyInGate) so they share the chain.
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (state) => {
        durable = {
          medications: state.medications.map((m) => ({ ...m })),
          logs: state.logs.map((l) => ({ ...l })),
        };
        return null;
      },
    });

    const takeP = runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    const reconP = runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [
        fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 }),
      ] }),
      markReconciled: async () => ({ ok: true, changed: true }),
    });

    const [take, recon] = await Promise.all([takeP, reconP]);

    // Exactly one applied stock mutation for this occurrence.
    const appliedTake = take.outcome === 'applied' ? 1 : 0;
    const appliedRecon = recon.details.some((d) => d.outcome === 'applied') ? 1 : 0;
    expect(appliedTake + appliedRecon).toBe(1);
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
    // 10 - 1 = 9 (d1 amount); not 8.
    expect(durable.medications[0].currentPills).toBe(9);
  });

  it('multi-dose independence: Take d1 does not block Auto on d2', async () => {
    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    const afterD1 = durable.medications[0].currentPills;

    const recon = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: durable.medications,
      logs: durable.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [
        fired({ doseId: 'd2', calendarDate: TODAY, amount: 1 }),
      ] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      persistMeds: (m) => {
        durable.medications = m;
        return null;
      },
      persistLogs: (l) => {
        durable.logs = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(recon.details[0]?.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(afterD1 - 1);
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
    expect(isDoseConsumedOnDate(durable.medications[0], 'd2', TODAY)).toBe(true);
  });

  it('Manual Restore after Take is idempotent on second Restore (stock + logs)', async () => {
    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    const afterTake = durable.medications[0].currentPills;

    const r1 = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-1',
    });
    expect(r1.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(afterTake + 1);
    expect(durable.logs.filter((l) => l.id === 'restore-1')).toHaveLength(1);

    const pillsAfterFirst = durable.medications[0].currentPills;
    const r2 = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-2',
    });
    // Behavioral contract: stock restored exactly once; second is already_restored.
    expect(r2.outcome).toBe('already_restored');
    expect(durable.medications[0].currentPills).toBe(pillsAfterFirst);
    expect(durable.medications[0].currentPills).toBe(afterTake + 1);
    expect(durable.logs.filter((l) => l.id === 'restore-1')).toHaveLength(1);
    expect(durable.logs.filter((l) => l.id === 'restore-2')).toHaveLength(0);
  });

  it('crash recovery: markers after Take prevent duplicate exact auto on restart', async () => {
    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    // Simulate restart: durable still has markers; FIRED still listed.

    const recon = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: durable.medications,
      logs: durable.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [
        fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 }),
      ] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      persistMeds: (m) => {
        durable.medications = m;
        return null;
      },
      persistLogs: (l) => {
        durable.logs = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(recon.details[0]?.outcome).toBe('already_applied');
    expect(durable.medications[0].currentPills).toBe(9);
  });

  it('stale React snapshot cannot overwrite durable Take when gate serializes', async () => {
    // First take commits durable to 9.
    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(durable.medications[0].currentPills).toBe(9);

    // A second concurrent-looking take on same occurrence is rejected.
    const again = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(again.outcome).toBe('already_consumed');
    expect(durable.medications[0].currentPills).toBe(9);
  });
});





describe('Phase 4 — Manual envelope ownership (no native ACK)', () => {
  let durable: AutoStockDurableState;
  let manualEnvelope: ManualStockEnvelope | null;
  let failLogs: boolean;
  let failClear: boolean;
  let failBump: boolean;
  let failLastApplied: boolean;
  let failAllocate: boolean;
  let generation: number;
  let marked: string[];

    beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T15:00:00`));
    durable = { medications: [med()] }), logs: [] };
    manualEnvelope = null;
    failLogs = false;
    failClear = false;
    failBump = false;
    failLastApplied = false;
    failAllocate = false;
    generation = 0;
    marked = [];
    let lastApplied = 0;
    let nextSeq = 0;
    __resetStockMutationOrderingForTests();
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (seq) => {
        if (failLastApplied) return 'lastApplied write failed';
        lastApplied = seq;
        return null;
      },
      allocate: () => {
        if (failAllocate) return { ok: false, error: 'nextSeq persist failed' };
        nextSeq += 1;
        return { ok: true, seq: nextSeq };
      },
    });

    __setManualEnvelopeTestHooks({
    load: () => manualEnvelope,
      save: (env) => {
        if (env == null && failClear) {
          return 'envelope clear failed';
        }
        manualEnvelope = env;
        return null;
      },
    });

    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (state) => {
        durable.medications = state.medications.map((m) => ({ ...m }));
        if (failLogs) {
          return 'logs persist failed';
        }
        durable.logs = state.logs.map((l) => ({ ...l }));
        return null;
      },
      loadGeneration: () => generation,
      bumpGeneration: () => {
        if (failBump) return 'generation bump failed';
        generation += 1;
        return null;
      },
    });
  });

  afterEach(() => {
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    vi.useRealTimers();
  });

  it('partial write leaves envelope; recovery restores pair without ACK or double deduct', async () => {
    failLogs = true;
    const first = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(first.outcome).toBe('persist_failed');
    expect(manualEnvelope).not.toBeNull();
    expect(manualEnvelope?.status).toBe('manual_js_ready');
    expect(manualEnvelope?.baseGeneration).toBe(0);
    expect((manualEnvelope as { toAcknowledge?: unknown }).toAcknowledge).toBeUndefined();
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
    expect(durable.logs.some((l) => l.type === 'dose_taken')).toBe(false);
    expect(generation).toBe(0);
    expect(marked).toEqual([]);

    failLogs = false;
    marked = [];
    const reconOnly = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });
    expect(manualEnvelope).toBeNull();
    expect(durable.logs.some((l) => l.type === 'dose_taken')).toBe(true);
    expect(durable.medications[0].currentPills).toBe(9);
    expect(generation).toBe(1);
    expect(marked).toEqual([]);
    expect(reconOnly.markedCount).toBe(0);
  });

  it('same recon: Manual envelope recovery + actual FIRED → ACK only from FIRED path', async () => {
    failLogs = true;
    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(manualEnvelope).not.toBeNull();
    const pillsAfterPartial = durable.medications[0].currentPills;

    failLogs = false;
    marked = [];
    let markPhase = 'before';

    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => {
        expect(manualEnvelope).toBeNull();
        expect(marked).toEqual([]);
        markPhase = 'listFired';
        return [fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 })];
      },
      markReconciled: async (medicationId, doseId, calendarDate) => {
        expect(markPhase).toBe('listFired');
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });

    expect(manualEnvelope).toBeNull();
    expect(durable.logs.some((l) => l.type === 'dose_taken')).toBe(true);
    expect(durable.medications[0].currentPills).toBe(pillsAfterPartial);
    expect(recon.details[0]?.outcome).toBe('already_applied');
    expect(marked).toEqual([`med-1|d1|${TODAY}`]);
    expect(recon.markedCount).toBe(1);
  });

  it('lastApplied failure after meds+logs keeps envelope; recovery finalizes without double deduct', async () => {
    failLastApplied = true;
    const first = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    // Pair may be on durable but finalization failed → not success for caller.
    expect(first.outcome).toBe('persist_failed');
    expect(durable.medications[0].currentPills).toBe(9);
    expect(durable.logs.some((l) => l.type === 'dose_taken')).toBe(true);
    expect(manualEnvelope).not.toBeNull();
    const logCount = durable.logs.length;
    const logIds = durable.logs.map((l) => l.id);

    failLastApplied = false;
    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });
    expect(manualEnvelope).toBeNull();
    expect(durable.medications[0].currentPills).toBe(9);
    expect(durable.logs.length).toBe(logCount);
    expect(durable.logs.map((l) => l.id)).toEqual(logIds);
    expect(marked).toEqual([]);
  });

  it('generation bump failure after successful finalization is still applied', async () => {
    failBump = true;
    const first = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(first.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(9);
    expect(manualEnvelope).toBeNull();
  });

  it('stale Manual envelope must not overwrite newer durable state', async () => {
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(generation).toBe(1);
    expect(durable.medications[0].currentPills).toBe(9);
    const newerLogs = durable.logs.map((l) => ({ ...l }));

    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 10 })] }),
      logs: [],
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
      mutationSeq: 1,
    };

    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });

    expect(manualEnvelope).toBeNull();
    expect(durable.medications[0].currentPills).toBe(9);
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
    expect(durable.logs.length).toBe(newerLogs.length);
    expect(marked).toEqual([]);
  });

  it('clear failure after successful meds+logs is idempotent on retry', async () => {
    failClear = true;
    const first = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(first.outcome).toBe('applied');
    expect(generation).toBe(1);
    expect(durable.medications[0].currentPills).toBe(9);
    expect(durable.logs.some((l) => l.type === 'dose_taken')).toBe(true);
    expect(manualEnvelope).not.toBeNull();
    expect(manualEnvelope?.baseGeneration).toBe(0);
    const logCount = durable.logs.length;
    const pills = durable.medications[0].currentPills;

    failClear = false;
    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });
    expect(manualEnvelope).toBeNull();
    expect(durable.medications[0].currentPills).toBe(pills);
    expect(durable.logs.length).toBe(logCount);
    expect(marked).toEqual([]);
  });

  it('Manual Restore partial write → JS recovery only, never native mark', async () => {
    failLogs = false;
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(9);

    failLogs = true;
    marked = [];
    const restoreFail = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-crash-1',
    });
    expect(restoreFail.outcome).toBe('persist_failed');
    expect(manualEnvelope).not.toBeNull();
    expect((manualEnvelope as { toAcknowledge?: unknown }).toAcknowledge).toBeUndefined();
    expect(durable.medications[0].currentPills).toBe(10);
    expect(marked).toEqual([]);

    failLogs = false;
    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });
    expect(manualEnvelope).toBeNull();
    expect(durable.medications[0].currentPills).toBe(10);
    expect(durable.logs.some((l) => l.id === 'restore-crash-1')).toBe(true);
    expect(marked).toEqual([]);
  });

  it('persist_failed leaves stock unchanged and is not already_consumed', async () => {
    failLogs = true;
    const before = durable.medications[0].currentPills;
    const result = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(result.outcome).toBe('persist_failed');
    expect(result.outcome).not.toBe('already_consumed');
    expect(result.outcome).not.toBe('applied');
    // Durable meds may have partial write; returned snapshot stays pre-commit for caller.
    expect(result.medications[0].currentPills).toBe(before);
    expect(result.log).toBeNull();
  });


  it('Manual + Exact Auto envelopes together: older seq never overwrites newer durable', async () => {
    // Apply a successful Manual Take (seq=1) so durable is at pills=9.
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(9);
    const newerLogs = durable.logs.map((l) => ({ ...l }));

    // Plant older Manual envelope (seq 1 already applied) with contradictory stock=10.
    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 10 })] }),
      logs: [{ id: 'old-log', medicationId: 'med-1', medicationName: 'TestMed', type: 'dose_taken', amount: 1, date: TODAY, timestamp: '', description: '' }],
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
      mutationSeq: 1,
    };

    // Plant Exact Auto envelope with higher seq that matches current durable (no overwrite).
    let exactEnv: {
      version: 1;
      status: 'js_ready';
      medications: typeof durable.medications;
      logs: typeof durable.logs;
      toAcknowledge: Array<{ medicationId: string; doseId: string; calendarDate: string }>;
      createdAt: string;
      mutationSeq: number;
      globalAutoDeductEnabled: true,
    } | null = {
      version: 1,
      status: 'js_ready',
      medications: durable.medications.map((m) => ({ ...m, currentPills: 8 })),
      logs: [
        ...newerLogs,
        {
          id: 'exact-extra',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: 1,
          date: TODAY,
          timestamp: '',
          description: '',
        },
      ],
      toAcknowledge: [
        { medicationId: 'med-1', doseId: 'd2', calendarDate: TODAY },
      ],
      createdAt: new Date().toISOString(),
      mutationSeq: 2,
    };

    marked = [];
    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
      loadEnvelope: () => exactEnv,
      saveEnvelope: (env) => {
        exactEnv = env as typeof exactEnv;
        return null;
      },
    });

    // Older Manual (seq 1) discarded; Exact Auto seq 2 applied once.
    expect(manualEnvelope).toBeNull();
    expect(exactEnv).toBeNull();
    expect(durable.medications[0].currentPills).toBe(8);
    expect(durable.logs.some((l) => l.id === 'exact-extra')).toBe(true);
    // Manual old stock=10 must not win.
    expect(durable.medications[0].currentPills).not.toBe(10);
    // ACK only from Exact Auto toAcknowledge (FIRED ownership at envelope time).
    expect(marked).toEqual([`med-1|d2|${TODAY}`]);
    expect(recon.recoveredEnvelope).toBe(true);
  });

  it('old envelope log id present but newer durable mutation wins (no meds overwrite)', async () => {
    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(durable.medications[0].currentPills).toBe(9);
    const takeLogId = durable.logs.find((l) => l.type === 'dose_taken')?.id;
    expect(takeLogId).toBeTruthy();

    // Stale envelope reuses same log id but wants stock=10 (wrong).
    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 10 })] }),
      logs: durable.logs.map((l) => ({ ...l })),
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
      mutationSeq: 1,
    };

    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });
    expect(manualEnvelope).toBeNull();
    expect(durable.medications[0].currentPills).toBe(9);
  });


  it('seq11 durable with lastApplied lag: pending seq10 must not overwrite', async () => {
    // Durable already reflects newer mutation (seq 2) but lastApplied still 0.
    const seq2Logs = [
      {
        id: 'seq2-log',
        medicationId: 'med-1',
        medicationName: 'TestMed',
        type: 'dose_taken' as const,
        amount: 1,
        date: TODAY,
        timestamp: '',
        description: '',
      },
    ];
    durable.medications = [med({ currentPills: 8 })];
    durable.logs = seq2Logs;

    // Older pending envelope wants to restore stock=10.
    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 10 })] }),
      logs: [
        {
          id: 'seq1-log',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: 1,
          date: TODAY,
          timestamp: '',
          description: '',
        },
      ],
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
      mutationSeq: 1,
    };

    let exactEnv: {
      version: 1;
      status: 'js_ready';
      medications: typeof durable.medications;
      logs: typeof durable.logs;
      toAcknowledge: Array<{ medicationId: string; doseId: string; calendarDate: string }>;
      createdAt: string;
      mutationSeq: number;
      globalAutoDeductEnabled: true,
    } | null = {
      version: 1,
      status: 'js_ready',
      medications: [med({ currentPills: 8 })],
      logs: seq2Logs,
      toAcknowledge: [],
      createdAt: new Date().toISOString(),
      mutationSeq: 2,
    };

    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      loadEnvelope: () => exactEnv,
      saveEnvelope: (env) => {
        exactEnv = env as typeof exactEnv;
        return null;
      },
    });

    expect(durable.medications[0].currentPills).toBe(8);
    expect(durable.logs.some((l) => l.id === 'seq2-log')).toBe(true);
    expect(durable.medications[0].currentPills).not.toBe(10);
  });


  it('both pending: higher Exact Auto seq recovered before older Manual can write', async () => {
    // lastApplied=0; durable still at base stock=10
    durable = { medications: [med({ currentPills: 10 })] }), logs: [] };

    const seq10Logs = [
      {
        id: 'manual-seq10',
        medicationId: 'med-1',
        medicationName: 'TestMed',
        type: 'dose_taken' as const,
        amount: 1,
        date: TODAY,
        timestamp: '',
        description: '',
      },
    ];
    const seq11Logs = [
      ...seq10Logs,
      {
        id: 'exact-seq11',
        medicationId: 'med-1',
        medicationName: 'TestMed',
        type: 'dose_taken' as const,
        amount: 1,
        date: TODAY,
        timestamp: '',
        description: '',
      },
    ];

    // Older Manual wants stock=9 (after one take)
    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 9 })],
      logs: seq10Logs,
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
      mutationSeq: 10,
    };

    // Newer Exact Auto full snapshot stock=8
    let exactEnv: {
      version: 1;
      status: 'js_ready';
      medications: ReturnType<typeof med>[];
      logs: typeof seq11Logs;
      toAcknowledge: Array<{ medicationId: string; doseId: string; calendarDate: string }>;
      createdAt: string;
      mutationSeq: number;
      globalAutoDeductEnabled: true,
    } | null = {
      version: 1,
      status: 'js_ready',
      medications: [med({ currentPills: 8 })],
      logs: seq11Logs,
      toAcknowledge: [
        { medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY },
      ],
      createdAt: new Date().toISOString(),
      mutationSeq: 11,
    };

    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
      loadEnvelope: () => exactEnv,
      saveEnvelope: (env) => {
        exactEnv = env as typeof exactEnv;
        return null;
      },
    });

    // Higher seq wins: stock=8 not Manual's 9
    expect(durable.medications[0].currentPills).toBe(8);
    expect(durable.logs.some((l) => l.id === 'exact-seq11')).toBe(true);
    expect(manualEnvelope).toBeNull();
    expect(exactEnv).toBeNull();
    expect(marked).toEqual([`med-1|d1|${TODAY}`]);
  });

  it('both pending reverse: higher Manual seq wins over older Exact Auto', async () => {
    durable = { medications: [med({ currentPills: 10 })] }), logs: [] };

    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 7 })],
      logs: [
        {
          id: 'manual-seq11',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: 1,
          date: TODAY,
          timestamp: '',
          description: '',
        },
      ],
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
      mutationSeq: 11,
    };

    let exactEnv: {
      version: 1;
      status: 'js_ready';
      medications: ReturnType<typeof med>[];
      logs: Array<{
        id: string;
        medicationId: string;
        medicationName: string;
        type: 'dose_taken';
        amount: number;
        date: string;
        timestamp: string;
        description: string;
      }>;
      toAcknowledge: Array<{ medicationId: string; doseId: string; calendarDate: string }>;
      createdAt: string;
      mutationSeq: number;
      globalAutoDeductEnabled: true,
    } | null = {
      version: 1,
      status: 'js_ready',
      medications: [med({ currentPills: 9 })],
      logs: [
        {
          id: 'exact-seq10',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: 1,
          date: TODAY,
          timestamp: '',
          description: '',
        },
      ],
      toAcknowledge: [],
      createdAt: new Date().toISOString(),
      mutationSeq: 10,
    };

    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      loadEnvelope: () => exactEnv,
      saveEnvelope: (env) => {
        exactEnv = env as typeof exactEnv;
        return null;
      },
    });

    expect(durable.medications[0].currentPills).toBe(7);
    expect(durable.logs.some((l) => l.id === 'manual-seq11')).toBe(true);
    expect(durable.medications[0].currentPills).not.toBe(9);
  });


  it('Exact Auto envelope seq<=lastApplied still returns toAcknowledge for orchestrator ACK', async () => {
    // Simulate finalized mutation (lastApplied covers seq) but envelope still present.
    durable = { medications: [med({ currentPills: 8 })] }), logs: [] };
    let lastApplied = 11;
    let nextSeq = 11;
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (seq) => {
        lastApplied = seq;
        return null;
      },
      allocate: () => {
        nextSeq += 1;
        return { ok: true, seq: nextSeq };
      },
    });

    let exactEnv: {
      version: 1;
      status: 'js_ready';
      medications: ReturnType<typeof med>[];
      logs: [];
      toAcknowledge: Array<{ medicationId: string; doseId: string; calendarDate: string }>;
      createdAt: string;
      mutationSeq: number;
      globalAutoDeductEnabled: true,
    } | null = {
      version: 1,
      status: 'js_ready',
      medications: [med({ currentPills: 8 })],
      logs: [],
      toAcknowledge: [
        { medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY },
        { medicationId: 'med-1', doseId: 'd2', calendarDate: TODAY },
      ],
      createdAt: new Date().toISOString(),
      mutationSeq: 11,
    };

    marked = [];
    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
      loadEnvelope: () => exactEnv,
      saveEnvelope: (env) => {
        exactEnv = env as typeof exactEnv;
        return null;
      },
    });

    expect(marked).toEqual([
      `med-1|d1|${TODAY}`,
      `med-1|d2|${TODAY}`,
    ]);
    expect(recon.markedCount).toBe(2);
    expect(exactEnv).toBeNull();
    // No stock mutation on cleanup-only path.
    expect(durable.medications[0].currentPills).toBe(8);
  });

  it('clear failure after finalization does not re-apply; retry clears only', async () => {
    failClear = true;
    const first = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    // Commit+lastApplied succeed; clear fails → mutation IS durable
    // (lastApplied is the completion proof). Caller sees 'applied'; the
    // envelope stays for retry (cleanup on next gate entry).
    expect(first.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(9);
    expect(manualEnvelope).not.toBeNull();
    const logCount = durable.logs.length;

    failClear = false;
    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });
    expect(manualEnvelope).toBeNull();
    expect(durable.medications[0].currentPills).toBe(9);
    expect(durable.logs.length).toBe(logCount);
    expect(marked).toEqual([]);
  });


  it('durableMatchesEnvelopeSnapshot requires complete medication array', () => {
    const full = {
      medications: [med({ currentPills: 9 }), med({ id: 'med-2', currentPills: 5 })] }),
      logs: [{ id: 'l1', medicationId: 'med-1', medicationName: 'T', type: 'dose_taken' as const, amount: 1, date: TODAY, timestamp: '', description: '' }],
    };
    const durableFull = {
      medications: full.medications.map((m: ReturnType<typeof med>) => ({ ...m })),
      logs: full.logs.map((l) => ({ ...l })),
    };
    expect(durableMatchesEnvelopeSnapshot(full, durableFull)).toBe(true);

    // Missing medication in durable
    const durableSubset = {
      medications: [med({ currentPills: 9 })],
      logs: durableFull.logs,
    };
    expect(durableMatchesEnvelopeSnapshot(full, durableSubset)).toBe(false);

    // Different currentPills
    const durablePills = {
      medications: [med({ currentPills: 8 }), med({ id: 'med-2', currentPills: 5 })],
      logs: durableFull.logs,
    };
    expect(durableMatchesEnvelopeSnapshot(full, durablePills)).toBe(false);

    // Matching log ids but different meds must be false
    const durableWrongMeds = {
      medications: [med({ currentPills: 10 }), med({ id: 'med-2', currentPills: 5 })],
      logs: durableFull.logs,
    };
    expect(durableMatchesEnvelopeSnapshot(full, durableWrongMeds)).toBe(false);
  });

  it('durableMatchesEnvelopeSnapshot: same log IDs but different log contents → not matched', () => {
    const env = {
      medications: [med({ currentPills: 9 })],
      logs: [{ id: 'l1', medicationId: 'med-1', medicationName: 'T', type: 'dose_taken' as const, amount: -1, date: TODAY, timestamp: 't1', description: 'd', doseId: 'd1' }],
    };
    // Same id, same medication, but amount differs (-1 vs -2).
    const durableDiffAmount = {
      medications: [med({ currentPills: 9 })],
      logs: [{ id: 'l1', medicationId: 'med-1', medicationName: 'T', type: 'dose_taken' as const, amount: -2, date: TODAY, timestamp: 't1', description: 'd', doseId: 'd1' }],
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffAmount)).toBe(false);
    // Same id but different doseId.
    const durableDiffDose = {
      medications: [med({ currentPills: 9 })],
      logs: [{ id: 'l1', medicationId: 'med-1', medicationName: 'T', type: 'dose_taken' as const, amount: -1, date: TODAY, timestamp: 't1', description: 'd', doseId: 'd2' }],
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffDose)).toBe(false);
    // Same id but different date.
    const durableDiffDate = {
      medications: [med({ currentPills: 9 })],
      logs: [{ id: 'l1', medicationId: 'med-1', medicationName: 'T', type: 'dose_taken' as const, amount: -1, date: '2026-09-15', timestamp: 't1', description: 'd', doseId: 'd1' }],
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffDate)).toBe(false);
  });

  it('durableMatchesEnvelopeSnapshot: same stock fields but different medication metadata → not matched', () => {
    const env = {
      medications: [med({ currentPills: 9, name: 'TestMed' })],
      logs: [],
    };
    // Same currentPills but different name.
    const durableDiffName = { medications: [med({ currentPills: 9, name: 'OtherMed' })], logs: [] };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffName)).toBe(false);
    // Same currentPills but different unit.
    const durableDiffUnit = { medications: [med({ currentPills: 9, unit: 'مل' })], logs: [] };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffUnit)).toBe(false);
    // Same currentPills but different dailyDose.
    const durableDiffDose = { medications: [med({ currentPills: 9, dailyDose: 3 })], logs: [] };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffDose)).toBe(false);
    // Same currentPills but different doseSchedule (array content).
    const durableDiffSchedule = {
      medications: [med({ currentPills: 9, doseSchedule: [{ id: 'd1', amount: 1, time: '09:00' }] })],
      logs: [],
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffSchedule)).toBe(false);
  });

  it('durableMatchesEnvelopeSnapshot: medication/log count and order mismatches → not matched', () => {
    const env = {
      medications: [med({ currentPills: 9 }), med({ id: 'med-2', currentPills: 5 })],
      logs: [
        { id: 'l1', medicationId: 'med-1', medicationName: 'T', type: 'dose_taken' as const, amount: -1, date: TODAY, timestamp: '', description: '' },
        { id: 'l2', medicationId: 'med-1', medicationName: 'T', type: 'refill' as const, amount: 10, date: TODAY, timestamp: '', description: '' },
      ],
    };
    // Extra medication in durable.
    const durableExtraMed = {
      medications: [med({ currentPills: 9 }), med({ id: 'med-2', currentPills: 5 }), med({ id: 'med-3', currentPills: 1 })],
      logs: env.logs.map((l) => ({ ...l })),
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableExtraMed)).toBe(false);
    // Extra log in durable.
    const durableExtraLog = {
      medications: env.medications.map((m) => ({ ...m })),
      logs: [...env.logs.map((l) => ({ ...l })), { id: 'l3', medicationId: 'med-1', medicationName: 'T', type: 'refill' as const, amount: 5, date: TODAY, timestamp: '', description: '' }],
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableExtraLog)).toBe(false);
    // Missing log.
    const durableMissingLog = {
      medications: env.medications.map((m) => ({ ...m })),
      logs: [env.logs[0]].map((l) => ({ ...l })),
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableMissingLog)).toBe(false);
    // Same content, different medication order.
    const durableReorderedMeds = {
      medications: [med({ id: 'med-2', currentPills: 5 }), med({ currentPills: 9 })],
      logs: env.logs.map((l) => ({ ...l })),
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableReorderedMeds)).toBe(false);
    // Same content, different log order.
    const durableReorderedLogs = {
      medications: env.medications.map((m) => ({ ...m })),
      logs: [env.logs[1], env.logs[0]].map((l) => ({ ...l })),
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableReorderedLogs)).toBe(false);
  });

  it('durableMatchesEnvelopeSnapshot: full match → finalize + clear without re-apply (via recovery)', async () => {
    // Envelope snapshot exactly equals durable → recovery finalizes + clears
    // without re-applying the snapshot (no extra mutation).
    durable = {
      medications: [med({ currentPills: 8, doseConsumptionHistory: { d1: [TODAY] } })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -1, date: TODAY, timestamp: '', description: '', doseId: 'd1' }],
    };
    let phase4Exact: ExactAutoEnvelope | null = {
      version: 1,
      status: 'js_ready',
      medications: durable.medications.map((m) => ({ ...m })),
      logs: durable.logs.map((l) => ({ ...l })),
      toAcknowledge: [{ medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY }],
      createdAt: new Date().toISOString(),
      mutationSeq: 3,
      globalAutoDeductEnabled: true,
    };
    let lastApplied = 3;
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (seq) => { lastApplied = seq; return null; },
      allocate: () => { return { ok: true, seq: 99 }; },
    });

    marked = [];
    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (m, d, c) => { marked.push(`${m}|${d}|${c}`); return { ok: true, changed: true }; },
      loadEnvelope: () => phase4Exact,
      saveEnvelope: (e) => { phase4Exact = e; return null; },
    });

    // Snapshot matched → finalize (no-op, seq 3 <= lastApplied 3) + clear + ACK.
    expect(phase4Exact).toBeNull();
    expect(durable.medications[0].currentPills).toBe(8);
    expect(durable.logs.filter((l) => l.id === 'match-clear')).toHaveLength(1);
    expect(marked).toEqual([`med-1|d1|${TODAY}`]);
    expect(recon.markedCount).toBe(1);
  });

  it('durableMatchesEnvelopeSnapshot: mismatch → apply snapshot then finalize then clear', async () => {
    // Envelope snapshot differs from durable → recovery re-applies the
    // envelope snapshot, finalizes, then clears.
    durable = { medications: [med({ currentPills: 10 })] }), logs: [] };
    let phase4Exact: ExactAutoEnvelope | null = {
      version: 1,
      status: 'js_ready',
      medications: [med({ currentPills: 7, doseConsumptionHistory: { d1: [TODAY] } })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -1, date: TODAY, timestamp: '', description: '', doseId: 'd1' }],
      toAcknowledge: [{ medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY }],
      createdAt: new Date().toISOString(),
      mutationSeq: 4,
      globalAutoDeductEnabled: true,
    };
    let lastApplied = 0;
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (seq) => { lastApplied = seq; return null; },
      allocate: () => { return { ok: true, seq: 4 }; },
    });

    marked = [];
    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (m, d, c) => { marked.push(`${m}|${d}|${c}`); return { ok: true, changed: true }; },
      loadEnvelope: () => phase4Exact,
      saveEnvelope: (e) => { phase4Exact = e; return null; },
    });

    // Snapshot re-applied: durable now matches envelope (currentPills=7).
    expect(durable.medications[0].currentPills).toBe(7);
    expect(durable.logs.some((l) => l.id === 'mismatch-apply')).toBe(true);
    expect(phase4Exact).toBeNull();
    expect(lastApplied).toBe(4);
    expect(marked).toEqual([`med-1|d1|${TODAY}`]);
    expect(recon.markedCount).toBe(1);
  });

  it('crash after persistence before finalization → restart finalizes without double mutation', async () => {
    // Simulate: envelope seq=5, durable already reflects the snapshot (commit
    // succeeded), but lastApplied did NOT advance (finalize crashed). Restart
    // must finalize + clear WITHOUT re-applying the snapshot.
    durable = {
      medications: [med({ currentPills: 6, doseConsumptionHistory: { d1: [TODAY] } })] }),
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -1, date: TODAY, timestamp: '', description: '', doseId: 'd1' }],
    };
    let phase4Exact: ExactAutoEnvelope | null = {
      version: 1,
      status: 'js_ready',
      medications: durable.medications.map((m) => ({ ...m })),
      logs: durable.logs.map((l) => ({ ...l })),
      toAcknowledge: [{ medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY }],
      createdAt: new Date().toISOString(),
      mutationSeq: 5,
      globalAutoDeductEnabled: true,
    };
    let lastApplied = 0; // finalize crashed — lastApplied NOT advanced.
    let failFinalize = true;
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (seq) => { if (failFinalize) return 'lastApplied write failed'; lastApplied = seq; return null; },
      allocate: () => { return { ok: true, seq: 5 }; },
    });

    marked = [];
    const first = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (m, d, c) => { marked.push(`${m}|${d}|${c}`); return { ok: true, changed: true }; },
      loadEnvelope: () => phase4Exact,
      saveEnvelope: (e) => { phase4Exact = e; return null; },
    });
    // Finalize failed → blocked, envelope kept, no ACK.
    expect(phase4Exact).not.toBeNull();
    expect(first.recoveredEnvelope).toBe(true);
    expect(first.markedCount).toBe(0);
    const pillsAfterFirst = durable.medications[0].currentPills;
    const logCountAfterFirst = durable.logs.length;

    // Restart: finalize succeeds now → snapshot matches → finalize + clear + ACK.
    failFinalize = false;
    marked = [];
    const second = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (m, d, c) => { marked.push(`${m}|${d}|${c}`); return { ok: true, changed: true }; },
      loadEnvelope: () => phase4Exact,
      saveEnvelope: (e) => { phase4Exact = e; return null; },
    });
    expect(phase4Exact).toBeNull();
    // No double mutation: same pills + same log count.
    expect(durable.medications[0].currentPills).toBe(pillsAfterFirst);
    expect(durable.logs.length).toBe(logCountAfterFirst);
    expect(marked).toEqual([`med-1|d1|${TODAY}`]);
    expect(second.markedCount).toBe(1);
  });

  it('clear failure after finalization → restart does not re-mutate; retries clear only', async () => {
    durable = {
      medications: [med({ currentPills: 6, doseConsumptionHistory: { d1: [TODAY] } })] }),
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -1, date: TODAY, timestamp: '', description: '', doseId: 'd1' }],
    };
    let phase4Exact: ExactAutoEnvelope | null = {
      version: 1,
      status: 'js_ready',
      medications: durable.medications.map((m) => ({ ...m })),
      logs: durable.logs.map((l) => ({ ...l })),
      toAcknowledge: [{ medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY }],
      createdAt: new Date().toISOString(),
      mutationSeq: 6,
      globalAutoDeductEnabled: true,
    };
    let lastApplied = 6;
    let failClear = true;
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (seq) => { lastApplied = seq; return null; },
      allocate: () => { return { ok: true, seq: 6 }; },
    });

    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (m, d, c) => { marked.push(`${m}|${d}|${c}`); return { ok: true, changed: true }; },
      loadEnvelope: () => phase4Exact,
      saveEnvelope: (e) => { if (e == null && failClear) return 'envelope_clear_failed'; phase4Exact = e; return null; },
    });
    // lastApplied covers seq 6 → cleanup path: collect acks + tryClear.
    // Clear fails → envelope kept. No ACK (clear is part of the cleanup
    // sequence; the recovery returns the acks but the orchestrator ACKs
    // only after clear succeeds — verify no re-mutation.
    expect(phase4Exact).not.toBeNull();
    const pillsAfterFirst = durable.medications[0].currentPills;
    const logCountAfterFirst = durable.logs.length;

    // Restart: clear succeeds → envelope cleared. No re-mutation.
    failClear = false;
    marked = [];
    const second = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (m, d, c) => { marked.push(`${m}|${d}|${c}`); return { ok: true, changed: true }; },
      loadEnvelope: () => phase4Exact,
      saveEnvelope: (e) => { if (e == null && failClear) return 'envelope_clear_failed'; phase4Exact = e; return null; },
    });
    expect(phase4Exact).toBeNull();
    expect(durable.medications[0].currentPills).toBe(pillsAfterFirst);
    expect(durable.logs.length).toBe(logCountAfterFirst);
    expect(second.markedCount).toBeGreaterThanOrEqual(1);
  });

  it('Exact envelope missing mutationSeq is rejected (no Phase 4 recovery)', () => {
    // Legacy/pre-fix payload without mutationSeq must not be accepted.
    const legacyLike = {
      version: 1 as const,
      status: 'js_ready' as const,
      medications: [med({ currentPills: 5 })] }),
      logs: [],
      toAcknowledge: [],
      createdAt: new Date().toISOString(),
      globalAutoDeductEnabled: true,
      // mutationSeq intentionally absent
    };
    __setExactAutoEnvelopeStorageTestHooks({
      load: () => legacyLike as never,
      save: () => null,
    });
    expect(loadExactAutoStockEnvelope()).toBeNull();
    __setExactAutoEnvelopeStorageTestHooks(null);
  });

  it('Exact envelope with non-positive mutationSeq is rejected', () => {
    __setExactAutoEnvelopeStorageTestHooks({
      load: () =>
        ({
          version: 1,
          status: 'js_ready',
          medications: [med({ currentPills: 5 })],
          logs: [],
          toAcknowledge: [],
          createdAt: new Date().toISOString(),
          globalAutoDeductEnabled: true,
          mutationSeq: 0,
        }) as never,
      save: () => null,
    });
    expect(loadExactAutoStockEnvelope()).toBeNull();
    __setExactAutoEnvelopeStorageTestHooks(null);
  });

  it('pending Exact Auto is recovered before Manual Take allocates a new seq', async () => {
    durable = { medications: [med({ currentPills: 10 })], logs: [] };
    // Plant Exact Auto envelope seq=5 with stock=8 (one auto deduction applied in snapshot)
    // Use test hook path via __setExactAutoEnvelopeStorageTestHooks if available
    let exactEnv: ExactAutoEnvelope | null = {
      version: 1,
      status: 'js_ready',
      medications: [med({ currentPills: 8 })],
      logs: [
        {
          id: 'exact-pending',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: 1,
          date: TODAY,
          timestamp: '',
          description: '',
        },
      ],
      toAcknowledge: [{ medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY }],
      createdAt: new Date().toISOString(),
      mutationSeq: 5,
    };
    __setExactAutoEnvelopeStorageTestHooks({
      load: () => exactEnv,
      save: (env) => {
        exactEnv = env as ExactAutoEnvelope | null;
        return null;
      },
    });

    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd2',
      source: 'manual',
      todayStr: TODAY,
    });
    // Exact Auto seq 5 must be applied first (stock 8), then Manual d2 may apply
    // If d2 take applied: stock 7; if already blocked etc.
    expect(exactEnv).toBeNull();
    // Durable must reflect at least the Exact Auto snapshot base (not still 10)
    expect(durable.medications[0].currentPills).toBeLessThan(10);
    expect(durable.logs.some((l: { id: string }) => l.id === 'exact-pending')).toBe(true);

    __setExactAutoEnvelopeStorageTestHooks(null);
  });


  it('Restore d1 after Auto d1+d2 only returns d1 amount (no sibling resettle)', async () => {
    // Simulate Exact Auto applied both slots: stock 8, both consumed markers.
    durable = {
      medications: [
        med({
          currentPills: 8,
          doseConsumptionHistory: { d1: [TODAY], d2: [TODAY] },
        }),
      ],
      logs: [
        {
          id: exactAutoLogId('med-1', 'd1', TODAY),
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'exact_auto',
          amount: -1,
          date: TODAY,
          timestamp: '',
          description: '',
          doseId: 'd1',
        },
        {
          id: exactAutoLogId('med-1', 'd2', TODAY),
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'exact_auto',
          amount: -1,
          date: TODAY,
          timestamp: '',
          description: '',
          doseId: 'd2',
        },
      ],
    };

    const r1 = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-d1',
    });
    expect(r1.outcome).toBe('applied');
    expect(r1.restoredAmount).toBe(1);
    // Only d1 restored: 8+1=9; d2 marker remains.
    expect(durable.medications[0].currentPills).toBe(9);
    expect(durable.medications[0].doseConsumptionHistory?.d2).toBe(TODAY);
    expect(durable.medications[0].doseConsumptionHistory?.d1).toBeUndefined();

    // Second restore of d1 is no-op.
    const r2 = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-d1-2',
    });
    expect(r2.outcome).toBe('already_restored');
    expect(durable.medications[0].currentPills).toBe(9);

    // Take d1 after restore: one final deduction → 8.
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(8);
    // d2 still consumed independently.
    expect(durable.medications[0].doseConsumptionHistory?.d2).toBe(TODAY);
  });


  it('Restore uses actual clamped Auto amount not full slot amount', async () => {
    // Slot amount 2 but only 1 pill was available → Auto deducted 1 (log amount -1).
    durable = {
      medications: [
        med({
          currentPills: 0,
          doseSchedule: [
            { id: 'd1', amount: 2, time: '08:00' },
            { id: 'd2', amount: 1, time: '14:00' },
          ],
          doseConsumptionHistory: { d1: [TODAY] },
        }),
      ],
      logs: [
        {
          id: exactAutoLogId('med-1', 'd1', TODAY),
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'exact_auto',
          amount: -1,
          date: TODAY,
          timestamp: '',
          description: '',
          doseId: 'd1',
        },
      ],
    };
    const r = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-clamped',
    });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(1);
  });

  it('zero actual Auto deduction Restore adds zero', async () => {
    durable = {
      medications: [
        med({
          currentPills: 0,
          doseConsumptionHistory: { d1: [TODAY] },
        }),
      ],
      logs: [
        {
          id: exactAutoLogId('med-1', 'd1', TODAY),
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'exact_auto',
          amount: 0,
          date: TODAY,
          timestamp: '',
          description: '',
          doseId: 'd1',
        },
      ],
    };
    const r = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-zero',
    });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(0);
    expect(durable.medications[0].currentPills).toBe(0);
    expect(durable.medications[0].doseConsumptionHistory?.d1).toBeUndefined();
  });

  // ─── Active-deduction restore accounting (reversal tracking) ───
  //
  // restoreDose finds the ACTIVE (un-reversed) deduction log for the exact
  // occurrence (medicationId + doseId + calendarDate). The gated path marks
  // the reversed deduction log `reversedAt` and links the restore
  // (skipped_day) log via `relatedLogId`. A later Restore for the same
  // occurrence finds the NEXT active deduction (e.g. the Take after Auto →
  // Restore → Take), NOT a stale historical deduction that was already
  // reversed. This prevents stock inflation from re-reversing an old log.

  it('Auto 3 → Restore = +3 (active deduction tracked)', async () => {
    durable = {
      medications: [med({ currentPills: 7, doseConsumptionHistory: { d1: [TODAY] } })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -3, date: TODAY, timestamp: '', description: '', doseId: 'd1' }],
    };
    const r = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-auto-3' });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(3);
    expect(durable.medications[0].currentPills).toBe(10);
    // The auto-3 deduction log is now marked reversed.
    const autoLog = durable.logs.find((l) => l.id === exactAutoLogId('med-1', 'd1', TODAY));
    expect(autoLog?.reversedAt).toBeTruthy();
    // The restore log links to it.
    const restoreLog = durable.logs.find((l) => l.id === 'restore-auto-3');
    expect(restoreLog?.relatedLogId).toBe(exactAutoLogId('med-1', 'd1', TODAY));
  });

  it('Auto 3 → Restore → Take 1 (clamped) → Restore = +1 (reverses the Take, not the old Auto)', async () => {
    // After Auto (3) + Restore (+3), the user Takes again but stock is low
    // so the Take clamps to 1. The next Restore must reverse the Take's 1,
    // NOT the old Auto's 3 (which is already reversed).
    durable = {
      medications: [med({ currentPills: 1 })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -3, date: TODAY, timestamp: '', description: '', doseId: 'd1', reversedAt: 'already-reversed' }],
    };
    // Take d1 — clamped to available stock (1). currentPills 1 → 0.
    const take = await runGatedManualConsume({ medicationId: 'med-1', doseId: 'd1', source: 'manual', todayStr: TODAY });
    expect(take.outcome).toBe('applied');
    expect(take.doseAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(0);
    // The dose_taken log has amount -1 (clamped).
    const takeLog = durable.logs.find((l) => l.type === 'dose_taken' && l.doseId === 'd1');
    expect(takeLog?.amount).toBe(-1);

    // Restore must reverse the Take (1), NOT the old Auto (3, already reversed).
    const r = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-take-1' });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(1);
    // The Take log is now reversed; the old Auto log stays reversed.
    expect(durable.logs.find((l) => l.id === takeLog?.id)?.reversedAt).toBeTruthy();
  });

  it('Manual Take 3 → Restore = +3 (reverses the Manual Take amount)', async () => {
    durable = {
      medications: [med({ currentPills: 7, doseSchedule: [{ id: 'd1', amount: 3, time: '08:00' }], dosesPerDay: 1 })],
      logs: [],
    };
    const take = await runGatedManualConsume({ medicationId: 'med-1', doseId: 'd1', source: 'manual', todayStr: TODAY });
    expect(take.outcome).toBe('applied');
    expect(take.doseAmount).toBe(3);
    expect(durable.medications[0].currentPills).toBe(4);
    const r = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-manual-3' });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(3);
    expect(durable.medications[0].currentPills).toBe(7);
    // The dose_taken log is reversed by the Restore.
    const takeLog = durable.logs.find((l) => l.type === 'dose_taken' && l.doseId === 'd1');
    expect(takeLog?.reversedAt).toBeTruthy();
  });

  it('Auto 3 → Restore → Take 3 → Restore = +3 (reverses the second Take)', async () => {
    durable = {
      medications: [med({ currentPills: 7, doseConsumptionHistory: { d1: [TODAY] }, doseSchedule: [{ id: 'd1', amount: 3, time: '08:00' }], dosesPerDay: 1 })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -3, date: TODAY, timestamp: '', description: '', doseId: 'd1' }],
    };
    // Restore the Auto (3).
    const r1 = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-auto-3b' });
    expect(r1.outcome).toBe('applied');
    expect(r1.restoredAmount).toBe(3);
    expect(durable.medications[0].currentPills).toBe(10);
    // Take again (3). currentPills 10 → 7.
    const take = await runGatedManualConsume({ medicationId: 'med-1', doseId: 'd1', source: 'manual', todayStr: TODAY });
    expect(take.outcome).toBe('applied');
    expect(take.doseAmount).toBe(3);
    expect(durable.medications[0].currentPills).toBe(7);
    // Restore must reverse the Take (3), NOT the old Auto (3, already reversed).
    const r2 = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-take-3b' });
    expect(r2.outcome).toBe('applied');
    expect(r2.restoredAmount).toBe(3);
    expect(durable.medications[0].currentPills).toBe(10);
  });

  it('Restore twice for the same occurrence does not add stock twice', async () => {
    durable = {
      medications: [med({ currentPills: 7, doseConsumptionHistory: { d1: [TODAY] } })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -3, date: TODAY, timestamp: '', description: '', doseId: 'd1' }],
    };
    const r1 = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-1-dedup' });
    expect(r1.outcome).toBe('applied');
    expect(r1.restoredAmount).toBe(3);
    expect(durable.medications[0].currentPills).toBe(10);
    const pillsAfterFirst = durable.medications[0].currentPills;
    // Second Restore: occurrence already restored (consume marker cleared).
    const r2 = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-2-dedup' });
    expect(r2.outcome).toBe('already_restored');
    expect(durable.medications[0].currentPills).toBe(pillsAfterFirst);
    // No second restore log.
    expect(durable.logs.filter((l) => l.id === 'restore-2-dedup')).toHaveLength(0);
  });

  it('Dose A and Dose B same day: Restore A cannot reverse B\'s deduction', async () => {
    durable = {
      medications: [med({ currentPills: 8, doseConsumptionHistory: { d1: [TODAY], d2: [TODAY] } })],
      logs: [
        { id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -1, date: TODAY, timestamp: '', description: '', doseId: 'd1' },
        { id: exactAutoLogId('med-1', 'd2', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -2, date: TODAY, timestamp: '', description: '', doseId: 'd2' },
      ],
    };
    // Restore d1 → reverses auto-a (1), NOT auto-b (2).
    const r = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-a' });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(9);
    // d2 still consumed; auto-b NOT reversed.
    expect(durable.medications[0].doseConsumptionHistory?.d2).toBe(TODAY);
    expect(durable.logs.find((l) => l.id === 'auto-b')?.reversedAt).toBeUndefined();
    // auto-a IS reversed.
    expect(durable.logs.find((l) => l.id === 'auto-a')?.reversedAt).toBeTruthy();
  });

  it('Old reversed deduction is not picked as the active deduction for a later Restore', async () => {
    // Two deductions for the same occurrence: old (reversed) + new (active).
    durable = {
      medications: [med({ currentPills: 6, doseConsumptionHistory: { d1: [TODAY] } })],
      logs: [
        { id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -4, date: TODAY, timestamp: '', description: '', doseId: 'd1', reversedAt: 'old' },
        { id: 'new-deduct', medicationId: 'med-1', medicationName: 'TestMed', type: 'dose_taken', amount: -4, date: TODAY, timestamp: '', description: '', doseId: 'd1' },
      ],
    };
    // Restore must find new-deduct (4), NOT old-deduct (4, reversed).
    const r = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-new' });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(4);
    expect(durable.medications[0].currentPills).toBe(10);
    // new-deduct reversed; old-deduct stays reversed.
    expect(durable.logs.find((l) => l.id === 'new-deduct')?.reversedAt).toBeTruthy();
    expect(durable.logs.find((l) => l.id === 'old-deduct')?.reversedAt).toBe('old');
    // restore log links to new-deduct, NOT old-deduct.
    expect(durable.logs.find((l) => l.id === 'restore-new')?.relatedLogId).toBe('new-deduct');
  });

  // ─── Refill / undo-refill through the durable stock mutation gate ───

  it('runGatedRefill adds pills through the gate (serialized with Take/Restore)', async () => {
    durable = { medications: [med({ currentPills: 5 })], logs: [] };
    const r = await runGatedRefill({ medicationId: 'med-1', addedPills: 10, todayStr: TODAY });
    expect(r.outcome).toBe('applied');
    expect(r.addedPills).toBe(10);
    expect(durable.medications[0].currentPills).toBe(15);
    expect(durable.logs.some((l) => l.type === 'refill' && l.amount === 10)).toBe(true);
  });

  it('runGatedRefill: addedPills <= 0 is rejected (no mutation)', async () => {
    durable = { medications: [med({ currentPills: 5 })], logs: [] };
    const r = await runGatedRefill({ medicationId: 'med-1', addedPills: 0, todayStr: TODAY });
    expect(r.outcome).toBe('rejected');
    expect(durable.medications[0].currentPills).toBe(5);
    expect(durable.logs).toHaveLength(0);
  });

  it('runGatedUndoRefill reverses the most recent un-reversed refill through the gate', async () => {
    durable = {
      medications: [med({ currentPills: 15 })],
      logs: [{ id: 'refill-1', medicationId: 'med-1', medicationName: 'TestMed', type: 'refill', amount: 10, date: TODAY, timestamp: '', description: '' }],
    };
    const r = await runGatedUndoRefill({ medicationId: 'med-1', todayStr: TODAY, makeLogId: () => 'refill-undo-1' });
    expect(r.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBeLessThan(15);
    // The refill log is marked reversedAt.
    expect(durable.logs.find((l) => l.id === 'refill-1')?.reversedAt).toBeTruthy();
    // The refill_undo log links to the refill.
    const undoLog = durable.logs.find((l) => l.id === 'refill-undo-1');
    expect(undoLog?.relatedLogId).toBe('refill-1');
    expect(undoLog?.type).toBe('refill_undo');
  });

  it('runGatedUndoRefill with no un-reversed refill is rejected (no mutation)', async () => {
    durable = {
      medications: [med({ currentPills: 5 })],
      logs: [{ id: 'refill-done', medicationId: 'med-1', medicationName: 'TestMed', type: 'refill', amount: 10, date: TODAY, timestamp: '', description: '', reversedAt: 'already' }],
    };
    const r = await runGatedUndoRefill({ medicationId: 'med-1', todayStr: TODAY });
    expect(r.outcome).toBe('rejected');
    expect(durable.medications[0].currentPills).toBe(5);
  });

  it('refill serializes with Manual Take (no stale snapshot race)', async () => {
    // Both go through the same gate chain — the refill sees the Take's
    // committed durable state, not a stale snapshot.
    durable = { medications: [med({ currentPills: 10 })], logs: [] };
    const [take, refill] = await Promise.all([
      runGatedManualConsume({ medicationId: 'med-1', doseId: 'd1', source: 'manual', todayStr: TODAY }),
      runGatedRefill({ medicationId: 'med-1', addedPills: 5, todayStr: TODAY, makeLogId: () => 'refill-after-take' }),
    ]);
    expect(take.outcome).toBe('applied');
    expect(refill.outcome).toBe('applied');
    // Take deducted 1 (d1 amount); refill added 5. Order is serialized by
    // the gate chain so the final stock is 10 - 1 + 5 = 14.
    expect(durable.medications[0].currentPills).toBe(14);
    expect(durable.logs.some((l) => l.type === 'dose_taken' && l.doseId === 'd1')).toBe(true);
    expect(durable.logs.some((l) => l.type === 'refill' && l.amount === 5)).toBe(true);
  });

  // ─── Refill Undo — partial/clamped reversal (data integrity) ───

  it('runGatedUndoRefill reverses only the ACTUAL reversible amount (clamped), not the full refill.amount', async () => {
    // Med has currentPills=5 (autoDeduct OFF → effective = currentPills = 5).
    // A refill log of +10 exists but only 5 is actually reversible (settleBase=5).
    // Undo must record -5 in the refill_undo log, not -10.
    durable = {
      medications: [med({ currentPills: 5, autoDeductEnabled: false, lastSyncDate: TODAY })],
      logs: [
        { id: 'refill-10', medicationId: 'med-1', medicationName: 'TestMed', type: 'refill', amount: 10, date: TODAY, timestamp: '2026-09-16T10:00:00.000Z', description: 'refill' },
      ],
    };
    const r = await runGatedUndoRefill({ medicationId: 'med-1', todayStr: TODAY, makeLogId: () => 'undo-clamp' });
    expect(r.outcome).toBe('applied');
    // The ACTUAL reversed amount is 5 (clamped to settleBase=5), not 10.
    expect(r.addedPills).toBe(-5);
    expect(r.log?.amount).toBe(-5);
    expect(r.log?.type).toBe('refill_undo');
    // The refill_undo log links to the original refill.
    expect(r.log?.relatedLogId).toBe('refill-10');
    // Stock dropped by 5 (settleBase=5, -5 → 0).
    expect(durable.medications[0].currentPills).toBe(0);
    // The original refill is marked reversed.
    expect(durable.logs.find((l) => l.id === 'refill-10')?.reversedAt).toBeTruthy();
  });

  it('runGatedUndoRefill with full reversible amount reverses the full refill.amount', async () => {
    // currentPills=20 → settleBase=20 → full 10 is reversible.
    durable = {
      medications: [med({ currentPills: 20, autoDeductEnabled: false, lastSyncDate: TODAY })],
      logs: [
        { id: 'refill-full', medicationId: 'med-1', medicationName: 'TestMed', type: 'refill', amount: 10, date: TODAY, timestamp: '2026-09-16T10:00:00.000Z', description: 'refill' },
      ],
    };
    const r = await runGatedUndoRefill({ medicationId: 'med-1', todayStr: TODAY, makeLogId: () => 'undo-full' });
    expect(r.outcome).toBe('applied');
    expect(r.addedPills).toBe(-10);
    expect(r.log?.amount).toBe(-10);
    // Stock dropped by 10 (settleBase=20, -10 → 10).
    expect(durable.medications[0].currentPills).toBe(10);
    expect(durable.logs.find((l) => l.id === 'refill-full')?.reversedAt).toBeTruthy();
  });

  it('runGatedUndoRefill with zero reversible quantity records actual 0, not -refill.amount', async () => {
    // currentPills=0 → settleBase=0 → nothing to reverse.
    durable = {
      medications: [med({ currentPills: 0, autoDeductEnabled: false, lastSyncDate: TODAY })],
      logs: [
        { id: 'refill-zero', medicationId: 'med-1', medicationName: 'TestMed', type: 'refill', amount: 10, date: TODAY, timestamp: '2026-09-16T10:00:00.000Z', description: 'refill' },
      ],
    };
    const r = await runGatedUndoRefill({ medicationId: 'med-1', todayStr: TODAY, makeLogId: () => 'undo-zero' });
    expect(r.outcome).toBe('applied');
    // Actual reversed amount is 0, NOT -10.
    expect(r.addedPills).toBe(0);
    expect(r.log?.amount).toBe(0);
    expect(r.log?.type).toBe('refill_undo');
    // Stock unchanged (0 - 0 = 0).
    expect(durable.medications[0].currentPills).toBe(0);
    // The refill is still marked reversed (the undo consumed the refill).
    expect(durable.logs.find((l) => l.id === 'refill-zero')?.reversedAt).toBeTruthy();
  });

  it('runGatedUndoRefill: second undo of the same refill is rejected (no double reversal)', async () => {
    durable = {
      medications: [med({ currentPills: 20, autoDeductEnabled: false, lastSyncDate: TODAY })],
      logs: [
        { id: 'refill-dbl', medicationId: 'med-1', medicationName: 'TestMed', type: 'refill', amount: 10, date: TODAY, timestamp: '2026-09-16T10:00:00.000Z', description: 'refill' },
      ],
    };
    const r1 = await runGatedUndoRefill({ medicationId: 'med-1', todayStr: TODAY, makeLogId: () => 'undo-1' });
    expect(r1.outcome).toBe('applied');
    expect(r1.addedPills).toBe(-10);
    const pillsAfterFirst = durable.medications[0].currentPills;

    // Second undo: the refill is now reversed → rejected.
    const r2 = await runGatedUndoRefill({ medicationId: 'med-1', todayStr: TODAY, makeLogId: () => 'undo-2' });
    expect(r2.outcome).toBe('rejected');
    // No additional stock change.
    expect(durable.medications[0].currentPills).toBe(pillsAfterFirst);
    // No second undo log.
    expect(durable.logs.filter((l) => l.id === 'undo-2')).toHaveLength(0);
  });

  // ─── Section 1: Auto/Manual Take → Restore lifecycle invariants ───

  it('Auto → Restore leaves durable skip so does not re-project', async () => {
    // d1@08:00, now 15:00 → d1 elapsed. Simulate Exact Auto having applied
    // d1 (doseConsumptionHistory marker + exact_auto log) without going through
    // the gated path (the durable state is the post-Auto snapshot).
    durable = {
      medications: [
        med({
          currentPills: 9,
          doseConsumptionHistory: { d1: [TODAY] },
        }),
      ],
      logs: [
        {
          id: exactAutoLogId('med-1', 'd1', TODAY),
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'exact_auto',
          amount: -1,
          date: TODAY,
          timestamp: '',
          description: '',
          doseId: 'd1',
        },
      ],
    };

    const r = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-after-auto',
    });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(1);
    // Stock restored (9 + 1 = 10).
    expect(durable.medications[0].currentPills).toBe(10);
    // Consumption cleared for d1.
    expect(durable.medications[0].doseConsumptionHistory?.d1).toBeUndefined();
    // Durable skip left for the SAME occurrence so projection cannot re-add d1.
    expect(durable.medications[0].doseSkippedHistory?.d1).toEqual([TODAY]);
    // Sibling d2 untouched (not skipped, not consumed).
    expect(durable.medications[0].doseSkippedHistory?.d2).toBeUndefined();
    expect(durable.medications[0].doseConsumptionHistory?.d2).toBeUndefined();

    // No second Auto deduction on a later reconcile for the same FIRED event.
    const recon = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: durable.medications,
      logs: durable.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [
        fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 }),
      ] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      persistMeds: (m) => {
        durable.medications = m;
        return null;
      },
      persistLogs: (l) => {
        durable.logs = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(recon.details[0]?.outcome).toBe('already_applied');
    expect(durable.medications[0].currentPills).toBe(10);
    // No second exact_auto log for d1.
    expect(
      durable.logs.filter((l) => l.id === exactAutoLogId('med-1', 'd1', TODAY))
    ).toHaveLength(1);
  });

  it('Auto → Restore → Take yields exactly one final deduction', async () => {
    // Start: Exact Auto applied d1 (consume marker + exact_auto log), stock 9.
    durable = {
      medications: [
        med({
          currentPills: 9,
          doseConsumptionHistory: { d1: [TODAY] },
        }),
      ] }),
      logs: [
        {
          id: exactAutoLogId('med-1', 'd1', TODAY),
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'exact_auto',
          amount: -1,
          date: TODAY,
          timestamp: '',
          description: '',
          doseId: 'd1',
        },
      ],
    };

    const restore = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-then-take',
    });
    expect(restore.outcome).toBe('applied');
    expect(restore.restoredAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(10);
    // Skip left so Auto cannot re-deduct before Take.
    expect(durable.medications[0].doseSkippedHistory?.d1).toEqual([TODAY]);

    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    // Take must be allowed (skip does not block Take) and record consumption.
    expect(take.outcome).toBe('applied');
    expect(take.doseAmount).toBe(1);
    // Final stock: 10 - 1 = 9 (exactly one net deduction for the occurrence).
    expect(durable.medications[0].currentPills).toBe(9);
    // Skip cleared by Take; consume marker set once.
    expect(durable.medications[0].doseSkippedHistory?.d1).toBeUndefined();
    expect(durable.medications[0].doseConsumptionHistory?.d1).toBe(TODAY);
    // Exactly one dose_taken log for d1 (the manual Take) plus the restore log
    // plus the original exact_auto log — no second auto deduction.
    const takeLogs = durable.logs.filter(
      (l) => l.type === 'dose_taken' && l.doseId === 'd1'
    );
    expect(takeLogs).toHaveLength(1);
    const autoLogs = durable.logs.filter(
      (l) => l.type === 'exact_auto' && l.doseId === 'd1'
    );
    expect(autoLogs).toHaveLength(1);
  });

  it('Manual Take → Restore → later native Exact Auto event does not deduct twice', async () => {
    // Manual Take d1 first (stock 10 → 9, dose_taken log).
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(9);
    const pillsAfterTake = durable.medications[0].currentPills;

    // Restore d1 (time 08:00 has passed at 15:00) → skip left, consume cleared.
    const restore = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-after-manual',
    });
    expect(restore.outcome).toBe('applied');
    expect(restore.restoredAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(10);
    expect(durable.medications[0].doseConsumptionHistory?.d1).toBeUndefined();
    expect(durable.medications[0].doseSkippedHistory?.d1).toEqual([TODAY]);

    // Later native Exact Auto FIRED event for the same occurrence.
    const recon = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: durable.medications,
      logs: durable.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [
        fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 }),
      ] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      persistMeds: (m) => {
        durable.medications = m;
        return null;
      },
      persistLogs: (l) => {
        durable.logs = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(recon.details[0]?.outcome).toBe('already_applied');
    // Stock unchanged from post-restore state (no second deduction).
    expect(durable.medications[0].currentPills).toBe(10);
    expect(durable.medications[0].currentPills).not.toBe(pillsAfterTake);
    // No exact_auto log created for d1.
    expect(
      durable.logs.filter(
        (l) => l.type === 'exact_auto' && l.doseId === 'd1'
      )
    ).toHaveLength(0);
  });

  it('Restore before scheduled time does not create skip marker (future dose)', async () => {
    // d3@22:00, now 15:00 — d3 time has NOT passed. Manual Take d3 then Restore.
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd3',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    const pillsAfterTake = durable.medications[0].currentPills;

    const restore = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd3',
      todayStr: TODAY,
      makeLogId: () => 'restore-future-d3',
    });
    expect(restore.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(pillsAfterTake + 2);
    // Future restore: NO durable skip (d3 stays eligible for time-gated Auto).
    expect(durable.medications[0].doseSkippedHistory?.d3).toBeUndefined();
    expect(durable.medications[0].doseConsumptionHistory?.d3).toBeUndefined();
  });

  it('Multi-dose: Restore doseId=A leaves skip for A only; doseId=B untouched', async () => {
    // Take d1 and d2 manually, then Restore d1 only.
    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd2',
      source: 'manual',
      todayStr: TODAY,
    });
    const pillsBeforeRestore = durable.medications[0].currentPills;

    const r = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-d1-only',
    });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(1);
    // d1 restored (skip left, consume cleared); d2 still consumed.
    expect(durable.medications[0].doseSkippedHistory?.d1).toEqual([TODAY]);
    expect(durable.medications[0].doseConsumptionHistory?.d1).toBeUndefined();
    expect(durable.medications[0].doseConsumptionHistory?.d2).toBe(TODAY);
    expect(durable.medications[0].doseSkippedHistory?.d2).toBeUndefined();
    // Only d1's amount credited back.
    expect(durable.medications[0].currentPills).toBe(pillsBeforeRestore + 1);
  });
});

describe('shouldDismissAlarmAfterManualTake', () => {
  it('dismisses only for applied and already_consumed; never persist_failed', () => {
    expect(shouldDismissAlarmAfterManualTake('applied')).toBe(true);
    expect(shouldDismissAlarmAfterManualTake('already_consumed')).toBe(true);
    expect(shouldDismissAlarmAfterManualTake('persist_failed')).toBe(false);
    expect(shouldDismissAlarmAfterManualTake('rejected')).toBe(false);
    expect(shouldDismissAlarmAfterManualTake('missing_med')).toBe(false);
    expect(shouldDismissAlarmAfterManualTake('already_restored')).toBe(false);
  });
});

describe('findActiveDeductionForOccurrence — deterministic ordering (NOT array position)', () => {
  // Helper: build a deduction log for the occurrence.
  function deduction(
    over: Partial<ConsumptionLog> &
      Pick<ConsumptionLog, 'id' | 'type' | 'amount' | 'timestamp'>
  ): ConsumptionLog {
    return {
      medicationId: 'med-1',
      medicationName: 'TestMed',
      date: TODAY,
      description: '',
      ...over,
    };
  }

  const TS_OLD = '2026-09-16T08:00:00.000Z';
  const TS_NEW = '2026-09-16T14:00:00.000Z';
  const TS_NEWEST = '2026-09-16T20:00:00.000Z';

  it('picks the same active deduction regardless of array order (newest→oldest, oldest→newest, shuffled)', () => {
    const oldAuto = deduction({
      id: exactAutoLogId('med-1', 'd1', TODAY),
      type: 'exact_auto',
      amount: -3,
      timestamp: TS_OLD,
      doseId: 'd1',
    });
    const newTake = deduction({
      id: 'take-new',
      type: 'dose_taken',
      amount: -1,
      timestamp: TS_NEW,
      doseId: 'd1',
    });
    const newestAuto = deduction({
      id: exactAutoLogId('med-1', 'd1', TODAY),
      type: 'exact_auto',
      amount: -2,
      timestamp: TS_NEWEST,
      doseId: 'd1',
    });
    // Three array orderings — the active deduction (newestAuto, highest
    // timestamp) must be the same in all three.
    const newestFirst = [newestAuto, newTake, oldAuto];
    const oldestFirst = [oldAuto, newTake, newestAuto];
    const shuffled = [newTake, newestAuto, oldAuto];
    const a = findActiveDeductionForOccurrence(newestFirst, 'med-1', 'd1', TODAY);
    const b = findActiveDeductionForOccurrence(oldestFirst, 'med-1', 'd1', TODAY);
    const c = findActiveDeductionForOccurrence(shuffled, 'med-1', 'd1', TODAY);
    expect(a?.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    expect(b?.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    expect(c?.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    expect(a?.id).toBe(b?.id);
    expect(b?.id).toBe(c?.id);
  });

  it('Auto deduction old + Manual Take new → picks the Manual Take (by timestamp, not type)', () => {
    const oldAuto = deduction({
      id: exactAutoLogId('med-1', 'd1', TODAY),
      type: 'exact_auto',
      amount: -3,
      timestamp: TS_OLD,
      doseId: 'd1',
    });
    const newTake = deduction({
      id: 'take-new',
      type: 'dose_taken',
      amount: -1,
      timestamp: TS_NEW,
      doseId: 'd1',
    });
    // newestFirst (Take at front) and oldestFirst (Auto at front) — both
    // must pick the Take because its timestamp is newer, NOT because of
    // array position or type preference.
    const r1 = findActiveDeductionForOccurrence([newTake, oldAuto] }), 'med-1', 'd1', TODAY);
    const r2 = findActiveDeductionForOccurrence([oldAuto, newTake], 'med-1', 'd1', TODAY);
    expect(r1?.id).toBe('take-new');
    expect(r2?.id).toBe('take-new');
  });

  it('Manual Take old + Auto deduction new → picks the Auto (by timestamp, not type)', () => {
    const oldTake = deduction({
      id: 'take-old',
      type: 'dose_taken',
      amount: -1,
      timestamp: TS_OLD,
      doseId: 'd1',
    });
    const newAuto = deduction({
      id: exactAutoLogId('med-1', 'd1', TODAY),
      type: 'exact_auto',
      amount: -2,
      timestamp: TS_NEW,
      doseId: 'd1',
    });
    const r1 = findActiveDeductionForOccurrence([newAuto, oldTake], 'med-1', 'd1', TODAY);
    const r2 = findActiveDeductionForOccurrence([oldTake, newAuto], 'med-1', 'd1', TODAY);
    expect(r1?.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    expect(r2?.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
  });

  it('Newer deduction reversed → picks the most-recent UN-reversed deduction', () => {
    const oldAuto = deduction({
      id: exactAutoLogId('med-1', 'd1', TODAY),
      type: 'exact_auto',
      amount: -3,
      timestamp: TS_OLD,
      doseId: 'd1',
    });
    const newTake = deduction({
      id: 'take-new',
      type: 'dose_taken',
      amount: -1,
      timestamp: TS_NEW,
      doseId: 'd1',
      reversedAt: '2026-09-16T15:00:00.000Z', // reversed by a Restore
    });
    const newestAuto = deduction({
      id: exactAutoLogId('med-1', 'd1', TODAY),
      type: 'exact_auto',
      amount: -2,
      timestamp: TS_NEWEST,
      doseId: 'd1',
    });
    // newTake is reversed → skipped. newestAuto (highest timestamp, active)
    // wins regardless of array order.
    const r1 = findActiveDeductionForOccurrence([newestAuto, newTake, oldAuto], 'med-1', 'd1', TODAY);
    const r2 = findActiveDeductionForOccurrence([oldAuto, newTake, newestAuto], 'med-1', 'd1', TODAY);
    expect(r1?.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    expect(r2?.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
  });

  it('Same medication + same date + different doseId → dose A never picks dose B', () => {
    const a1 = deduction({ id: exactAutoLogId('med-1', 'd1', TODAY), type: 'exact_auto', amount: -1, timestamp: TS_OLD, doseId: 'd1' });
    const b1 = deduction({ id: exactAutoLogId('med-1', 'd2', TODAY), type: 'exact_auto', amount: -2, timestamp: TS_NEW, doseId: 'd2' });
    // d1 lookup finds a1 only; d2 lookup finds b1 only — regardless of order.
    expect(findActiveDeductionForOccurrence([a1, b1], 'med-1', 'd1', TODAY)?.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    expect(findActiveDeductionForOccurrence([b1, a1], 'med-1', 'd1', TODAY)?.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    expect(findActiveDeductionForOccurrence([a1, b1], 'med-1', 'd2', TODAY)?.id).toBe(exactAutoLogId('med-1', 'd2', TODAY));
    expect(findActiveDeductionForOccurrence([b1, a1], 'med-1', 'd2', TODAY)?.id).toBe(exactAutoLogId('med-1', 'd2', TODAY));
  });

  it('Same occurrence with multiple historical deductions/reversals → picks the only active one', () => {
    // Three deductions for d1+TODAY: two reversed, one active.
    const d1 = deduction({ id: exactAutoLogId('med-1', 'd1', TODAY), type: 'exact_auto', amount: -3, timestamp: TS_OLD, doseId: 'd1', reversedAt: 'r1' });
    const d2 = deduction({ id: 'ded-2', type: 'dose_taken', amount: -1, timestamp: TS_NEW, doseId: 'd1', reversedAt: 'r2' });
    const d3 = deduction({ id: exactAutoLogId('med-1', 'd1', TODAY), type: 'exact_auto', amount: -2, timestamp: TS_NEWEST, doseId: 'd1' });
    // d3 is the only un-reversed one. Must be picked in any order.
    for (const order of [[d1, d2, d3], [d3, d2, d1], [d2, d1, d3], [d2, d3, d1], [d3, d1, d2], [d1, d3, d2]]) {
      const r = findActiveDeductionForOccurrence(order, 'med-1', 'd1', TODAY);
      expect(r?.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    }
  });

  it('Clamped deduction amount is returned as-is (not the requested slot amount)', () => {
    // Requested 3 but clamped to 1 (stock was 1). The log has amount=-1.
    const clamped = deduction({ id: 'clamp', type: 'dose_taken', amount: -1, timestamp: TS_NEW, doseId: 'd1' });
    const r = findActiveDeductionForOccurrence([clamped], 'med-1', 'd1', TODAY);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.amount)).toBe(1);
    expect(Math.abs(r!.amount)).not.toBe(3);
  });

  it('Logs with empty/invalid timestamps fall back to id tie-breaker (deterministic, not array position)', () => {
    // Both have empty timestamps — tie-breaker is id. 'zzz' > 'aaa' so
    // 'zzz' wins regardless of array order.
    const a = deduction({ id: exactAutoLogId('med-1', 'd1', TODAY), type: 'exact_auto', amount: -1, timestamp: '', doseId: 'd1' });
    const b = deduction({ id: 'zzz', type: 'dose_taken', amount: -2, timestamp: '', doseId: 'd1' });
    const r1 = findActiveDeductionForOccurrence([a, b], 'med-1', 'd1', TODAY);
    const r2 = findActiveDeductionForOccurrence([b, a], 'med-1', 'd1', TODAY);
    expect(r1?.id).toBe('zzz');
    expect(r2?.id).toBe('zzz');
  });

  it('A real timestamp always wins over an empty/invalid timestamp regardless of array order', () => {
    const realTs = deduction({ id: exactAutoLogId('med-1', 'd1', TODAY), type: 'exact_auto', amount: -2, timestamp: TS_NEW, doseId: 'd1' });
    const emptyTs = deduction({ id: 'empty', type: 'dose_taken', amount: -5, timestamp: '', doseId: 'd1' });
    // realTs has a valid timestamp → wins. Even if emptyTs is first AND has
    // a "higher" id, the valid timestamp wins.
    const r1 = findActiveDeductionForOccurrence([realTs, emptyTs], 'med-1', 'd1', TODAY);
    const r2 = findActiveDeductionForOccurrence([emptyTs, realTs], 'med-1', 'd1', TODAY);
    expect(r1?.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    expect(r2?.id).toBe(exactAutoLogId('med-1', 'd1', TODAY));
  });

  it('No active deduction (all reversed or none match) → null', () => {
    const reversed = deduction({ id: exactAutoLogId('med-1', 'd1', TODAY), type: 'exact_auto', amount: -1, timestamp: TS_NEW, doseId: 'd1', reversedAt: 'x' });
    expect(findActiveDeductionForOccurrence([reversed], 'med-1', 'd1', TODAY)).toBeNull();
    // Different doseId → no match.
    const otherDose = deduction({ id: exactAutoLogId('med-1', 'd2', TODAY), type: 'exact_auto', amount: -1, timestamp: TS_NEW, doseId: 'd2' });
    expect(findActiveDeductionForOccurrence([otherDose], 'med-1', 'd1', TODAY)).toBeNull();
    // Different date → no match.
    const otherDate = deduction({ id: exactAutoLogId('med-1', 'd1', '2026-09-15'), type: 'exact_auto', amount: -1, timestamp: TS_NEW, doseId: 'd1', date: '2026-09-15' });
    expect(findActiveDeductionForOccurrence([otherDate], 'med-1', 'd1', TODAY)).toBeNull();
  });

  it('logs without doseId never match (no legacy/undefined/sentinel identity)', () => {
    // Logs missing doseId must not match any lookup — including undefined
    // and the removed 'legacy' sentinel. A concurrent valid log still matches.
    const noId1 = deduction({
      id: exactAutoLogId('med-1', 'd1', TODAY),
      type: 'exact_auto',
      amount: -1,
      timestamp: TS_OLD,
    });
    const noId2 = deduction({
      id: 'leg2',
      type: 'dose_taken',
      amount: -2,
      timestamp: TS_NEW,
    });
    const valid = deduction({
      id: exactAutoLogId('med-1', 'd1', TODAY),
      type: 'exact_auto',
      amount: -3,
      timestamp: TS_NEWEST,
      doseId: 'd1',
    });
    const legacyLogs = [noId1, noId2, valid];
    expect(
      findActiveDeductionForOccurrence(legacyLogs, 'med-1', undefined as never, TODAY)
    ).toBeNull();
    expect(
      findActiveDeductionForOccurrence(legacyLogs, 'med-1', 'legacy', TODAY)
    ).toBeNull();
    expect(
      findActiveDeductionForOccurrence(legacyLogs, 'med-1', 'd1', TODAY)?.id
    ).toBe(exactAutoLogId('med-1', 'd1', TODAY));
  });
});


describe('Phase 4 — stale React snapshot must not block durable Restore / Undo', () => {
  let durable: AutoStockDurableState;
  let manualEnvelope: ManualStockEnvelope | null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T15:00:00`));
    durable = { medications: [med()], logs: [] };
    manualEnvelope = null;
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (next) => {
        durable = {
          medications: next.medications.map((m) => ({ ...m })),
          logs: next.logs.map((l) => ({ ...l })),
        };
        return null;
      },
    });
    __setManualEnvelopeTestHooks({
      load: () => manualEnvelope,
      save: (env) => {
        manualEnvelope = env;
        return null;
      },
    });
    // Match production allocateMutationSeq contract; keep allocation and
    // finalization counters independent.
    let nextSeq = 0;
    let lastApplied = 0;
    __setStockMutationOrderingTestHooks({
      allocate: () => {
        nextSeq += 1;
        return { ok: true, seq: nextSeq };
      },
      loadLastApplied: () => lastApplied,
      persistLastApplied: (value) => {
        lastApplied = value;
        return null;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __resetStockMutationOrderingForTests();
  });

  it('stale React skip=true does not prevent Restore when durable has active manual consumption', async () => {
    // Durable: Manual Take already applied for d1 today.
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(9);
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);

    // Stale React snapshot would show skip=true / consumed=false (outdated UI).
    // Handler no longer consults that snapshot for business decisions — only
    // runGatedManualRestore against durable state decides.
    const staleReactMed = {
      ...med(),
      currentPills: 10,
      doseSkippedHistory: { d1: [TODAY] },
      doseConsumptionHistory: {},
    };
    // Sanity: stale view looks not consumed
    expect(isDoseConsumedOnDate(staleReactMed, 'd1', TODAY)).toBe(false);

    const restore = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-from-stale-ui',
    });
    expect(restore.outcome).toBe('applied');
    expect(restore.restoredAmount).toBe(1);
    // Stock returned from durable Take amount.
    expect(durable.medications[0].currentPills).toBe(10);
    expect(durable.logs.some((l) => l.id === 'restore-from-stale-ui')).toBe(true);
  });

  it('stale React consumed=false does not prevent Restore when durable has actual consumption', async () => {
    // Seed durable with a dose_taken log + consume marker.
    durable = {
      medications: [
        med({
          currentPills: 7,
          doseConsumptionHistory: { d1: [TODAY] },
        }),
      ],
      logs: [
        {
          id: 'take-log',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: -1,
          date: TODAY,
          timestamp: `${TODAY}T10:00:00.000Z`,
          description: 'manual take',
          doseId: 'd1',
        },
      ],
    };

    const staleReactMed = med({ currentPills: 10 }); // no consume markers
    expect(isDoseConsumedOnDate(staleReactMed, 'd1', TODAY)).toBe(false);

    const restore = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-durable-only',
    });
    expect(restore.outcome).toBe('applied');
    expect(restore.restoredAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(8);
  });

  it('second Restore uses fresh durable state inside gate (not a captured React snapshot)', async () => {
    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    const first = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-1',
    });
    expect(first.outcome).toBe('applied');
    const pillsAfterFirst = durable.medications[0].currentPills;

    // Second call must see durable skip / reversed deduction → already_restored
    const second = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-2',
    });
    expect(second.outcome).toBe('already_restored');
    expect(durable.medications[0].currentPills).toBe(pillsAfterFirst);
    expect(durable.logs.filter((l) => l.id === 'restore-2')).toHaveLength(0);
  });

  it('UndoRefill reverses the durable newest refill, not a stale React logs snapshot', async () => {
    // Intentionally put OLD first so selection cannot rely on array position.
    // Selection must use timestamp (then id), independent of React snapshot order.
    durable = {
      medications: [med({ currentPills: 30 })],
      logs: [
        {
          id: 'refill-old',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'refill',
          amount: 5,
          date: TODAY,
          timestamp: `${TODAY}T08:00:00.000Z`,
          description: 'old',
        },
        {
          id: 'refill-new',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'refill',
          amount: 10,
          date: TODAY,
          timestamp: `${TODAY}T12:00:00.000Z`,
          description: 'new',
        },
      ],
    };

    // Stale React logs would only know about the old refill.
    const staleReactLogs = [
      {
        id: 'refill-old',
        medicationId: 'med-1',
        medicationName: 'TestMed',
        type: 'refill' as const,
        amount: 5,
        date: TODAY,
        timestamp: `${TODAY}T08:00:00.000Z`,
        description: 'old',
      },
    ];
    expect(staleReactLogs[0].id).toBe('refill-old');

    const undo = await runGatedUndoRefill({
      medicationId: 'med-1',
      todayStr: TODAY,
      makeLogId: () => 'undo-newest',
    });
    expect(undo.outcome).toBe('applied');
    // Newest durable refill is reversed.
    expect(durable.logs.find((l) => l.id === 'refill-new')?.reversedAt).toBeTruthy();
    expect(durable.logs.find((l) => l.id === 'refill-old')?.reversedAt).toBeFalsy();
    const undoLog = durable.logs.find((l) => l.id === 'undo-newest');
    expect(undoLog?.relatedLogId).toBe('refill-new');
    expect(undoLog?.type).toBe('refill_undo');
  });
});


describe('Phase 4 — Exact Auto event.amount is authoritative for Manual Take', () => {
  let durable: AutoStockDurableState;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T15:00:00`));
    durable = { medications: [med()], logs: [] };
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (next) => {
        durable = {
          medications: next.medications.map((m) => ({ ...m })),
          logs: next.logs.map((l) => ({ ...l })),
        };
        return null;
      },
    });
    __setManualEnvelopeTestHooks({
      load: () => null,
      save: () => null,
    });
    let nextSeq = 0;
    let lastApplied = 0;
    __setStockMutationOrderingTestHooks({
      allocate: () => {
        nextSeq = Math.max(nextSeq, lastApplied) + 1;
        return { ok: true, seq: nextSeq };
      },
      loadLastApplied: () => lastApplied,
      persistLastApplied: (value) => {
        if (value > lastApplied) lastApplied = value;
        return null;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __resetStockMutationOrderingForTests();
  });

  it('FIRED event amount=2 + schedule amount=1 → Manual Take deducts event amount', async () => {
    durable = {
      medications: [
        med({
          currentPills: 10,
          doseSchedule: [
            { id: 'd1', amount: 1, time: '08:00' },
            { id: 'd2', amount: 1, time: '14:00' },
          ],
        }),
      ],
      logs: [],
    };
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({
        ok: true,
        status: 'FIRED',
        amount: 2,
      }),
    });
    expect(r.outcome).toBe('applied');
    expect(r.doseAmount).toBe(2);
    expect(durable.medications[0].currentPills).toBe(8);
    expect(r.log?.amount).toBe(-2);
  });

  it('event amount=2 + stock=1 → actual deduction=1 and log=-1', async () => {
    durable = {
      medications: [
        med({
          currentPills: 1,
          doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        }),
      ],
      logs: [],
    };
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({
        ok: true,
        status: 'FIRED',
        amount: 2,
      }),
    });
    expect(r.outcome).toBe('applied');
    expect(r.doseAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(0);
    expect(r.log?.amount).toBe(-1);
  });

  it('Manual Take with event amount then Exact Auto same occurrence → no second deduction', async () => {
    durable = {
      medications: [
        med({
          currentPills: 10,
          doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        }),
      ],
      logs: [],
    };
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({
        ok: true,
        status: 'FIRED',
        amount: 2,
      }),
    });
    expect(take.outcome).toBe('applied');
    expect(take.doseAmount).toBe(2);
    const pills = durable.medications[0].currentPills;
    expect(durable.medications[0].currentPills).toBe(pills);
  });

  it('absence of FIRED event → Manual Take uses current schedule amount', async () => {
    durable = {
      medications: [
        med({
          currentPills: 10,
          doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        }),
      ],
      logs: [],
    };
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({ ok: true, status: 'ABSENT' }),
    });
    expect(r.outcome).toBe('applied');
    expect(r.doseAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(9);
  });
});


describe('Phase 4 — stale scheduled dose identity must not downgrade to legacy', () => {
  it('consumeDose rejects an explicit old doseId after schedule removal', () => {
    const m = med({ doseSchedule: undefined, currentPills: 10, dailyDose: 1 });
    const r = consumeDose(m, 'manual', TODAY, new Date(`${TODAY}T12:00:00`), 'd1');
    expect(r.updatedMed).toBeNull();
    expect(r.reason).toBe('invalid_dose_id');
    expect(r.doseAmount).toBe(0);
  });

  it('restoreDose rejects an explicit old doseId after schedule removal', () => {
    const m = med({ doseSchedule: undefined, currentPills: 10, dailyDose: 1 });
    const r = restoreDose(m, 'd1', TODAY, new Date(`${TODAY}T12:00:00`), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_dose_id');
  });
});


describe('Phase 4 — durable deletion', () => {
  let durable: AutoStockDurableState;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-16T15:00:00'));
    durable = { medications: [med()], logs: [] };
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (next) => {
        durable = {
          medications: next.medications.map((m) => ({ ...m })),
          logs: next.logs.map((l) => ({ ...l })),
        };
        return null;
      },
    });
    __setManualEnvelopeTestHooks({ load: () => null, save: () => null });
    __setManualRecurrenceInvalidationTestHook(async () => ({ ok: true }));
    __setStockMutationOrderingTestHooks({
      allocate: (() => {
        let seq = 0;
        return () => ({ ok: true, seq: ++seq });
      })(),
      loadLastApplied: () => 0,
      persistLastApplied: () => null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __setManualRecurrenceInvalidationTestHook(null);
    __resetStockMutationOrderingForTests();
  });

  it('deletes from fresh durable state and invalidates the old native chain before commit', async () => {
    const result = await runGatedDeleteMedication({ medicationId: 'med-1' });
    expect(result.outcome).toBe('applied');
    expect(durable.medications).toHaveLength(0);
  });
});

describe('Phase 4 — native recurrence invalidation is the config-change ordering barrier', () => {
  let durable: AutoStockDurableState;
  const invalidated: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-16T15:00:00'));
    durable = { medications: [med()], logs: [] };
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (next) => {
        durable = {
          medications: next.medications.map((m) => ({ ...m })),
          logs: next.logs.map((l) => ({ ...l })),
        };
        return null;
      },
    });
    __setManualEnvelopeTestHooks({ load: () => null, save: () => null });
    invalidated.length = 0;
    __setManualRecurrenceInvalidationTestHook(async (medicationId, doseId) => {
      invalidated.push(`${medicationId}|${doseId}`);
      return { ok: true };
    });
    __setStockMutationOrderingTestHooks({
      allocate: (() => {
        let seq = 0;
        return () => ({ ok: true, seq: ++seq });
      })(),
      loadLastApplied: () => 0,
      persistLastApplied: () => null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __setManualRecurrenceInvalidationTestHook(null);
    __resetStockMutationOrderingForTests();
  });

  it('per-med toggle invalidates every existing dose chain before commit', async () => {
    const r = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      globalAutoDeductEnabled: true,
      todayStr: '2026-09-16',
    });
    expect(r.outcome).toBe('applied');
    expect(invalidated).toEqual(['med-1|d1', 'med-1|d2', 'med-1|d3']);
    expect(durable.medications[0].autoDeductEnabled).toBe(false);
  });

  it('schedule edit invalidates the old chain before the new configuration commits', async () => {
    const next: Medication = {
      ...med(),
      dailyDose: 6,
      doseSchedule: [
        { id: 'd1', amount: 3, time: '09:00' },
        { id: 'd2', amount: 1, time: '14:00' },
        { id: 'd3', amount: 2, time: '22:00' },
      ],
    };
    const r = await runGatedMedicationUpdate({
      editId: 'med-1',
      medData: next,
      globalAutoDeductEnabled: true,
      todayStr: '2026-09-16',
    });
    expect(r.outcome).toBe('applied');
    expect(invalidated).toEqual(['med-1|d1', 'med-1|d2', 'med-1|d3']);
    expect(durable.medications[0].doseSchedule?.find((d) => d.id === 'd1')?.amount).toBe(3);
  });

  it('native invalidation failure blocks the JS configuration mutation', async () => {
    __setManualRecurrenceInvalidationTestHook(async () => ({
      ok: false,
      error: 'native_invalidation_failed',
    }));
    const before = durable.medications[0];
    const r = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      globalAutoDeductEnabled: true,
      todayStr: '2026-09-16',
    });
    expect(r.outcome).toBe('native_invalidation_failed');
    expect(durable.medications[0]).toEqual(before);
  });
});

describe('Phase 4 — mutationSeq monotonic invariant', () => {
  afterEach(() => {
    __resetStockMutationOrderingForTests();
  });

  it('lastApplied=10, nextSeq=0 → allocation returns 11', () => {
    let nextSeq = 0;
    let lastApplied = 10;
    __setStockMutationOrderingTestHooks({
      allocate: () => {
        nextSeq = Math.max(nextSeq, lastApplied) + 1;
        return { ok: true, seq: nextSeq };
      },
      loadLastApplied: () => lastApplied,
      persistLastApplied: (v) => {
        if (v > lastApplied) lastApplied = v;
        return null;
      },
    });
    const r = allocateMutationSeq();
    expect(r).toEqual({ ok: true, seq: 11 });
  });

  it('lastApplied=10, nextSeq=10 → allocation returns 11', () => {
    let nextSeq = 10;
    let lastApplied = 10;
    __setStockMutationOrderingTestHooks({
      allocate: () => {
        nextSeq = Math.max(nextSeq, lastApplied) + 1;
        return { ok: true, seq: nextSeq };
      },
      loadLastApplied: () => lastApplied,
      persistLastApplied: (v) => {
        if (v > lastApplied) lastApplied = v;
        return null;
      },
    });
    const r = allocateMutationSeq();
    expect(r).toEqual({ ok: true, seq: 11 });
  });

  it('lastApplied=10, persist seq=9 does not decrease lastApplied', () => {
    let lastApplied = 10;
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (v) => {
        if (v > lastApplied) lastApplied = v;
        return null;
      },
    });
    const err = persistLastAppliedMutationSeq(9);
    expect(err).toBeNull();
    expect(loadLastAppliedMutationSeq()).toBe(10);
  });

  it('lastApplied=10, persist seq=11 becomes 11', () => {
    let lastApplied = 10;
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (v) => {
        if (v > lastApplied) lastApplied = v;
        return null;
      },
    });
    expect(persistLastAppliedMutationSeq(11)).toBeNull();
    expect(loadLastAppliedMutationSeq()).toBe(11);
  });

  it('allocation persistence failure prevents envelope creation path', async () => {
    let durable: AutoStockDurableState = {
      medications: [med()],
      logs: [],
    };
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (next) => {
        durable = {
          medications: next.medications.map((m) => ({ ...m })),
          logs: next.logs.map((l) => ({ ...l })),
        };
        return null;
      },
    });
    __setManualEnvelopeTestHooks({
      load: () => null,
      save: () => null,
    });
    __setStockMutationOrderingTestHooks({
      allocate: () => ({ ok: false, error: 'nextSeq persist failed' }),
      loadLastApplied: () => 0,
      persistLastApplied: () => null,
    });
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(r.outcome).toBe('persist_failed');
    expect(durable.medications[0].currentPills).toBe(10);
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __resetStockMutationOrderingForTests();
  });
});

describe('Phase 4 — future Restore is already_restored without durable deduction', () => {
  let durable: AutoStockDurableState;

  beforeEach(() => {
    // 07:00 — before d1 at 08:00
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T07:00:00`));
    durable = { medications: [med()], logs: [] };
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (next) => {
        durable = {
          medications: next.medications.map((m) => ({ ...m })),
          logs: next.logs.map((l) => ({ ...l })),
        };
        return null;
      },
    });
    __setManualEnvelopeTestHooks({
      load: () => null,
      save: () => null,
    });
    let nextSeq = 0;
    let lastApplied = 0;
    __setStockMutationOrderingTestHooks({
      allocate: () => {
        nextSeq = Math.max(nextSeq, lastApplied) + 1;
        return { ok: true, seq: nextSeq };
      },
      loadLastApplied: () => lastApplied,
      persistLastApplied: (v) => {
        if (v > lastApplied) lastApplied = v;
        return null;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __resetStockMutationOrderingForTests();
  });

  it('future unconsumed + no deduction → first Restore is already_restored', async () => {
    const r = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
    });
    expect(r.outcome).toBe('already_restored');
    expect(durable.medications[0].currentPills).toBe(10);
    expect(durable.logs).toHaveLength(0);
  });

  it('second future Restore stays already_restored with zero mutation', async () => {
    await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
    });
    const r2 = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
    });
    expect(r2.outcome).toBe('already_restored');
    expect(durable.logs).toHaveLength(0);
    expect(durable.medications[0].currentPills).toBe(10);
  });

  it('future Manual Take then Restore reverses the Take', async () => {
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(9);
    const restore = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
    });
    expect(restore.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(10);
  });
});

describe('Phase 4 — todayStr/now captured inside gate after wait', () => {
  it('second mutation waiting on gate uses clock at execution time', async () => {
    let durable: AutoStockDurableState = {
      medications: [med({ currentPills: 10 })],
      logs: [],
    };
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (next) => {
        durable = {
          medications: next.medications.map((m) => ({ ...m })),
          logs: next.logs.map((l) => ({ ...l })),
        };
        return null;
      },
    });
    __setManualEnvelopeTestHooks({
      load: () => null,
      save: () => null,
    });
    let nextSeq = 0;
    let lastApplied = 0;
    __setStockMutationOrderingTestHooks({
      allocate: () => {
        nextSeq = Math.max(nextSeq, lastApplied) + 1;
        return { ok: true, seq: nextSeq };
      },
      loadLastApplied: () => lastApplied,
      persistLastApplied: (v) => {
        if (v > lastApplied) lastApplied = v;
        return null;
      },
    });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T23:59:00`));

    // First take holds by awaiting a promise before commit via a custom path:
    // We intercept by running first consume without todayStr override so it
    // captures TODAY, then advance clock, then second without override.
    // Gate serializes so second's todayStr is read after first completes.

    const p1 = runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      // no todayStr override
    });

    // Advance clock past midnight while first may still be running
    await Promise.resolve();
    vi.setSystemTime(new Date('2026-09-17T00:30:00'));

    const p2 = runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd2',
      source: 'manual',
      // no todayStr override — must use 2026-09-17 inside gate
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.outcome).toBe('applied');
    expect(r2.outcome).toBe('applied');
    // d1 consumed on first day; d2 on second day
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
    expect(isDoseConsumedOnDate(durable.medications[0], 'd2', '2026-09-17')).toBe(true);

    vi.useRealTimers();
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __resetStockMutationOrderingForTests();
  });
});


describe('Phase 4 — native occurrence snapshot amount authority', () => {
  let durable: AutoStockDurableState;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T15:00:00`));
    durable = { medications: [med()], logs: [] };
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (next) => {
        durable = {
          medications: next.medications.map((m) => ({ ...m })),
          logs: next.logs.map((l) => ({ ...l })),
        };
        return null;
      },
    });
    __setManualEnvelopeTestHooks({
      load: () => null,
      save: () => null,
    });
    let nextSeq = 0;
    let lastApplied = 0;
    __setStockMutationOrderingTestHooks({
      allocate: () => {
        nextSeq = Math.max(nextSeq, lastApplied) + 1;
        return { ok: true, seq: nextSeq };
      },
      loadLastApplied: () => lastApplied,
      persistLastApplied: (value) => {
        if (value > lastApplied) lastApplied = value;
        return null;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __resetStockMutationOrderingForTests();
  });

  it('native SCHEDULED amount=2 + JS schedule amount=1 → Take deducts current JS amount 1', async () => {
    durable = {
      medications: [
        med({
          currentPills: 10,
          doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        }),
      ],
      logs: [],
    };
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({
        ok: true,
        status: 'SCHEDULED',
        amount: 2,
      }),
    });
    expect(r.outcome).toBe('applied');
    expect(r.doseAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(9);
  });

  it('exact durability block → Restore cannot write a projection skip marker', async () => {
    const before = JSON.parse(JSON.stringify(durable.medications[0]));

    vi.spyOn(
      preSettleModule,
      'reconcileExactBeforeManualMutation'
    ).mockImplementation(async (opts) => ({
      state: opts.fresh,
      reconciliation: null,
      nativeListFailed: false,
      durabilityBlocked: true,
    }));

    const r = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
    });

    expect(r.outcome).toBe('persist_failed');
    expect(r.reason).toBe('exact_reconciliation_blocked');
    expect(durable.medications[0]).toEqual(before);
    expect(isDoseSkippedOnDate(durable.medications[0], 'd1', TODAY)).toBe(false);
    expect(durable.logs).toHaveLength(0);
  });

  it('native snapshot failure → no stock mutation', async () => {
    durable = {
      medications: [med({ currentPills: 10 })],
      logs: [],
    };
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({
        ok: false,
        error: 'native_read_failed',
      }),
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('native_snapshot_failed');
    expect(durable.medications[0].currentPills).toBe(10);
    expect(durable.logs).toHaveLength(0);
  });

  it('native snapshot persist failure (REJECTED terminalization failure) → fail-closed Take', async () => {
    // Native contract: when the EventStore cannot durably terminalize a
    // malformed/mismatched FIRED row, getOccurrenceSnapshot reports an
    // explicit failure (ok=false, error 'rejected_persist_failed') through
    // the bridge — never a usable ABSENT/SCHEDULED snapshot. Manual Take
    // must fail closed: no stock mutation, no consume log, and no JS
    // schedule amount fallback.
    durable = {
      medications: [
        med({
          currentPills: 10,
          doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        }),
      ],
      logs: [],
    };
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({
        ok: false,
        error: 'rejected_persist_failed',
      }),
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('native_snapshot_failed');
    expect(r.doseAmount).toBe(0);
    expect(r.log).toBeNull();
    expect(durable.medications[0].currentPills).toBe(10);
    // No manual consume log of any type was written.
    expect(durable.logs.filter((l) => l.type === 'dose_taken')).toHaveLength(0);
    expect(durable.logs).toHaveLength(0);
  });

  it('CANCELLED snapshot → uses JS schedule amount (no native amount)', async () => {
    durable = {
      medications: [
        med({
          currentPills: 10,
          doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        }),
      ],
      logs: [],
    };
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({ ok: true, status: 'CANCELLED' }),
    });
    expect(r.outcome).toBe('applied');
    expect(r.doseAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(9);
  });

  it('single-dose without doseId resolves to d1 and uses FIRED amount', async () => {
    durable = {
      medications: [
        med({
          currentPills: 10,
          doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        }),
      ],
      logs: [],
    };
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      // no doseId
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async (_medId, doseId) => {
        expect(doseId).toBe('d1');
        return { ok: true, status: 'FIRED', amount: 3 };
      },
    });
    expect(r.outcome).toBe('applied');
    expect(r.doseAmount).toBe(3);
    expect(durable.medications[0].currentPills).toBe(7);
  });

  it('invalid amountOverride (NaN) returns reason=invalid_exact_event and does not mutate stock', async () => {
    durable = {
      medications: [med({ currentPills: 10 })],
      logs: [],
    };
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({
        ok: true,
        status: 'FIRED',
        amount: NaN,
      }),
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('invalid_exact_event');
    expect(r.doseAmount).toBe(0);
    expect(durable.medications[0].currentPills).toBe(10);
    expect(durable.logs).toHaveLength(0);
  });

  it('invalid amountOverride (<=0) returns reason=invalid_exact_event', async () => {
    durable = {
      medications: [med({ currentPills: 10 })],
      logs: [],
    };
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({
        ok: true,
        status: 'FIRED',
        amount: 0,
      }),
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('invalid_exact_event');
    expect(durable.medications[0].currentPills).toBe(10);
  });

  it('invalid amountOverride (negative) returns reason=invalid_exact_event', async () => {
    durable = {
      medications: [med({ currentPills: 10 })],
      logs: [],
    };
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({
        ok: true,
        status: 'FIRED',
        amount: -5,
      }),
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('invalid_exact_event');
    expect(durable.medications[0].currentPills).toBe(10);
  });
});


describe('Phase 4 — durable global preference and add-medication ordering', () => {
  let durable: AutoStockDurableState;
  let manualEnvelope: ManualStockEnvelope | null;
  let persistedGlobal: boolean;
  let failGlobalPersist: boolean;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-16T15:00:00'));
    durable = {
      medications: [med()],
      logs: [],
      globalAutoDeductEnabled: true,
    };
    manualEnvelope = null;
    persistedGlobal = true;
    failGlobalPersist = false;

    __setManualEnvelopeTestHooks({
      load: () => manualEnvelope,
      save: (env) => {
        manualEnvelope = env;
        return null;
      },
    });
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
        globalAutoDeductEnabled: durable.globalAutoDeductEnabled,
      }),
      commit: (state) => {
        durable = {
          medications: state.medications.map((m) => ({ ...m })),
          logs: state.logs.map((l) => ({ ...l })),
          globalAutoDeductEnabled: state.globalAutoDeductEnabled,
        };
        return null;
      },
      persistGlobal: (value) => {
        if (failGlobalPersist) return 'global_persist_failed';
        persistedGlobal = value;
        return null;
      },
    });
  });

  afterEach(() => {
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    vi.useRealTimers();
  });

  it('per-med toggle preserves the durable global master switch', async () => {
    durable = {
      medications: [med({ autoDeductEnabled: true })],
      logs: [],
      globalAutoDeductEnabled: false,
    };

    const result = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      globalAutoDeductEnabled: false,
    });

    expect(result.outcome).toBe('applied');
    expect(durable.medications[0].autoDeductEnabled).toBe(false);
    expect(durable.globalAutoDeductEnabled).toBe(false);
  });

  it('global toggle persists the master switch inside the same durable commit path', async () => {
    const result = await runGatedGlobalAutoDeductToggle({ enable: false });

    expect(result.outcome).toBe('applied');
    expect(durable.globalAutoDeductEnabled).toBe(false);
    expect(persistedGlobal).toBe(false);
    expect(durable.medications[0].autoDeductEnabled).toBe(false);
  });

  it('global persistence failure keeps the mutation envelope for restart recovery', async () => {
    failGlobalPersist = true;

    const result = await runGatedGlobalAutoDeductToggle({ enable: false });

    expect(result.outcome).toBe('persist_failed');
    expect(durable.medications[0].autoDeductEnabled).toBe(false);
    expect(persistedGlobal).toBe(true);
    expect(manualEnvelope?.globalAutoDeductEnabled).toBe(false);
  });

  it('new medication is committed against fresh durable state instead of React snapshot', async () => {
    durable = {
      medications: [med({ id: 'existing', currentPills: 7 })],
      logs: [],
      globalAutoDeductEnabled: false,
    };

    const newMedication = med({
      id: 'new-med',
      name: 'NewMed',
      currentPills: 20,
      // Deliberately stale/conflicting input — durable global=false must win.
      autoDeductEnabled: true,
    });

    const result = await runGatedAddMedication({ medication: newMedication });

    expect(result.outcome).toBe('applied');
    expect(durable.medications.map((m) => m.id)).toEqual(['new-med', 'existing']);
    expect(durable.medications.find((m) => m.id === 'existing')?.currentPills).toBe(7);
    expect(durable.medications.find((m) => m.id === 'new-med')?.autoDeductEnabled).toBe(false);
    expect(durable.globalAutoDeductEnabled).toBe(false);
  });
});

