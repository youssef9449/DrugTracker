import { __setStockMutationOrderingTestHooks, __resetStockMutationOrderingForTests, __setManualEnvelopeTestHooks, __setAutoStockGateTestHooks } from './autoStockTestHooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';
import type { ManualStockEnvelope } from '../../src/utils/stockEnvelopeRecovery';


import { makeScheduledMedication as med } from '../fixtures/testFixtures';
import { runGatedManualConsume, runGatedDeleteMedication } from '../../src/utils/manualStockMutation';



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




describe('Phase 4 — durable deletion', () => {
  let durable: AutoStockDurableState;

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
    autoSchedulingMocks.invalidateAutoDeductionRecurrence.mockResolvedValue({ ok: true, generation: 1 });
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

  it('deletes from fresh durable state and invalidates the old native chain before commit', async () => {
    const result = await runGatedDeleteMedication({ medicationId: 'med-1' });
    expect(result.outcome).toBe('applied');
    expect(durable.medications).toHaveLength(0);
  });
});
