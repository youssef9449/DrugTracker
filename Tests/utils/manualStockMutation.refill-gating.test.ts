import { requireDefined } from '../helpers/requireDefined';
import { __setStockMutationOrderingTestHooks, __resetStockMutationOrderingForTests, __setManualEnvelopeTestHooks, __setExactAutoEnvelopeStorageTestHooks, __setAutoStockGateTestHooks } from './autoStockTestHooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';
import type { ManualStockEnvelope } from '../../src/utils/stockEnvelopeRecovery';


import { makeScheduledMedication as med } from '../fixtures/testFixtures';
import { runGatedManualConsume, runGatedRefill, runGatedUndoRefill } from '../../src/utils/manualStockMutation';



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




describe('Refill/UndoRefill through the durable gate', () => {
  let durable: AutoStockDurableState;
  let manualEnvelope: TestManualStockEnvelope | null;
  let failLogs: boolean;
  let failClear: boolean;
  let failBump: boolean;
  let failLastApplied: boolean;
  let failAllocate: boolean;
  let generation: number;

    beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T15:00:00`));
    durable = { medications: [med()], logs: [], globalAutoDeductEnabled: false };
    manualEnvelope = null;
    failLogs = false;
    failClear = false;
    failBump = false;
    failLastApplied = false;
    failAllocate = false;
    generation = 0;
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
  it('runGatedRefill adds pills through the gate (serialized with Take/Restore)', async () => {
    durable = { medications: [med({ currentPills: 5 })], logs: [] };
    const r = await runGatedRefill({ medicationId: 'med-1', addedPills: 10, todayStr: TODAY });
    expect(r.outcome).toBe('applied');
    expect(r.addedPills).toBe(10);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(15);
    expect(durable.logs.some((l) => l.type === 'refill' && l.amount === 10)).toBe(true);
  });
  it('runGatedRefill: addedPills <= 0 is rejected (no mutation)', async () => {
    durable = { medications: [med({ currentPills: 5 })], logs: [] };
    const r = await runGatedRefill({ medicationId: 'med-1', addedPills: 0, todayStr: TODAY });
    expect(r.outcome).toBe('rejected');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(5);
    expect(durable.logs).toHaveLength(0);
  });
  it('runGatedUndoRefill reverses the most recent un-reversed refill through the gate', async () => {
    durable = {
      medications: [med({ currentPills: 15 })],
      logs: [{ id: 'refill-1', medicationId: 'med-1', medicationName: 'TestMed', type: 'refill', amount: 10, date: TODAY, timestamp: `${TODAY}T10:00:00.000Z`, description: '' }],
    };
    const r = await runGatedUndoRefill({ medicationId: 'med-1', todayStr: TODAY, makeLogId: () => 'refill-undo-1' });
    expect(r.outcome).toBe('applied');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBeLessThan(15);
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
      logs: [{ id: 'refill-done', medicationId: 'med-1', medicationName: 'TestMed', type: 'refill', amount: 10, date: TODAY, timestamp: `${TODAY}T10:00:00.000Z`, description: '', reversedAt: 'already' }],
    };
    const r = await runGatedUndoRefill({ medicationId: 'med-1', todayStr: TODAY });
    expect(r.outcome).toBe('rejected');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(5);
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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(14);
    expect(durable.logs.some((l) => l.type === 'dose_taken' && l.doseId === 'd1')).toBe(true);
    expect(durable.logs.some((l) => l.type === 'refill' && l.amount === 5)).toBe(true);
  });
  it('runGatedUndoRefill reverses only the ACTUAL reversible amount (clamped), not the full refill.amount', async () => {
    // Med has currentPills=5 (autoDeduct OFF → effective = currentPills = 5).
    // A refill log of +10 exists but only 5 is actually reversible (settleBase=5).
    // Undo must record -5 in the refill_undo log, not -10.
    durable = {
      medications: [med({ currentPills: 5, autoDeductEnabled: false})],
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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(0);
    // The original refill is marked reversed.
    expect(durable.logs.find((l) => l.id === 'refill-10')?.reversedAt).toBeTruthy();
  });
  it('runGatedUndoRefill with full reversible amount reverses the full refill.amount', async () => {
    // currentPills=20 → settleBase=20 → full 10 is reversible.
    durable = {
      medications: [med({ currentPills: 20, autoDeductEnabled: false})],
      logs: [
        { id: 'refill-full', medicationId: 'med-1', medicationName: 'TestMed', type: 'refill', amount: 10, date: TODAY, timestamp: '2026-09-16T10:00:00.000Z', description: 'refill' },
      ],
    };
    const r = await runGatedUndoRefill({ medicationId: 'med-1', todayStr: TODAY, makeLogId: () => 'undo-full' });
    expect(r.outcome).toBe('applied');
    expect(r.addedPills).toBe(-10);
    expect(r.log?.amount).toBe(-10);
    // Stock dropped by 10 (settleBase=20, -10 → 10).
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(10);
    expect(durable.logs.find((l) => l.id === 'refill-full')?.reversedAt).toBeTruthy();
  });
  it('runGatedUndoRefill with zero reversible quantity records actual 0, not -refill.amount', async () => {
    // currentPills=0 → settleBase=0 → nothing to reverse.
    durable = {
      medications: [med({ currentPills: 0, autoDeductEnabled: false})],
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
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(0);
    // The refill is still marked reversed (the undo consumed the refill).
    expect(durable.logs.find((l) => l.id === 'refill-zero')?.reversedAt).toBeTruthy();
  });
  it('runGatedUndoRefill: second undo of the same refill is rejected (no double reversal)', async () => {
    durable = {
      medications: [med({ currentPills: 20, autoDeductEnabled: false})],
      logs: [
        { id: 'refill-dbl', medicationId: 'med-1', medicationName: 'TestMed', type: 'refill', amount: 10, date: TODAY, timestamp: '2026-09-16T10:00:00.000Z', description: 'refill' },
      ],
    };
    const r1 = await runGatedUndoRefill({ medicationId: 'med-1', todayStr: TODAY, makeLogId: () => 'undo-1' });
    expect(r1.outcome).toBe('applied');
    expect(r1.addedPills).toBe(-10);
    const pillsAfterFirst = requireDefined(durable.medications[0], 'durable.medications[0]').currentPills;

    // Second undo: the refill is now reversed → rejected.
    const r2 = await runGatedUndoRefill({ medicationId: 'med-1', todayStr: TODAY, makeLogId: () => 'undo-2' });
    expect(r2.outcome).toBe('rejected');
    // No additional stock change.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(pillsAfterFirst);
    // No second undo log.
    expect(durable.logs.filter((l) => l.id === 'undo-2')).toHaveLength(0);
  });
});
