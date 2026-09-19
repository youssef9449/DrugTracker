/**
 * Regression: durable native FIRED amount must win over current schedule amount
 * when exact reconciliation runs before any legacy settlement path.
 * Also covers runGatedMedicationUpdate pruning and global toggle ordering.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNative';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';
import {
  reconcileFiredEvents,
  exactAutoLogId,
} from '../../src/utils/autoDeductionReconciliation';
import {
  runGatedAutoDeductToggle,
  runGatedGlobalAutoDeductToggle,
  runGatedMedicationUpdate,
  __setManualEnvelopeTestHooks,
} from '../../src/utils/manualStockMutation';
import { __setAutoStockGateTestHooks } from '../../src/utils/autoDeductionStockGate';
import { __setExactAutoEnvelopeTestHooks } from '../../src/utils/runAutoDeductionReconciliation';
import { __setStockMutationOrderingTestHooks } from '../../src/utils/stockMutationOrdering';
import { syncAutoDailyDeductions } from '../../src/utils/dateCalculations';
import * as preSettleModule from '../../src/utils/reconcileExactBeforeLegacySettlement';

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
    lastSyncDate: '2026-09-13',
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
    .spyOn(preSettleModule, 'reconcileExactBeforeLegacySettlement')
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
      };
    });
}

describe('exact FIRED amount precedes legacy settlement', () => {
  let durable: { medications: Medication[]; logs: ConsumptionLog[] };
  let seqCounter: { n: number };

  beforeEach(() => {
    durable = {
      medications: [baseMed({ currentPills: 10, lastSyncDate: '2026-09-13' })],
      logs: [],
    };
    seqCounter = { n: 1 };
    installGateHooks(durable, seqCounter);
  });

  afterEach(() => clearHooks());

  it('reconcileFiredEvents uses event.amount=2 not schedule amount=1', () => {
    const med = baseMed({ currentPills: 10, lastSyncDate: '2026-09-13' });
    const r = reconcileFiredEvents([med], [], [firedEvent(2)]);
    expect(r.medications[0].currentPills).toBe(8);
    expect(r.newExactLogs).toHaveLength(1);
    expect(r.newExactLogs[0].amount).toBe(-2);
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
    expect(durable.medications[0].currentPills).toBe(10);
    expect(durable.logs).toHaveLength(0);
  });

  it('runAutoDeductionReconciliation then legacy sync does not double-charge', async () => {
    const events = [firedEvent(2)];
    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      medications: durable.medications,
      logs: durable.logs,
      alreadyInGate: true,
      listFired: async () => ({ ok: true, events }),
      markReconciled: async () => ({ ok: true, changed: true }),
    });
    expect(recon.medications[0].currentPills).toBe(8);
    const exactId = exactAutoLogId('med-1', 'd1', '2026-09-14');
    expect(recon.logs.some((l) => l.id === exactId)).toBe(true);

    const legacy = syncAutoDailyDeductions(recon.medications, '2026-09-14');
    expect(legacy.updatedMeds[0].currentPills).toBe(8);
  });

  it('per-med toggle blocks when exact reconciliation is not durably finalized', async () => {
    vi.spyOn(
      preSettleModule,
      'reconcileExactBeforeLegacySettlement'
    ).mockImplementation(async (opts) => ({
      state: opts.fresh,
      reconciliation: null,
      nativeListFailed: false,
      durabilityBlocked: true,
    }));

    durable.medications = [
      baseMed({
        currentPills: 10,
        lastSyncDate: '2026-09-13',
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
    expect(result.medications[0].currentPills).toBe(10);
    expect(result.medications[0].autoDeductEnabled).toBe(true);
    expect(durable.logs).toHaveLength(0);
  });

  it('per-med toggle: exact amount 2 applied first; final stock is 8', async () => {
    const callOrder: string[] = [];
    // lastSync yesterday so legacy settlement WOULD charge schedule amount=1
    // if it ran before exact — wrong order yields 7 (10-1-2), correct order yields 8.
    durable.medications = [
      baseMed({
        currentPills: 10,
        lastSyncDate: '2026-09-13',
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
    // exact-first: 10→8; same occurrence already applied so legacy must not charge 1 → 8
    // legacy-first would be 10→9 then exact →7
    expect(result.medications[0].currentPills).toBe(8);
    const exactLogs = result.logs.filter(
      (l) => l.id === exactAutoLogId('med-1', 'd1', '2026-09-14')
    );
    expect(exactLogs).toHaveLength(1);
    expect(exactLogs[0].amount).toBe(-2);
  });

  it('idempotent second reconciliation keeps stock at event.amount deduction', () => {
    const med = baseMed({ currentPills: 10 });
    const e = firedEvent(2);
    const r1 = reconcileFiredEvents([med], [], [e]);
    const r2 = reconcileFiredEvents(r1.medications, r1.logs, [e]);
    expect(r1.medications[0].currentPills).toBe(8);
    expect(r2.medications[0].currentPills).toBe(8);
    expect(r2.newExactLogs).toHaveLength(0);
    expect(r2.details[0].outcome).toBe('already_applied');
  });
});

describe('runGatedGlobalAutoDeductToggle exact-before-legacy', () => {
  let durable: { medications: Medication[]; logs: ConsumptionLog[] };
  let seqCounter: { n: number };

  beforeEach(() => {
    durable = {
      medications: [baseMed({ currentPills: 10, lastSyncDate: '2026-09-14' })],
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
        lastSyncDate: '2026-09-13',
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
    // exact-first → 8; legacy-first would yield 7
    expect(result.medications[0].currentPills).toBe(8);
    expect(result.medications[0].autoDeductEnabled).toBe(false);
    const exactLogs = result.logs.filter(
      (l) => l.id === exactAutoLogId('med-1', 'd1', '2026-09-14')
    );
    expect(exactLogs).toHaveLength(1);
    expect(exactLogs[0].amount).toBe(-2);
  });

  it('global ON: settlement uses durable state after exact; stock stays 8', async () => {
    const callOrder: string[] = [];
    // Start from disabled durable with exact already reflected
    durable.medications = [
      baseMed({
        currentPills: 8,
        lastSyncDate: '2026-09-14',
        autoDeductEnabled: false,
        doseConsumption: { d1: '2026-09-14' },
        doseConsumptionHistory: { d1: ['2026-09-14'] },
      }),
    ];
    durable.logs = [
      {
        id: exactAutoLogId('med-1', 'd1', '2026-09-14'),
        medicationId: 'med-1',
        medicationName: 'TestMed',
        type: 'auto_daily',
        amount: -2,
        date: '2026-09-14',
        timestamp: new Date().toISOString(),
        description: 'exact',
      },
    ];

    vi.spyOn(
      preSettleModule,
      'reconcileExactBeforeLegacySettlement'
    ).mockImplementation(async (opts) => {
      callOrder.push('exact');
      return {
        state: opts.fresh,
        reconciliation: null,
        nativeListFailed: false,
      };
    });

    const result = await runGatedGlobalAutoDeductToggle({
      enable: true,
      todayStr: '2026-09-14',
    });
    expect(callOrder[0]).toBe('exact');
    expect(result.outcome).toBe('applied');
    expect(result.enable).toBe(true);
    expect(result.medications[0].currentPills).toBe(8);
    expect(result.medications[0].autoDeductEnabled).toBe(true);
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
          lastSyncDate: '2026-09-14',
          dailyDose: 1,
          doseSchedule: [
            { id: 'd1', amount: 1, time: '08:00' },
            { id: 'd2', amount: 1, time: '20:00' },
          ],
          doseConsumption: {
            d1: '2026-09-14',
            d2: '2026-09-13',
          },
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
      'reconcileExactBeforeLegacySettlement'
    ).mockImplementation(async (opts) => ({
      state: opts.fresh,
      reconciliation: null,
      nativeListFailed: false,
    }));

    const formMed = durable.medications[0];
    const { id: _id, createdAt: _c, ...medData } = {
      ...formMed,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      // Stale React form still has d2 history
      doseConsumption: {
        d1: '2026-09-14',
        d2: '2026-09-13',
      },
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
    expect(med.doseSchedule?.map((d) => d.id)).toEqual(['d1']);
    expect(med.doseConsumption).toEqual({ d1: '2026-09-14' });
    expect(med.doseConsumptionHistory).toEqual({ d1: ['2026-09-14'] });
    expect(med.doseConsumption).not.toHaveProperty('d2');
    expect(med.doseConsumptionHistory).not.toHaveProperty('d2');
  });

  it('dailyDose change: exact amount 2 first, final dailyDose=3, stock=8, no orphan', async () => {
    const callOrder: string[] = [];
    // Durable starts at 10 with d1 only; exact mock applies 2 → 8
    durable.medications = [
      baseMed({
        currentPills: 10,
        dailyDose: 1,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        lastSyncDate: '2026-09-13',
        doseConsumption: { d1: '2026-09-13' },
        doseConsumptionHistory: { d1: ['2026-09-13'] },
      }),
    ];
    mockExactFirst(durable, callOrder, 2);

    const { id: _id, createdAt: _c, ...medData } = {
      ...durable.medications[0],
      dailyDose: 3,
      doseSchedule: [{ id: 'd1', amount: 3, time: '08:00' }],
      doseConsumption: { d1: '2026-09-13', orphan: '2026-01-01' },
      doseConsumptionHistory: {
        d1: ['2026-09-13'],
        orphan: ['2026-01-01'],
      },
    };

    const result = await runGatedMedicationUpdate({
      editId: 'med-1',
      medData,
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
    });
    expect(callOrder[0]).toBe('exact');
    expect(result.outcome).toBe('applied');
    expect(result.medications[0].dailyDose).toBe(3);
    expect(result.medications[0].currentPills).toBe(8);
    const exactLogs = result.logs.filter(
      (l) => l.id === exactAutoLogId('med-1', 'd1', '2026-09-14')
    );
    expect(exactLogs).toHaveLength(1);
    expect(result.medications[0].doseConsumption).not.toHaveProperty('orphan');
    expect(result.medications[0].doseConsumptionHistory).not.toHaveProperty(
      'orphan'
    );
  });
});

describe('gated paths call exact reconciliation before legacy settlement', () => {
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

  it('runGatedAutoDeductToggle: exact first yields stock 8 (legacy-first would be 7)', async () => {
    const callOrder: string[] = [];
    durable.medications = [
      baseMed({
        currentPills: 10,
        lastSyncDate: '2026-09-13',
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
    expect(result.medications[0].currentPills).toBe(8);
  });

  it('runGatedGlobalAutoDeductToggle: exact first yields stock 8', async () => {
    const callOrder: string[] = [];
    durable.medications = [
      baseMed({
        currentPills: 10,
        lastSyncDate: '2026-09-13',
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
    expect(result.medications[0].currentPills).toBe(8);
    expect(result.enable).toBe(false);
  });

  it('runGatedMedicationUpdate: exact first then dailyDose=3 yields stock 8', async () => {
    const callOrder: string[] = [];
    durable.medications = [
      baseMed({
        currentPills: 10,
        lastSyncDate: '2026-09-13',
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
    expect(result.medications[0].dailyDose).toBe(3);
    // exact-first 10→8; wrong order would charge schedule then exact → 7
    expect(result.medications[0].currentPills).toBe(8);
  });
});

/**
 * Issue #268 / PR #271 — Legacy single-dose (no doseSchedule) Exact path removed.
 *
 * The pre-PR block here used a no-`doseSchedule` fixture to prove the
 * exact-before-legacy ordering: Exact applied amount 2 (10→8) and legacy
 * settlement then had to be a no-op for the same occurrence. That whole
 * path is gone. A Medication without an explicit, non-empty `doseSchedule`
 * whose array contains the event `doseId` can no longer drive an Exact
 * occurrence — `applyExactAutoEventToMedication` returns
 * `{ ok: false, reason: 'invalid_dose_schedule' }`.
 *
 * Consequence for ordering: with no Exact application, legacy settlement is
 * the ONLY deduction for a no-schedule med, so the "exact-before-legacy
 * ordering" is structurally trivial (Exact charges nothing). These tests
 * assert the new contract: no Exact log, no stock mutation from Exact, and
 * the gated-toggle / dose-change / global-toggle paths settle the legacy
 * window exactly once (10 → 9 at dailyDose 1).
 *
 * `doseSchedule` is the sole source of dose identity/amount/time for Exact.
 * No migration, no backward compatibility, no LEGACY_DOSE_ID fallback.
 */
describe('legacy single-dose (no doseSchedule): Exact path removed (#268 / PR #271)', () => {
  let durable: { medications: Medication[]; logs: ConsumptionLog[] };
  let seqCounter: { n: number };

  /** No-schedule med — the pre-PR legacy single-dose shape. */
  function legacyMed(over: Partial<Medication> = {}): Medication {
    return baseMed({
      doseSchedule: undefined,
      lastSyncDate: '2026-09-13',
      ...over,
    });
  }

  /** Exact FIRED event for the pre-PR legacy shape (empty doseId). */
  function legacyFired(amount = 2): AutoDeductionEvent {
    return firedEvent(amount, { doseId: '' });
  }

  /**
   * Mock pre-settlement to run the REAL reconcileFiredEvents for a no-schedule
   * med. Under the new contract Exact is a no-op (identity malformed → terminal
   * ACK; or invalid_dose_schedule if doseId were non-empty → retryable). The
   * gated settlement that follows is the only deduction.
   */
  function mockLegacyExactNoOp(callOrder: string[], amount = 2) {
    return vi
      .spyOn(preSettleModule, 'reconcileExactBeforeLegacySettlement')
      .mockImplementation(async (opts) => {
        callOrder.push('exact');
        const r = reconcileFiredEvents(
          opts.fresh.medications,
          opts.fresh.logs,
          [legacyFired(amount)]
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
        };
      });
  }

  beforeEach(() => {
    durable = {
      medications: [legacyMed({ currentPills: 10 })],
      logs: [],
    };
    seqCounter = { n: 1 };
    installGateHooks(durable, seqCounter);
  });

  afterEach(() => clearHooks());

  it('runGatedAutoDeductToggle: Exact is a no-op for a no-schedule med; legacy settle is the only deduction (10 → 9)', async () => {
    const callOrder: string[] = [];
    mockLegacyExactNoOp(callOrder, 2);

    const result = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
      globalAutoDeductEnabled: true,
    });
    expect(result.outcome).toBe('applied');
    // Exact charged nothing; legacy settlement at dailyDose 1 → 9.
    expect(result.medications[0].currentPills).toBe(9);
    expect(callOrder[0]).toBe('exact');
    // No Exact log with an empty-doseId id is ever produced.
    const exactLogId = exactAutoLogId('med-1', '', '2026-09-14');
    expect(result.logs.filter((l) => l.id === exactLogId)).toHaveLength(0);
  });

  it('runGatedGlobalAutoDeductToggle: no-schedule med → Exact no-op, global disable leaves stock untouched (10)', async () => {
    // Global disable only stops future recurrence for the med; it does not
    // run a per-med legacy day-settlement. With Exact a no-op, nothing is
    // deducted and currentPills stays at 10.
    const callOrder: string[] = [];
    mockLegacyExactNoOp(callOrder, 2);

    const result = await runGatedGlobalAutoDeductToggle({
      enable: false,
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
    });
    expect(result.outcome).toBe('applied');
    expect(result.medications[0].currentPills).toBe(10);
    expect(callOrder[0]).toBe('exact');
    expect(result.medications[0].autoDeductEnabled).toBe(false);
    // No Exact log with an empty-doseId id is ever produced.
    const exactLogId = exactAutoLogId('med-1', '', '2026-09-14');
    expect(result.logs.filter((l) => l.id === exactLogId)).toHaveLength(0);
  });

  it('runGatedMedicationUpdate (dailyDose 1→3): no-schedule med → legacy settle at old dose then dailyDose update; Exact no-op', async () => {
    const callOrder: string[] = [];
    mockLegacyExactNoOp(callOrder, 2);

    const { id: _id, createdAt: _c, ...medData } = {
      ...durable.medications[0],
      dailyDose: 3,
    };

    const result = await runGatedMedicationUpdate({
      editId: 'med-1',
      medData,
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
    });
    expect(result.outcome).toBe('applied');
    expect(result.medications[0].dailyDose).toBe(3);
    // Exact no-op; legacy settle at old dailyDose 1 → 9.
    expect(result.medications[0].currentPills).toBe(9);
    expect(callOrder[0]).toBe('exact');
  });

  it('reconcileFiredEvents directly: no-schedule + non-empty doseId → skipped_invalid, no ACK, no stock/log', () => {
    // Well-formed identity (med + non-empty doseId + valid date + positive
    // amount) but no schedule → cannot apply. NOT terminal; stays retryable.
    const med = legacyMed({ currentPills: 10 });
    const e: AutoDeductionEvent = firedEvent(2, { doseId: 'orphan' });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.details[0].outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([]);
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.logs).toEqual([]);
  });
});
