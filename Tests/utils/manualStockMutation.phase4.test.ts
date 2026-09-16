import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import {
  runGatedManualConsume,
  runGatedManualRestore,
  shouldDismissAlarmAfterManualTake,
  __setManualEnvelopeTestHooks,
  type ManualStockEnvelope,
} from '../../src/utils/manualStockMutation';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';
import {
  __setAutoStockGateTestHooks,
  type AutoStockDurableState,
} from '../../src/utils/autoDeductionStockGate';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNative';
import { isDoseConsumedOnDate } from '../../src/utils/dateCalculations';
import { exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';

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
      listFired: async () => [
        fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 }),
      ],
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
      listFired: async () => [
        fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 }),
      ],
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
      listFired: async () => [
        fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 }),
      ],
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
      listFired: async () => [
        fired({ doseId: 'd2', calendarDate: TODAY, amount: 1 }),
      ],
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

  it('Manual Restore after Take is idempotent on second Restore (in-flight/skip)', async () => {
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

    // Second restore: pure restoreDose still may "apply" for auto-only skip
    // path; stock must not increase again if wasManual already cleared.
    const pillsAfterFirst = durable.medications[0].currentPills;
    const r2 = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-2',
    });
    // After first restore, consume cleared; second restore is auto-only path
    // (no +pills when past-due uses skip only).
    expect(durable.medications[0].currentPills).toBe(pillsAfterFirst);
    expect(r2.outcome === 'applied' || r2.outcome === 'rejected').toBe(true);
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
      listFired: async () => [
        fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 }),
      ],
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
  let generation: number;
  let marked: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T15:00:00`));
    durable = { medications: [med()], logs: [] };
    manualEnvelope = null;
    failLogs = false;
    failClear = false;
    generation = 0;
    marked = [];

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
      listFired: async () => [],
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
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
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

  it('stale Manual envelope must not overwrite newer durable state', async () => {
    // Successful Take → generation 1, no envelope.
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(generation).toBe(1);
    expect(durable.medications[0].currentPills).toBe(9);
    const newerMeds = durable.medications.map((m) => ({ ...m }));
    const newerLogs = durable.logs.map((l) => ({ ...l }));

    // Plant a stale envelope from an older mutation (baseGeneration 0) with
    // a contradictory snapshot (full stock, no consume markers).
    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 10 })],
      logs: [],
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
    };

    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => [],
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });

    // Newer durable B must remain; stale envelope discarded.
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
    // Commit succeeded (gen bumped) but clear failed → envelope still present.
    expect(first.outcome).toBe('applied');
    expect(generation).toBe(1);
    expect(durable.medications[0].currentPills).toBe(9);
    expect(durable.logs.some((l) => l.type === 'dose_taken')).toBe(true);
    expect(manualEnvelope).not.toBeNull();
    expect(manualEnvelope?.baseGeneration).toBe(0);
    const logCount = durable.logs.length;
    const pills = durable.medications[0].currentPills;

    // Retry recovery: gen > base → discard envelope without second mutation.
    failClear = false;
    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => [],
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
      listFired: async () => [],
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
