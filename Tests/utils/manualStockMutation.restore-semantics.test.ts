import { requireDefined } from '../helpers/requireDefined';
import { __setStockMutationOrderingTestHooks, __resetStockMutationOrderingForTests, __setManualEnvelopeTestHooks, __setExactAutoEnvelopeStorageTestHooks, __setAutoStockGateTestHooks } from './autoStockTestHooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';
import type { ManualStockEnvelope } from '../../src/utils/stockEnvelopeRecovery';


import { makeScheduledMedication as med, makeAutoDeductionEvent as fired } from '../fixtures/testFixtures';
import { runGatedManualConsume, runGatedManualRestore } from '../../src/utils/manualStockMutation';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';


import { isDoseConsumedOnDate } from '../../src/utils/dateCalculations';
import { exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';

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
  autoSchedulingMocks.recoverAutoDeductionOccurrenceForCompensation.mockResolvedValue({ ok: true });
});
// findPending used indirectly via runGatedManualConsume

type TestManualStockEnvelope = Omit<ManualStockEnvelope, 'globalAutoDeductEnabled'> & {
  globalAutoDeductEnabled?: boolean;
};

const TODAY = '2026-09-16';




describe('Restore semantics through the durable gate', () => {
  let durable: AutoStockDurableState;
  let manualEnvelope: TestManualStockEnvelope | null;
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
    // Seed 10 pills: absolute assertions below expect 9 after a 1-pill Take.
    durable = { medications: [med({ currentPills: 10 })], logs: [], globalAutoDeductEnabled: false };
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
    load: () => manualEnvelope as ManualStockEnvelope | null,
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
        globalAutoDeductEnabled: durable.globalAutoDeductEnabled,
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
    __setExactAutoEnvelopeStorageTestHooks(null);
    __resetStockMutationOrderingForTests();
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
    expect(isDoseConsumedOnDate(requireDefined(durable.medications[0], 'durable.medications[0]'), 'd1', TODAY)).toBe(true);
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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    expect(generation).toBe(1);
    expect(marked).toEqual([]);
    expect(reconOnly.markedCount).toBe(0);
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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);

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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
    expect(durable.logs.some((l) => l.id === 'restore-crash-1')).toBe(true);
    expect(marked).toEqual([]);
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
          timestamp: `${TODAY}T08:00:00.000Z`,
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
          timestamp: `${TODAY}T08:00:00.000Z`,
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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseConsumptionHistory?.d2).toEqual([TODAY]);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseConsumptionHistory?.d1).toBeUndefined();

    // Second restore of d1 is no-op.
    const r2 = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-d1-2',
    });
    expect(r2.outcome).toBe('already_restored');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);

    // Take d1 after restore: one final deduction → 8.
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(8);
    // d2 still consumed independently.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseConsumptionHistory?.d2).toEqual([TODAY]);
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
          timestamp: `${TODAY}T08:00:00.000Z`,
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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(1);
  });
  it('zero actual Auto deduction Restore is rejected (no invented zero restore)', async () => {
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
          timestamp: `${TODAY}T08:00:00.000Z`,
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
    // Production fails closed on a zero-amount deduction record: there is no
    // positive deduction to reverse, so no restore log/marker is invented.
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('missing_deduction_evidence');
    expect(r.restoredAmount).toBe(0);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(0);
    // Nothing was mutated: the consume marker and the evidence log remain.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseConsumptionHistory?.d1).toEqual([TODAY]);
    expect(durable.logs.filter((l) => l.id === 'restore-zero')).toHaveLength(0);
  });
  it('Auto 3 → Restore = +3 (active deduction tracked)', async () => {
    durable = {
      medications: [med({ currentPills: 7, doseConsumptionHistory: { d1: [TODAY] } })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -3, date: TODAY, timestamp: `${TODAY}T08:00:00.000Z`, description: '', doseId: 'd1' }],
    };
    const r = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-auto-3' });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(3);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
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
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -3, date: TODAY, timestamp: `${TODAY}T08:00:00.000Z`, description: '', doseId: 'd1', reversedAt: 'already-reversed' }],
    };
    // Take d1 — clamped to available stock (1). currentPills 1 → 0.
    const take = await runGatedManualConsume({ medicationId: 'med-1', doseId: 'd1', source: 'manual', todayStr: TODAY });
    expect(take.outcome).toBe('applied');
    expect(take.doseAmount).toBe(1);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(0);
    // The dose_taken log has amount -1 (clamped).
    const takeLog = durable.logs.find((l) => l.type === 'dose_taken' && l.doseId === 'd1');
    expect(takeLog?.amount).toBe(-1);

    // Restore must reverse the Take (1), NOT the old Auto (3, already reversed).
    const r = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-take-1' });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(1);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(1);
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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(4);
    const r = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-manual-3' });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(3);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(7);
    // The dose_taken log is reversed by the Restore.
    const takeLog = durable.logs.find((l) => l.type === 'dose_taken' && l.doseId === 'd1');
    expect(takeLog?.reversedAt).toBeTruthy();
  });
  it('Auto 3 → Restore → Take 3 → Restore = +3 (reverses the second Take)', async () => {
    durable = {
      medications: [med({ currentPills: 7, doseConsumptionHistory: { d1: [TODAY] }, doseSchedule: [{ id: 'd1', amount: 3, time: '08:00' }], dosesPerDay: 1 })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -3, date: TODAY, timestamp: `${TODAY}T08:00:00.000Z`, description: '', doseId: 'd1' }],
    };
    // Restore the Auto (3).
    const r1 = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-auto-3b' });
    expect(r1.outcome).toBe('applied');
    expect(r1.restoredAmount).toBe(3);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
    // Take again (3). currentPills 10 → 7.
    const take = await runGatedManualConsume({ medicationId: 'med-1', doseId: 'd1', source: 'manual', todayStr: TODAY });
    expect(take.outcome).toBe('applied');
    expect(take.doseAmount).toBe(3);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(7);
    // Restore must reverse the Take (3), NOT the old Auto (3, already reversed).
    const r2 = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-take-3b' });
    expect(r2.outcome).toBe('applied');
    expect(r2.restoredAmount).toBe(3);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
  });
  it('Restore twice for the same occurrence does not add stock twice', async () => {
    durable = {
      medications: [med({ currentPills: 7, doseConsumptionHistory: { d1: [TODAY] } })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -3, date: TODAY, timestamp: `${TODAY}T08:00:00.000Z`, description: '', doseId: 'd1' }],
    };
    const r1 = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-1-dedup' });
    expect(r1.outcome).toBe('applied');
    expect(r1.restoredAmount).toBe(3);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
    const pillsAfterFirst = requireDefined(durable.medications[0], 'durable.medications[0]').currentPills;
    // Second Restore: occurrence already restored (consume marker cleared).
    const r2 = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-2-dedup' });
    expect(r2.outcome).toBe('already_restored');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(pillsAfterFirst);
    // No second restore log.
    expect(durable.logs.filter((l) => l.id === 'restore-2-dedup')).toHaveLength(0);
  });
  it('Dose A and Dose B same day: Restore A cannot reverse B\'s deduction', async () => {
    durable = {
      medications: [med({ currentPills: 8, doseConsumptionHistory: { d1: [TODAY], d2: [TODAY] } })],
      logs: [
        { id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -1, date: TODAY, timestamp: `${TODAY}T08:00:00.000Z`, description: '', doseId: 'd1' },
        { id: exactAutoLogId('med-1', 'd2', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -2, date: TODAY, timestamp: `${TODAY}T08:00:00.000Z`, description: '', doseId: 'd2' },
      ],
    };
    // Restore d1 → reverses auto-a (1), NOT auto-b (2).
    const r = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-a' });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(1);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    // d2 still consumed; auto-b (d2) NOT reversed.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseConsumptionHistory?.d2).toEqual([TODAY]);
    expect(
      durable.logs.find((l) => l.id === exactAutoLogId('med-1', 'd2', TODAY))
        ?.reversedAt
    ).toBeUndefined();
    // auto-a (d1) IS reversed.
    expect(
      durable.logs.find((l) => l.id === exactAutoLogId('med-1', 'd1', TODAY))
        ?.reversedAt
    ).toBeTruthy();
  });
  it('Old reversed deduction is not picked as the active deduction for a later Restore', async () => {
    // Two deductions for the same occurrence: old (reversed) + new (active).
    durable = {
      medications: [med({ currentPills: 6, doseConsumptionHistory: { d1: [TODAY] } })],
      logs: [
        { id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -4, date: TODAY, timestamp: `${TODAY}T08:00:00.000Z`, description: '', doseId: 'd1', reversedAt: 'old' },
        { id: 'new-deduct', medicationId: 'med-1', medicationName: 'TestMed', type: 'dose_taken', amount: -4, date: TODAY, timestamp: `${TODAY}T08:00:00.000Z`, description: '', doseId: 'd1' },
      ],
    };
    // Restore must find new-deduct (4), NOT old-deduct (4, reversed).
    const r = await runGatedManualRestore({ medicationId: 'med-1', doseId: 'd1', todayStr: TODAY, makeLogId: () => 'restore-new' });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(4);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
    // new-deduct reversed; old-deduct stays reversed.
    expect(durable.logs.find((l) => l.id === 'new-deduct')?.reversedAt).toBeTruthy();
    expect(
      durable.logs.find((l) => l.id === exactAutoLogId('med-1', 'd1', TODAY))
        ?.reversedAt
    ).toBe('old');
    // restore log links to new-deduct, NOT old-deduct.
    expect(durable.logs.find((l) => l.id === 'restore-new')?.relatedLogId).toBe('new-deduct');
  });
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
          timestamp: `${TODAY}T08:00:00.000Z`,
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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
    // Consumption cleared for d1.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseConsumptionHistory?.d1).toBeUndefined();
    // Durable skip left for the SAME occurrence so projection cannot re-add d1.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseSkippedHistory?.d1).toEqual([TODAY]);
    // Sibling d2 untouched (not skipped, not consumed).
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseSkippedHistory?.d2).toBeUndefined();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseConsumptionHistory?.d2).toBeUndefined();

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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
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
      ],
      logs: [
        {
          id: exactAutoLogId('med-1', 'd1', TODAY),
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'exact_auto',
          amount: -1,
          date: TODAY,
          timestamp: `${TODAY}T08:00:00.000Z`,
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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
    // Skip left so Auto cannot re-deduct before Take.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseSkippedHistory?.d1).toEqual([TODAY]);

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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    // Skip cleared by Take; consume marker set once.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseSkippedHistory?.d1).toBeUndefined();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseConsumptionHistory?.d1).toEqual([TODAY]);
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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    const pillsAfterTake = requireDefined(durable.medications[0], 'durable.medications[0]').currentPills;

    // Restore d1 (time 08:00 has passed at 15:00) → skip left, consume cleared.
    const restore = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-after-manual',
    });
    expect(restore.outcome).toBe('applied');
    expect(restore.restoredAmount).toBe(1);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseConsumptionHistory?.d1).toBeUndefined();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseSkippedHistory?.d1).toEqual([TODAY]);

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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).not.toBe(pillsAfterTake);
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
    const pillsAfterTake = requireDefined(durable.medications[0], 'durable.medications[0]').currentPills;

    const restore = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd3',
      todayStr: TODAY,
      makeLogId: () => 'restore-future-d3',
    });
    expect(restore.outcome).toBe('applied');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(pillsAfterTake + 2);
    // Future restore: NO durable skip (d3 stays eligible for time-gated Auto).
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseSkippedHistory?.d3).toBeUndefined();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseConsumptionHistory?.d3).toBeUndefined();
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
    const pillsBeforeRestore = requireDefined(durable.medications[0], 'durable.medications[0]').currentPills;

    const r = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-d1-only',
    });
    expect(r.outcome).toBe('applied');
    expect(r.restoredAmount).toBe(1);
    // d1 restored (skip left, consume cleared); d2 still consumed.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseSkippedHistory?.d1).toEqual([TODAY]);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseConsumptionHistory?.d1).toBeUndefined();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseConsumptionHistory?.d2).toEqual([TODAY]);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').doseSkippedHistory?.d2).toBeUndefined();
    // Only d1's amount credited back.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(pillsBeforeRestore + 1);
  });
});
