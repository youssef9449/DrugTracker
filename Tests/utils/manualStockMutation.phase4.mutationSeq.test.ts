import { __setStockMutationOrderingTestHooks, __resetStockMutationOrderingForTests, __setManualEnvelopeTestHooks, __setAutoStockGateTestHooks } from './autoStockTestHooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';
import type { ManualStockEnvelope } from '../../src/utils/stockEnvelopeRecovery';


import { makeScheduledMedication as med } from '../fixtures/testFixtures';
import { runGatedManualConsume } from '../../src/utils/manualStockMutation';
import { allocateMutationSeq, persistLastAppliedMutationSeq, loadLastAppliedMutationSeq } from '../../src/utils/stockMutationOrdering';



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
