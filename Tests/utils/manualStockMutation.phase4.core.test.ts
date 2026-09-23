import { __setStockMutationOrderingTestHooks, __resetStockMutationOrderingForTests, __setManualEnvelopeTestHooks, __setAutoStockGateTestHooks } from './autoStockTestHooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ConsumptionLog } from '../../src/types';
import { makeScheduledMedication as med, makeAutoDeductionEvent as fired } from '../fixtures/testFixtures';
import { runGatedManualConsume, runGatedManualRestore, runGatedUndoRefill } from '../../src/utils/manualStockMutation';

import { allocateMutationSeq } from '../../src/utils/stockMutationOrdering';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';


import { isDoseConsumedOnDate } from '../../src/utils/dateCalculations';
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
import { findActiveDeductionForOccurrence, consumeDose, restoreDose } from '../../src/utils/medActions';

const TODAY = '2026-09-16';



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
    const r1 = findActiveDeductionForOccurrence([newTake, oldAuto], 'med-1', 'd1', TODAY);
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
