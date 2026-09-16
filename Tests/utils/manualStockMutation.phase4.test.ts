import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import {
  runGatedManualConsume,
  runGatedManualRestore,
} from '../../src/utils/manualStockMutation';
import {
  runAutoDeductionReconciliation,
  __setExactAutoEnvelopeTestHooks,
  type ExactAutoEnvelope,
} from '../../src/utils/runAutoDeductionReconciliation';
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

describe('Phase 4 — crash consistency (partial meds/logs write)', () => {
  let durable: AutoStockDurableState;
  let envelope: ExactAutoEnvelope | null;
  let failLogs: boolean;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T15:00:00`));
    durable = { medications: [med()], logs: [] };
    envelope = null;
    failLogs = false;

    __setExactAutoEnvelopeTestHooks({
      load: () => envelope,
      save: (env) => {
        envelope = env;
        return null;
      },
    });

    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      // Simulate commitDurableAutoStockState: meds always land, logs may fail.
      commit: (state) => {
        durable.medications = state.medications.map((m) => ({ ...m }));
        if (failLogs) {
          return 'logs persist failed';
        }
        durable.logs = state.logs.map((l) => ({ ...l }));
        return null;
      },
    });
  });

  afterEach(() => {
    __setAutoStockGateTestHooks(null);
    __setExactAutoEnvelopeTestHooks(null);
    vi.useRealTimers();
  });

  it('Manual Take: meds ok + logs fail → recovery → Exact Auto does not double-deduct', async () => {
    failLogs = true;
    const first = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(first.outcome).toBe('persist_failed');
    expect(envelope).not.toBeNull();
    // Partial durable: meds have consume marker, logs still empty of take.
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
    expect(durable.logs.some((l) => l.type === 'dose_taken')).toBe(false);

    // Restart path: logs can write again; recover envelope then reconcile FIRED.
    failLogs = false;
    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => [
        fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 }),
      ],
      markReconciled: async () => ({ ok: true, changed: true }),
    });

    // Envelope recovery restores full meds+logs; FIRED is already_applied.
    expect(envelope).toBeNull();
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
    expect(durable.logs.some((l) => l.type === 'dose_taken')).toBe(true);
    // One deduction only (Take amount 1 from 10 → 9), not auto again.
    expect(durable.medications[0].currentPills).toBe(9);
    if (recon.details.length > 0) {
      expect(recon.details.every((d) => d.outcome === 'already_applied')).toBe(
        true
      );
    }
  });

  it('Manual Restore: meds ok + logs fail → recovery → no double restore stock', async () => {
    // Successful Take first (full durable).
    failLogs = false;
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(durable.medications[0].currentPills).toBe(9);

    // Restore with logs failure after meds write.
    failLogs = true;
    const restoreFail = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-crash-1',
    });
    expect(restoreFail.outcome).toBe('persist_failed');
    expect(envelope).not.toBeNull();
    // Meds already reflect restored stock (10); logs missing restore entry.
    expect(durable.medications[0].currentPills).toBe(10);
    expect(durable.logs.some((l) => l.id === 'restore-crash-1')).toBe(false);

    failLogs = false;
    // Recovery via another gate entry (envelope finish).
    const restoreRetry = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-crash-2',
    });
    // After envelope recovery, consume marks cleared → second restore may be
    // auto-only path without +pills; stock must stay at 10 (not 11).
    expect(durable.medications[0].currentPills).toBe(10);
    expect(envelope).toBeNull();
    expect(durable.logs.some((l) => l.id === 'restore-crash-1')).toBe(true);
    // Retry must not inflate stock.
    expect(
      restoreRetry.outcome === 'applied' ||
        restoreRetry.outcome === 'rejected' ||
        restoreRetry.outcome === 'persist_failed'
    ).toBe(true);
  });
});
