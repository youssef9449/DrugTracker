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
    lastSyncDate: '2026-09-14',
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
      medications: [baseMed({ currentPills: 10, lastSyncDate: '2026-09-14' })],
      logs: [],
    };
    seqCounter = { n: 1 };
    installGateHooks(durable, seqCounter);
  });

  afterEach(() => clearHooks());

  it('reconcileFiredEvents uses event.amount=2 not schedule amount=1', () => {
    const med = baseMed({ currentPills: 10, lastSyncDate: '2026-09-14' });
    const r = reconcileFiredEvents([med], [], [firedEvent(2)]);
    expect(r.medications[0].currentPills).toBe(8);
    expect(r.newExactLogs).toHaveLength(1);
    expect(r.newExactLogs[0].amount).toBe(-2);
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

  it('per-med toggle: exact amount 2 applied first; final stock is 8', async () => {
    const callOrder: string[] = [];
    mockExactFirst(durable, callOrder, 2);

    const result = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      todayStr: '2026-09-14',
      globalAutoDeductEnabled: true,
    });
    expect(callOrder[0]).toBe('exact');
    expect(result.outcome).toBe('applied');
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
    mockExactFirst(durable, callOrder, 2);

    const result = await runGatedGlobalAutoDeductToggle({
      enable: false,
      todayStr: '2026-09-14',
    });
    expect(callOrder[0]).toBe('exact');
    expect(result.outcome).toBe('applied');
    expect(result.enable).toBe(false);
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
        lastSyncDate: '2026-09-14',
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

  it('runGatedAutoDeductToggle: exact first yields stock 8 not 9', async () => {
    const callOrder: string[] = [];
    mockExactFirst(durable, callOrder, 2);
    const result = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      todayStr: '2026-09-14',
      globalAutoDeductEnabled: true,
    });
    expect(callOrder[0]).toBe('exact');
    expect(result.medications[0].currentPills).toBe(8);
  });

  it('runGatedGlobalAutoDeductToggle: exact first yields stock 8', async () => {
    const callOrder: string[] = [];
    mockExactFirst(durable, callOrder, 2);
    const result = await runGatedGlobalAutoDeductToggle({
      enable: false,
      todayStr: '2026-09-14',
    });
    expect(callOrder[0]).toBe('exact');
    expect(result.medications[0].currentPills).toBe(8);
    expect(result.enable).toBe(false);
  });

  it('runGatedMedicationUpdate: exact first then dailyDose=3 yields stock 8', async () => {
    const callOrder: string[] = [];
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
    });
    expect(callOrder[0]).toBe('exact');
    expect(result.outcome).toBe('applied');
    expect(result.medications[0].dailyDose).toBe(3);
    expect(result.medications[0].currentPills).toBe(8);
  });
});
