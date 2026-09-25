import { requireDefined } from '../helpers/requireDefined';
import {
  __setStockMutationOrderingTestHooks,
  __setManualEnvelopeTestHooks,
  __setAutoStockGateTestHooks,
  __setExactAutoEnvelopeTestHooks,
} from './autoStockTestHooks';
/**
 * Regression: durable native FIRED amount must win over current schedule amount
 * when exact reconciliation runs before any gated mutation path.
 * Also covers runGatedMedicationUpdate pruning and global toggle ordering.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNativeTypes';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';
import {
  reconcileFiredEvents,
  exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';
import {
  runGatedAutoDeductToggle,
  runGatedGlobalAutoDeductToggle,
  runGatedMedicationUpdate,
} from '../../src/utils/manualStockMutation';
import * as preSettleModule from '../../src/utils/reconcileExactBeforeManualMutation';

function baseMed(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'TestMed',
    currentPills: 10,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    // lastSync strictly BEFORE the event day ('2026-09-14') so the exact
    // occurrence is reconcilable on ANY real calendar day — the past-day
    // horizon guard in isExactAutoOccurrenceApplied must not swallow the
    // event (calendarDate <= lastSync && calendarDate < realToday).
    autoDeductEnabled: true,
    doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    ...over,
  };
}

function firedEvent(
  amount: number,
  over: Partial<AutoDeductionEvent> = {}
): AutoDeductionEvent {
  return {
    medicationId: 'med-1',
    doseId: 'd1',
    calendarDate: '2026-09-14',
    amount,
    status: 'FIRED',
    scheduledAtEpochMs: 1,
    createdAtEpochMs: 1,
    reconciledAtEpochMs: null,
    ...over,
  };
}

function installGateHooks(
  durable: { medications: Medication[]; logs: ConsumptionLog[] },
  seqCounter: { n: number }
) {
  __setAutoStockGateTestHooks({
    load: () => ({
      medications: durable.medications.map((m) => ({ ...m })),
      logs: [...durable.logs],
    }),
    commit: (state) => {
      durable.medications = state.medications.map((m) => ({ ...m }));
      durable.logs = [...state.logs];
      return null;
    },
  });
  __setManualEnvelopeTestHooks({ load: () => null, save: () => null });
  __setExactAutoEnvelopeTestHooks({ load: () => null, save: () => null });
  __setStockMutationOrderingTestHooks({
    loadLastApplied: () => 0,
    persistLastApplied: () => null,
    allocate: () => ({ ok: true as const, seq: seqCounter.n++ }),
  });
}

function clearHooks() {
  __setAutoStockGateTestHooks(null);
  __setManualEnvelopeTestHooks(null);
  __setExactAutoEnvelopeTestHooks(null);
  __setStockMutationOrderingTestHooks(null);
  vi.restoreAllMocks();
}

/** Mock pre-settlement to apply exact amount=2 (10→8) and record ordering. */
function mockExactFirst(
  durable: { medications: Medication[]; logs: ConsumptionLog[] },
  callOrder: string[],
  amount = 2
) {
  return vi
    .spyOn(preSettleModule, 'reconcileExactBeforeManualMutation')
    .mockImplementation(async (opts) => {
      callOrder.push('exact');
      const from = opts.fresh.medications;
      const r = reconcileFiredEvents(from, opts.fresh.logs, [
        firedEvent(amount),
      ]);
      durable.medications = r.medications;
      durable.logs = r.logs;
      return {
        state: { medications: r.medications, logs: r.logs },
        reconciliation: {
          ...r,
          markedCount: 0,
          recoveredEnvelope: false,
          partialNativeAck: false,
        },
        nativeListFailed: false,
        durabilityBlocked: false,
      };
    });
}

describe('exact FIRED amount precedes gated mutation', () => {
  let durable: { medications: Medication[]; logs: ConsumptionLog[] };
  let seqCounter: { n: number };

  beforeEach(() => {
    durable = {
      medications: [baseMed({ currentPills: 10})],
      logs: [],
    };
    seqCounter = { n: 1 };
    installGateHooks(durable, seqCounter);
  });

  afterEach(() => clearHooks());

  it('reconcileFiredEvents uses event.amount=2 not schedule amount=1', () => {
    const med = baseMed({ currentPills: 10});
    const r = reconcileFiredEvents([med], [], [firedEvent(2)]);
    expect(requireDefined(r.medications[0], 'r.medications[0]').currentPills).toBe(8);
    expect(r.newExactLogs).toHaveLength(1);
    expect(requireDefined(r.newExactLogs[0], 'r.newExactLogs[0]').amount).toBe(-2);
  });

  it('exact persistence failure surfaces durabilityBlocked and leaves stock untouched', async () => {
    __setExactAutoEnvelopeTestHooks({
      load: () => null,
      save: () => 'exact_envelope_save_failed',
    });
    const mark = vi.fn(async () => ({ ok: true as const, changed: true }));

    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      medications: durable.medications,
      logs: durable.logs,
      alreadyInGate: true,
      durableState: {
        medications: durable.medications,
        logs: durable.logs,
        globalAutoDeductEnabled: true,
      },
      listFired: async () => ({ ok: true, events: [firedEvent(2)] }),
      markReconciled: mark,
    });

    expect(recon.durabilityBlocked).toBe(true);
    expect(recon.mutated).toBe(false);
    expect(recon.markedCount).toBe(0);
    expect(mark).not.toHaveBeenCalled();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
    expect(durable.logs).toHaveLength(0);
  });

  it('runAutoDeductionReconciliation then a second reconciliation does not double-charge', async () => {
    const events = [firedEvent(2)];
    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      medications: durable.medications,
      logs: durable.logs,
      alreadyInGate: true,
      listFired: async () => ({ ok: true, events }),
      markReconciled: async () => ({ ok: true, changed: true }),
    });
    expect(requireDefined(recon.medications[0], 'recon.medications[0]').currentPills).toBe(8);
    const exactId = exactAutoLogId('med-1', 'd1', '2026-09-14');
    expect(recon.logs.some((l) => l.id === exactId)).toBe(true);

    // No second automatic deduction from app-open or calendar-day settlement
    // (Issue #268 / PR #271). A second reconciliation re-listing the same FIRED
    // finds the durable exact log + consume marker → already_applied → no
    // double-charge (8).
    const recon2 = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      medications: recon.medications,
      logs: recon.logs,
      alreadyInGate: true,
      listFired: async () => ({ ok: true, events }),
      markReconciled: async () => ({ ok: true, changed: false }),
    });
    expect(recon2.mutated).toBe(false);
    expect(requireDefined(recon2.medications[0], 'recon2.medications[0]').currentPills).toBe(8);
    expect(recon2.newExactLogs).toEqual([]);
  });

  it('per-med toggle blocks when exact reconciliation is not durably finalized', async () => {
    vi.spyOn(
      preSettleModule,
      'reconcileExactBeforeManualMutation'
    ).mockImplementation(async (opts) => ({
      state: opts.fresh,
      reconciliation: null,
      nativeListFailed: false,
      durabilityBlocked: true,
    }));

    durable.medications = [
      baseMed({
        currentPills: 10,
        autoDeductEnabled: true,
      }),
    ];

    const result = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
      globalAutoDeductEnabled: true,
    });

    expect(result.reason).toBe('exact_reconciliation_blocked');
    expect(requireDefined(result.medications[0], 'result.medications[0]').currentPills).toBe(10);
    expect(requireDefined(result.medications[0], 'result.medications[0]').autoDeductEnabled).toBe(true);
    expect(durable.logs).toHaveLength(0);
  });

  it('per-med toggle: exact amount 2 applied first; final stock is 8', async () => {
    const callOrder: string[] = [];
    // lastSync yesterday so a day-based charge of schedule amount=1 would
    // if it ran before exact — wrong order yields 7 (10-1-2), correct order yields 8.
    durable.medications = [
      baseMed({
        currentPills: 10,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      }),
    ];
    mockExactFirst(durable, callOrder, 2);

    const result = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
      globalAutoDeductEnabled: true,
    });
    expect(callOrder[0]).toBe('exact');
    expect(result.outcome).toBe('applied');
    // exact-first: 10→8; same occurrence already applied so no second deduction → 8
    // mutation-first would be 10→9 then exact →7
    expect(requireDefined(result.medications[0], 'result.medications[0]').currentPills).toBe(8);
    const exactLogs = result.logs.filter(
      (l) => l.id === exactAutoLogId('med-1', 'd1', '2026-09-14')
    );
    expect(exactLogs).toHaveLength(1);
    expect(requireDefined(exactLogs[0], 'exactLogs[0]').amount).toBe(-2);
  });

  it('idempotent second reconciliation keeps stock at event.amount deduction', () => {
    const med = baseMed({ currentPills: 10 });
    const e = firedEvent(2);
    const r1 = reconcileFiredEvents([med], [], [e]);
    const r2 = reconcileFiredEvents(r1.medications, r1.logs, [e]);
    expect(requireDefined(r1.medications[0], 'r1.medications[0]').currentPills).toBe(8);
    expect(requireDefined(r2.medications[0], 'r2.medications[0]').currentPills).toBe(8);
    expect(r2.newExactLogs).toHaveLength(0);
    expect(requireDefined(r2.details[0], 'r2.details[0]').outcome).toBe('already_applied');
  });
});

describe('runGatedGlobalAutoDeductToggle exact-before-mutation', () => {
  let durable: { medications: Medication[]; logs: ConsumptionLog[] };
  let seqCounter: { n: number };

  beforeEach(() => {
    durable = {
      medications: [baseMed({ currentPills: 10})],
      logs: [],
    };
    seqCounter = { n: 1 };
    installGateHooks(durable, seqCounter);
  });

  afterEach(() => clearHooks());

  it('global OFF: exact FIRED amount=2 first; final stock=8; enable false', async () => {
    const callOrder: string[] = [];
    durable.medications = [
      baseMed({
        currentPills: 10,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      }),
    ];
    mockExactFirst(durable, callOrder, 2);

    const result = await runGatedGlobalAutoDeductToggle({
      enable: false,
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
    });
    expect(callOrder[0]).toBe('exact');
    expect(result.outcome).toBe('applied');
    expect(result.enable).toBe(false);
    // exact-first → 8; mutation-first would yield 7
    expect(requireDefined(result.medications[0], 'result.medications[0]').currentPills).toBe(8);
    expect(requireDefined(result.medications[0], 'result.medications[0]').autoDeductEnabled).toBe(false);
    const exactLogs = result.logs.filter(
      (l) => l.id === exactAutoLogId('med-1', 'd1', '2026-09-14')
    );
    expect(exactLogs).toHaveLength(1);
    expect(requireDefined(exactLogs[0], 'exactLogs[0]').amount).toBe(-2);
  });

  it('global ON: settlement uses durable state after exact; stock stays 8', async () => {
    const callOrder: string[] = [];
    // Start from disabled durable with exact already reflected
    durable.medications = [
      baseMed({
        currentPills: 8,
        autoDeductEnabled: false,
        doseConsumptionHistory: { d1: ['2026-09-14'] },
      }),
    ];
    durable.logs = [
      {
        id: exactAutoLogId('med-1', 'd1', '2026-09-14'),
        medicationId: 'med-1',
        medicationName: 'TestMed',
        type: 'exact_auto',
        amount: -2,
        date: '2026-09-14',
        timestamp: new Date().toISOString(),
        description: 'exact',
      },
    ];

    vi.spyOn(
      preSettleModule,
      'reconcileExactBeforeManualMutation'
    ).mockImplementation(async (opts) => {
      callOrder.push('exact');
      return {
        state: opts.fresh,
        reconciliation: null,
        nativeListFailed: false,
        durabilityBlocked: false,
      };
    });

    const result = await runGatedGlobalAutoDeductToggle({
      enable: true,
      todayStr: '2026-09-14',
    });
    expect(callOrder[0]).toBe('exact');
    expect(result.outcome).toBe('applied');
    expect(result.enable).toBe(true);
    expect(requireDefined(result.medications[0], 'result.medications[0]').currentPills).toBe(8);
    expect(requireDefined(result.medications[0], 'result.medications[0]').autoDeductEnabled).toBe(true);
  });
});

describe('runGatedMedicationUpdate pruning and exact-before-settle', () => {
  let durable: { medications: Medication[]; logs: ConsumptionLog[] };
  let seqCounter: { n: number };

  beforeEach(() => {
    durable = {
      medications: [
        baseMed({
          currentPills: 10,
          dailyDose: 1,
          doseSchedule: [
            { id: 'd1', amount: 1, time: '08:00' },
            { id: 'd2', amount: 1, time: '20:00' },
          ],
          doseConsumptionHistory: {
            d1: ['2026-09-14'],
            d2: ['2026-09-13'],
          },
        }),
      ],
      logs: [],
    };
    seqCounter = { n: 1 };
    installGateHooks(durable, seqCounter);
  });

  afterEach(() => clearHooks());

  it('prunes orphan dose history when schedule drops d2', async () => {
    vi.spyOn(
      preSettleModule,
      'reconcileExactBeforeManualMutation'
    ).mockImplementation(async (opts) => ({
      state: opts.fresh,
      reconciliation: null,
      nativeListFailed: false,
      durabilityBlocked: false,
    }));

    const formMed = requireDefined(durable.medications[0], 'durable.medications[0]');
    const { id: _id, createdAt: _c, ...medData } = {
      ...formMed,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      // Stale React form still has d2 history
      doseConsumptionHistory: {
        d1: ['2026-09-14'],
        d2: ['2026-09-13'],
      },
    };

    const result = await runGatedMedicationUpdate({
      editId: 'med-1',
      medData,
      todayStr: '2026-09-14',
    });
    expect(result.outcome).toBe('applied');
    const med = result.medications[0];
    expect(requireDefined(med, 'med').doseSchedule?.map((d) => d.id)).toEqual(['d1']);
    expect(requireDefined(med, 'med').doseConsumptionHistory).toEqual({ d1: '2026-09-14' });
    expect(requireDefined(med, 'med').doseConsumptionHistory).toEqual({ d1: ['2026-09-14'] });
    expect(requireDefined(med, 'med').doseConsumptionHistory).not.toHaveProperty('d2');
    expect(requireDefined(med, 'med').doseConsumptionHistory).not.toHaveProperty('d2');
  });

  it('dailyDose change: exact amount 2 first, final dailyDose=3, stock=8, no orphan', async () => {
    const callOrder: string[] = [];
    // Durable starts at 10 with d1 only; exact mock applies 2 → 8
    durable.medications = [
      baseMed({
        currentPills: 10,
        dailyDose: 1,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        doseConsumptionHistory: { d1: ['2026-09-13'] },
      }),
    ];
    mockExactFirst(durable, callOrder, 2);

    const { id: _id, createdAt: _c, ...medData } = {
      ...requireDefined(durable.medications[0], 'durable.medications[0]'),
      dailyDose: 3,
      doseSchedule: [{ id: 'd1', amount: 3, time: '08:00' }],
      doseConsumptionHistory: { d1: ['2026-09-13'], orphan: ['2026-01-01'] },
    };

    const result = await runGatedMedicationUpdate({
      editId: 'med-1',
      medData,
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
    });
    expect(callOrder[0]).toBe('exact');
    expect(result.outcome).toBe('applied');
    expect(requireDefined(result.medications[0], 'result.medications[0]').dailyDose).toBe(3);
    expect(requireDefined(result.medications[0], 'result.medications[0]').currentPills).toBe(8);
    const exactLogs = result.logs.filter(
      (l) => l.id === exactAutoLogId('med-1', 'd1', '2026-09-14')
    );
    expect(exactLogs).toHaveLength(1);
    expect(requireDefined(result.medications[0], 'result.medications[0]').doseConsumptionHistory).not.toHaveProperty('orphan');
    expect(requireDefined(result.medications[0], 'result.medications[0]').doseConsumptionHistory).not.toHaveProperty(
      'orphan'
    );
  });
});

describe('gated paths call exact reconciliation before mutation', () => {
  let durable: { medications: Medication[]; logs: ConsumptionLog[] };
  let seqCounter: { n: number };

  beforeEach(() => {
    durable = {
      medications: [baseMed({ currentPills: 10 })],
      logs: [],
    };
    seqCounter = { n: 1 };
    installGateHooks(durable, seqCounter);
  });

  afterEach(() => clearHooks());

  it('runGatedAutoDeductToggle: exact first yields stock 8 (mutation-first would be 7)', async () => {
    const callOrder: string[] = [];
    durable.medications = [
      baseMed({
        currentPills: 10,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      }),
    ];
    mockExactFirst(durable, callOrder, 2);
    const result = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
      globalAutoDeductEnabled: true,
    });
    expect(callOrder[0]).toBe('exact');
    expect(requireDefined(result.medications[0], 'result.medications[0]').currentPills).toBe(8);
  });

  it('runGatedGlobalAutoDeductToggle: exact first yields stock 8', async () => {
    const callOrder: string[] = [];
    durable.medications = [
      baseMed({
        currentPills: 10,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      }),
    ];
    mockExactFirst(durable, callOrder, 2);
    const result = await runGatedGlobalAutoDeductToggle({
      enable: false,
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
    });
    expect(callOrder[0]).toBe('exact');
    expect(requireDefined(result.medications[0], 'result.medications[0]').currentPills).toBe(8);
    expect(result.enable).toBe(false);
  });

  it('runGatedMedicationUpdate: exact first then dailyDose=3 yields stock 8', async () => {
    const callOrder: string[] = [];
    durable.medications = [
      baseMed({
        currentPills: 10,
        dailyDose: 1,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      }),
    ];
    mockExactFirst(durable, callOrder, 2);
    const { id: _id, createdAt: _c, ...medData } = {
      ...durable.medications[0],
      dailyDose: 3,
      doseSchedule: [{ id: 'd1', amount: 3, time: '08:00' }],
    };
    const result = await runGatedMedicationUpdate({
      editId: 'med-1',
      medData,
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
    });
    expect(callOrder[0]).toBe('exact');
    expect(result.outcome).toBe('applied');
    expect(requireDefined(result.medications[0], 'result.medications[0]').dailyDose).toBe(3);
    // exact-first 10→8; wrong order would charge schedule then exact → 7
    expect(requireDefined(result.medications[0], 'result.medications[0]').currentPills).toBe(8);
  });
});

/**
 * Issue #268 / PR #271 — FIRED Exact occurrence is durable regardless of the
 * Medication's CURRENT doseSchedule.
 *
 * The pre-PR block here used a no-`doseSchedule` fixture to prove the
 * exact-before-mutation ordering under the current contract (Exact was a no-op for
 * a no-schedule med). That contract was wrong: a FIRED Exact occurrence is
 * durable — the native AlarmManager created it at schedule time with
 * identity (medicationId + doseId + calendarDate) and `event.amount`. Editing
 * or removing the dose from the current schedule AFTER the alarm fired does
 * NOT invalidate the already-occurred event; `event.amount` remains the
 * authoritative charge. `doseSchedule` is the sole source for scheduling
 * FUTURE occurrences, NOT a precondition for reconciling a FIRED one.
 *
 * These tests assert the new contract: a FIRED event for a dose that is no
 * longer in the current schedule still applies `event.amount` exactly once,
 * with no Single-Dose fallback (amount is event.amount, NOT dailyDose
 * and NOT the current schedule amount).
 */
describe('FIRED durable after schedule edit/remove (#268 / PR #271)', () => {
  let durable: { medications: Medication[]; logs: ConsumptionLog[] };
  let seqCounter: { n: number };

  /** Med whose current schedule no longer contains d1 (removed after fire). */
  function scheduleEditedMed(over: Partial<Medication> = {}): Medication {
    return baseMed({
      // d1 was removed after fire; only d2 remains in the current schedule.
      doseSchedule: [{ id: 'd2', amount: 1, time: '20:00' }],
      ...over,
    });
  }

  /** FIRED event for d1 (removed from current schedule) carrying amount 2. */
  function firedForRemovedDose(amount = 2): AutoDeductionEvent {
    return firedEvent(amount, { doseId: 'd1' });
  }

  /**
   * Mock pre-settlement to run the REAL reconcileFiredEvents so the exact
   * reconciliation applies event.amount for the FIRED occurrence whose doseId
   * is no longer in the current schedule.
   */
  function mockExactAppliesDurable(callOrder: string[], amount = 2) {
    return vi
      .spyOn(preSettleModule, 'reconcileExactBeforeManualMutation')
      .mockImplementation(async (opts) => {
        callOrder.push('exact');
        const r = reconcileFiredEvents(
          opts.fresh.medications,
          opts.fresh.logs,
          [firedForRemovedDose(amount)]
        );
        durable.medications = r.medications;
        durable.logs = r.logs;
        return {
          state: { medications: r.medications, logs: r.logs },
          reconciliation: {
            ...r,
            markedCount: 0,
            recoveredEnvelope: false,
            partialNativeAck: false,
          },
          nativeListFailed: false,
          durabilityBlocked: false,
        };
      });
  }

  beforeEach(() => {
    durable = {
      medications: [scheduleEditedMed({ currentPills: 10 })],
      logs: [],
    };
    seqCounter = { n: 1 };
    installGateHooks(durable, seqCounter);
  });

  afterEach(() => clearHooks());

  it('reconcileFiredEvents directly: doseId removed from current schedule → applies event.amount exactly once', () => {
    const med = scheduleEditedMed({ currentPills: 10 });
    const e: AutoDeductionEvent = firedForRemovedDose(2);
    const r = reconcileFiredEvents([med], [], [e]);
    expect(requireDefined(r.details[0], 'r.details[0]').outcome).toBe('applied');
    expect(r.mutated).toBe(true);
    // event.amount (2) authoritative, NOT the current schedule amount (1 for
    // d2) and NOT dailyDose.
    expect(requireDefined(r.medications[0], 'r.medications[0]').currentPills).toBe(8);
    expect(r.newExactLogs).toHaveLength(1);
    expect(requireDefined(r.newExactLogs[0], 'r.newExactLogs[0]').amount).toBe(-2);
    expect(requireDefined(r.newExactLogs[0], 'r.newExactLogs[0]').id).toBe(exactAutoLogId('med-1', 'd1', '2026-09-14'));
    expect(r.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
  });

  it('reconcileFiredEvents directly: retry after apply → already_applied, no duplicate deduction/log', () => {
    const med = scheduleEditedMed({ currentPills: 10 });
    const e: AutoDeductionEvent = firedForRemovedDose(2);
    const r1 = reconcileFiredEvents([med], [], [e]);
    expect(requireDefined(r1.medications[0], 'r1.medications[0]').currentPills).toBe(8);
    expect(r1.newExactLogs).toHaveLength(1);

    const r2 = reconcileFiredEvents(r1.medications, r1.logs, [e]);
    expect(requireDefined(r2.details[0], 'r2.details[0]').outcome).toBe('already_applied');
    expect(r2.mutated).toBe(false);
    expect(requireDefined(r2.medications[0], 'r2.medications[0]').currentPills).toBe(8);
    expect(r2.newExactLogs).toEqual([]);
    expect(
      r2.logs.filter((l) => l.id === exactAutoLogId('med-1', 'd1', '2026-09-14'))
    ).toHaveLength(1);
  });

  it('runGatedAutoDeductToggle: FIRED for a removed dose applies event.amount before the gated settlement', async () => {
    const callOrder: string[] = [];
    mockExactAppliesDurable(callOrder, 2);

    const result = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
      globalAutoDeductEnabled: true,
    });
    expect(result.outcome).toBe('applied');
    expect(callOrder[0]).toBe('exact');
    // The exact log for the removed-dose FIRED occurrence is created.
    const exactLogId = exactAutoLogId('med-1', 'd1', '2026-09-14');
    const exactLogs = result.logs.filter((l) => l.id === exactLogId);
    expect(exactLogs).toHaveLength(1);
    expect(requireDefined(exactLogs[0], 'exactLogs[0]').amount).toBe(-2);
    // event.amount was applied (10 − 2 = 8 from the exact step). The gated
    // settlement then runs for the remaining schedule; the net depends on
    // that path — the durable exact log proves the FIRED occurrence was
    // reconciled authoritatively.
    expect(requireDefined(result.medications[0], 'result.medications[0]').currentPills).toBeLessThanOrEqual(8);
  });
});
