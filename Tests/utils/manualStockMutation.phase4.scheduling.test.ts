import {
  __setStockMutationOrderingTestHooks,
  __resetStockMutationOrderingForTests,
  __setManualEnvelopeTestHooks,
  __setExactAutoEnvelopeStorageTestHooks,
  __setAutoStockGateTestHooks,
} from './autoStockTestHooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import { makeScheduledMedication as med, makeAutoDeductionEvent as fired } from '../fixtures/testFixtures';
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
loadExactAutoStockEnvelope,
  durableMatchesEnvelopeSnapshot } from '../../src/utils/stockEnvelopeRecovery';
import {
allocateMutationSeq,
  persistLastAppliedMutationSeq,
  loadLastAppliedMutationSeq } from '../../src/utils/stockMutationOrdering';
import {
  runAutoDeductionReconciliation,
  type ExactAutoEnvelope } from '../../src/utils/runAutoDeductionReconciliation';
import {
type AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNativeTypes';
import { isDoseConsumedOnDate, isDoseSkippedOnDate } from '../../src/utils/dateCalculations';
import { exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';
import * as preSettleModule from '../../src/utils/reconcileExactBeforeManualMutation';

const autoSchedulingMocks = vi.hoisted(() => ({
  invalidateAutoDeductionRecurrence: vi.fn(),
  scheduleAutoDeduction: vi.fn(),
  recoverAutoDeductionOccurrenceForCompensation: vi.fn(),
}));

vi.mock('../../src/utils/autoDeductionNativeScheduling', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/autoDeductionNativeScheduling')>(
    '../../src/utils/autoDeductionNativeScheduling'
  );
  return {
    ...actual,
    ...autoSchedulingMocks,
  };
});

beforeEach(() => {
  autoSchedulingMocks.invalidateAutoDeductionRecurrence.mockResolvedValue({
    ok: true,
    generation: 1,
  });
  autoSchedulingMocks.scheduleAutoDeduction.mockResolvedValue({ ok: true });
  autoSchedulingMocks.recoverAutoDeductionOccurrence.mockResolvedValue({ ok: true });
});
// findPending used indirectly via runGatedManualConsume
import {
  findActiveDeductionForOccurrence,
  consumeDose,
  restoreDose } from '../../src/utils/medActions';

const TODAY = '2026-09-16';



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
    autoSchedulingMocks.invalidateAutoDeductionRecurrence.mockImplementation(
      async (medicationId, doseId) => {
        invalidated.push(`${medicationId}|${doseId}`);
        return { ok: true, generation: 1 };
      }
    );
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
    autoSchedulingMocks.invalidateAutoDeductionRecurrence.mockResolvedValue({
      ok: false,
      error: 'native_invalidation_failed',
    });
    const before = durable.medications[0];
    const r = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      globalAutoDeductEnabled: true,
      todayStr: '2026-09-16',
    });
    expect(r.outcome).toBe('native_invalidation_failed');
    expect(durable.medications[0]).toEqual(before);
  });

  it('partial cancellation failure compensates the current dose chain before returning failure', async () => {
    autoSchedulingMocks.invalidateAutoDeductionRecurrence.mockResolvedValue({
      ok: false,
      error: 'recurrence_generation_commit_failed',
      generation: 1,
      schedulesCancelled: true,
    });

    const before = durable.medications[0];
    const result = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      globalAutoDeductEnabled: true,
      todayStr: '2026-09-16',
    });

    expect(result.outcome).toBe('native_invalidation_failed');
    expect(durable.medications[0]).toEqual(before);
    expect(autoSchedulingMocks.scheduleAutoDeduction).toHaveBeenCalled();
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

describe('Phase 4 — treatment-boundary-safe recurrence compensation', () => {
  let durable: AutoStockDurableState;
  const scheduleCalls: Array<{
    calendarDate: string;
    treatmentEndDate?: string;
  }> = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T07:00:00'));
    scheduleCalls.length = 0;

    const temporary = med({
      isChronic: false,
      durationDays: 5,
      treatmentStartDate: '2026-09-23',
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
      dosesPerDay: 1,
    });
    durable = { medications: [temporary], logs: [] };

    __setManualEnvelopeTestHooks({
      load: () => null,
      save: () => null,
    });
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: () => 'persist_failed',
    });

    vi.spyOn(
      preSettleModule,
      'reconcileExactBeforeManualMutation'
    ).mockImplementation(async (opts) => ({
      state: opts.fresh,
      reconciliation: null,
      nativeListFailed: false,
      durabilityBlocked: false,
    }));

    autoSchedulingMocks.invalidateAutoDeductionRecurrence.mockResolvedValue({ ok: true, generation: 1 });

    autoSchedulingMocks.scheduleAutoDeduction.mockImplementation(async (args) => {
      scheduleCalls.push({
        calendarDate: args.calendarDate,
        treatmentEndDate: args.treatmentEndDate,
      });
      return { ok: true };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    
    vi.useRealTimers();
  });

  it('rechecks the clock during compensation when an occurrence crosses from future to past', async () => {
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: () => {
        // The mutation starts at Sep 22 07:00; make the Sep 23 20:00
        // occurrence become overdue before rollback compensation begins.
        vi.setSystemTime(new Date('2026-09-23T21:00:00'));
        return 'persist_failed';
      },
    });

    const current = durable.medications[0];
    const { id, createdAt, ...medData } = current;
    const result = await runGatedMedicationUpdate({
      editId: id,
      medData: {
        ...medData,
        durationDays: 6,
      },
    });

    expect(result.outcome).toBe('persist_failed');
    expect(autoSchedulingMocks.recoverAutoDeductionOccurrence).toHaveBeenCalledWith(
      id,
      'd1',
      '2026-09-23',
      expect.any(Number),
      1,
      1
    );
    expect(scheduleCalls).toEqual([
      {
        calendarDate: '2026-09-24',
        treatmentEndDate: '2026-09-28',
      },
    ]);
    expect(createdAt).toBe(current.createdAt);
  });

  it('does not compensate an occurrence before the treatment start date', async () => {
    const current = durable.medications[0];
    const {
      id,
      createdAt,
      ...medData
    } = current;
    expect(id).toBe(current.id);
    expect(createdAt).toBe(current.createdAt);

    const result = await runGatedMedicationUpdate({
      editId: current.id,
      medData: {
        ...medData,
        durationDays: 6,
      },
    });

    expect(result.outcome).toBe('persist_failed');
    expect(scheduleCalls).toEqual([
      {
        calendarDate: '2026-09-23',
        treatmentEndDate: '2026-09-27',
      },
    ]);
  });
});
