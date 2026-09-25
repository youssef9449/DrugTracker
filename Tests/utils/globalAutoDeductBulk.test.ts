import {
  __setManualEnvelopeTestHooks,
  __setAutoStockGateTestHooks,
} from './autoStockTestHooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication } from '@/types';
import { runGatedGlobalAutoDeductToggle } from '@/utils/manualStockMutation';
import type { AutoStockDurableState } from '@/utils/autoDeductionStockGate';
import * as preSettleModule from '@/utils/reconcileExactBeforeManualMutation';

const autoSchedulingMocks = vi.hoisted(() => ({
  invalidateAutoDeductionRecurrence: vi.fn(),
  scheduleAutoDeduction: vi.fn(),
  recoverAutoDeductionOccurrence: vi.fn(),
}));

vi.mock('@/utils/autoDeductionNativeScheduling', async () => {
  const actual = await vi.importActual<typeof import('@/utils/autoDeductionNativeScheduling')>(
    '@/utils/autoDeductionNativeScheduling'
  );
  return {
    ...actual,
    ...autoSchedulingMocks,
  };
});

function med(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'TestMed',
    currentPills: 20,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    doseSchedule: [
      { id: 'd1', amount: 1, time: '16:00' },
      { id: 'd2', amount: 1, time: '20:00' },
    ],
    dosesPerDay: 2,
    isChronic: true,
    ...over,
  };
}

describe('runGatedGlobalAutoDeductToggle — global kill switch', () => {
  let durable: AutoStockDurableState;
  let manualEnvelope: unknown = null;
  let commitCalls: number;
  const invalidationCalls: Array<{ medId: string; doseId: string }> = [];
  const scheduleCalls: Array<{ medId: string; doseId: string }> = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
    commitCalls = 0;
    invalidationCalls.length = 0;
    scheduleCalls.length = 0;
    durable = {
      medications: [
        med({
          id: 'a',
          name: 'A',
          autoDeductEnabled: true,
          currentPills: 11,
        }),
        med({
          id: 'b',
          name: 'B',
          autoDeductEnabled: false,
          currentPills: 22,
        }),
        med({
          id: 'c',
          name: 'C',
          autoDeductEnabled: true,
          currentPills: 33,
        }),
      ],
      logs: [],
      globalAutoDeductEnabled: true,
    };
    manualEnvelope = null;

    __setManualEnvelopeTestHooks({
      load: () => manualEnvelope as never,
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
        commitCalls += 1;
        durable = {
          medications: state.medications.map((m) => ({ ...m })),
          logs: state.logs.map((l) => ({ ...l })),
          globalAutoDeductEnabled: state.globalAutoDeductEnabled,
        };
        return null;
      },
      persistGlobal: (value) => {
        durable.globalAutoDeductEnabled = value;
        return null;
      },
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

    autoSchedulingMocks.invalidateAutoDeductionRecurrence.mockImplementation(
      async (medicationId, doseId) => {
        invalidationCalls.push({ medId: medicationId, doseId });
        return { ok: true, generation: 1 };
      }
    );
    autoSchedulingMocks.scheduleAutoDeduction.mockImplementation(async (args) => {
      scheduleCalls.push({ medId: args.medicationId, doseId: args.doseId });
      return { ok: true };
    });
  });

  afterEach(() => {
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    autoSchedulingMocks.invalidateAutoDeductionRecurrence.mockReset();
    autoSchedulingMocks.scheduleAutoDeduction.mockReset();
    autoSchedulingMocks.recoverAutoDeductionOccurrence.mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('Global OFF preserves every medication Auto preference and stock state while invalidating only per-med ON recurrences', async () => {
    const medsBefore = durable.medications.map((m) => m.autoDeductEnabled);
    const pillsBefore = durable.medications.map((m) => m.currentPills);
    const logsBefore = durable.logs.map((l) => ({ ...l }));

    const result = await runGatedGlobalAutoDeductToggle({
      enable: false,
      todayStr: '2026-09-14',
    });

    expect(result.outcome).toBe('applied');
    expect(result.enable).toBe(false);
    expect(durable.globalAutoDeductEnabled).toBe(false);
    expect(durable.medications.map((m) => m.autoDeductEnabled)).toEqual(medsBefore);
    expect(durable.medications.map((m) => m.currentPills)).toEqual(pillsBefore);
    expect(durable.logs).toEqual(logsBefore);
    expect(result.settleLogs).toEqual([]);
    expect(commitCalls).toBe(1);

    const invalidatedMedIds = new Set(invalidationCalls.map((c) => c.medId));
    expect(invalidatedMedIds).toEqual(new Set(['a', 'c']));
    expect(invalidationCalls).toHaveLength(4);
  });

  it('Global ON changes only the master switch and keeps mixed per-med preferences intact', async () => {
    durable.globalAutoDeductEnabled = false;

    const result = await runGatedGlobalAutoDeductToggle({ enable: true });

    expect(result.outcome).toBe('applied');
    expect(result.enable).toBe(true);
    expect(durable.globalAutoDeductEnabled).toBe(true);
    expect(durable.medications.map((m) => m.autoDeductEnabled)).toEqual([true, false, true]);
    expect(invalidationCalls).toEqual([]);
    expect(scheduleCalls).toEqual([]);
    expect(commitCalls).toBe(1);
  });

  it('Global OFF native invalidation failure leaves the master switch and medication preferences unchanged', async () => {
    autoSchedulingMocks.invalidateAutoDeductionRecurrence.mockImplementation(
      async (medicationId, doseId) => {
        invalidationCalls.push({ medId: medicationId, doseId });
        if (medicationId === 'c') {
          return { ok: false, error: 'native_fail_test' };
        }
        return { ok: true, generation: 1 };
      }
    );

    const result = await runGatedGlobalAutoDeductToggle({ enable: false });

    expect(result.outcome).toBe('native_invalidation_failed');
    expect(result.reason).toBe('native_fail_test');
    expect(commitCalls).toBe(0);
    expect(durable.globalAutoDeductEnabled).toBe(true);
    expect(durable.medications.map((m) => m.autoDeductEnabled)).toEqual([true, false, true]);
  });

  it('Global OFF compensates earlier recurrence invalidations when a later medication fails', async () => {
    autoSchedulingMocks.invalidateAutoDeductionRecurrence.mockImplementation(
      async (medicationId, doseId) => {
        invalidationCalls.push({ medId: medicationId, doseId });
        if (medicationId === 'c') {
          return { ok: false, error: 'partial_fail' };
        }
        return { ok: true, generation: 1 };
      }
    );

    const result = await runGatedGlobalAutoDeductToggle({ enable: false });

    expect(result.outcome).toBe('native_invalidation_failed');
    expect(result.reason).toBe('partial_fail');
    expect(commitCalls).toBe(0);
    expect(durable.globalAutoDeductEnabled).toBe(true);
    expect(durable.medications.map((m) => m.autoDeductEnabled)).toEqual([true, false, true]);
    expect(scheduleCalls.some((c) => c.medId === 'a')).toBe(true);
  });

  it('Global OFF persistence failure keeps the original per-med preferences', async () => {
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
        globalAutoDeductEnabled: durable.globalAutoDeductEnabled,
      }),
      commit: () => 'persist_failed',
      persistGlobal: () => 'persist_failed',
    });

    const result = await runGatedGlobalAutoDeductToggle({ enable: false });

    expect(result.outcome).toBe('persist_failed');
    expect(durable.medications.map((m) => m.autoDeductEnabled)).toEqual([true, false, true]);
    expect(result.medications.map((m) => m.autoDeductEnabled)).toEqual([true, false, true]);
  });
});
