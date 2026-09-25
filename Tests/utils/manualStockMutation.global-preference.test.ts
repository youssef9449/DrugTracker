import { requireDefined } from '../helpers/requireDefined';
import { __setManualEnvelopeTestHooks, __setAutoStockGateTestHooks } from './autoStockTestHooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';
import type { ManualStockEnvelope } from '../../src/utils/stockEnvelopeRecovery';


import { makeScheduledMedication as med } from '../fixtures/testFixtures';
import { runGatedAddMedication, runGatedAutoDeductToggle, runGatedGlobalAutoDeductToggle } from '../../src/utils/manualStockMutation';



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

describe('durable global preference and add-medication ordering', () => {
  let durable: AutoStockDurableState;
  let manualEnvelope: ManualStockEnvelope | null;
  let persistedGlobal: boolean;
  let failGlobalPersist: boolean;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-16T15:00:00'));
    durable = {
      medications: [med()],
      logs: [],
      globalAutoDeductEnabled: true,
    };
    manualEnvelope = null;
    persistedGlobal = true;
    failGlobalPersist = false;

    __setManualEnvelopeTestHooks({
      load: () => manualEnvelope,
      save: (env) => {
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
        durable = {
          medications: state.medications.map((m) => ({ ...m })),
          logs: state.logs.map((l) => ({ ...l })),
          globalAutoDeductEnabled: state.globalAutoDeductEnabled,
        };
        return null;
      },
      persistGlobal: (value) => {
        if (failGlobalPersist) return 'global_persist_failed';
        persistedGlobal = value;
        return null;
      },
    });
  });

  afterEach(() => {
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    vi.useRealTimers();
  });

  it('per-med toggle preserves the durable global master switch', async () => {
    durable = {
      medications: [med({ autoDeductEnabled: true })],
      logs: [],
      globalAutoDeductEnabled: false,
    };

    const result = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      globalAutoDeductEnabled: false,
    });

    expect(result.outcome).toBe('applied');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').autoDeductEnabled).toBe(true);
    expect(durable.globalAutoDeductEnabled).toBe(false);
  });

  it('global toggle persists only the master switch inside the same durable commit path', async () => {
    const result = await runGatedGlobalAutoDeductToggle({ enable: false });

    expect(result.outcome).toBe('applied');
    expect(durable.globalAutoDeductEnabled).toBe(false);
    expect(persistedGlobal).toBe(false);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').autoDeductEnabled).toBe(true);
  });

  it('global persistence failure keeps the mutation envelope for restart recovery', async () => {
    failGlobalPersist = true;

    const result = await runGatedGlobalAutoDeductToggle({ enable: false });

    expect(result.outcome).toBe('persist_failed');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').autoDeductEnabled).toBe(true);
    expect(persistedGlobal).toBe(true);
    expect(manualEnvelope?.globalAutoDeductEnabled).toBe(false);
  });

  it('new medication preserves an explicit per-med Auto-Deduction choice over the global default', async () => {
    durable = {
      medications: [med({ id: 'existing', currentPills: 7 })],
      logs: [],
      globalAutoDeductEnabled: false,
    };

    const newMedication = med({
      id: 'new-med',
      name: 'NewMed',
      currentPills: 20,
      autoDeductEnabled: true,
    });

    const result = await runGatedAddMedication({ medication: newMedication });

    expect(result.outcome).toBe('applied');
    expect(durable.medications.map((m) => m.id)).toEqual(['new-med', 'existing']);
    expect(durable.medications.find((m) => m.id === 'existing')?.currentPills).toBe(7);
    expect(durable.medications.find((m) => m.id === 'new-med')?.autoDeductEnabled).toBe(true);
    expect(durable.globalAutoDeductEnabled).toBe(false);
  });

  it('new medication inherits the durable global default when no per-med choice is supplied', async () => {
    durable = {
      medications: [med({ id: 'existing', currentPills: 7 })],
      logs: [],
      globalAutoDeductEnabled: false,
    };

    const newMedication = med({
      id: 'new-med',
      name: 'NewMed',
      currentPills: 20,
    });
    delete newMedication.autoDeductEnabled;

    const result = await runGatedAddMedication({ medication: newMedication });

    expect(result.outcome).toBe('applied');
    expect(durable.medications.find((m) => m.id === 'new-med')?.autoDeductEnabled).toBe(false);
    expect(durable.globalAutoDeductEnabled).toBe(false);
  });
});
