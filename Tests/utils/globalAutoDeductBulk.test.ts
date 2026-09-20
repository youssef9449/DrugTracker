import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication } from '@/types';
import {
  runGatedGlobalAutoDeductToggle,
  __setManualRecurrenceInvalidationTestHook } from '@/utils/manualStockMutation';
import { __setManualEnvelopeTestHooks } from '@/utils/stockEnvelopeRecovery';
import {
  __setAutoStockGateTestHooks,
  type AutoStockDurableState } from '@/utils/autoDeductionStockGate';
import * as preSettleModule from '@/utils/reconcileExactBeforeManualMutation';
import * as autoNative from '@/utils/autoDeductionNative';

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
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 1, time: '20:00' },
    ],
    dosesPerDay: 2,
    ...over,
  };
}

describe('runGatedGlobalAutoDeductToggle — bulk + Global OFF invalidation order', () => {
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
        med({ id: 'a', name: 'A', autoDeductEnabled: true, currentPills: 11 }),
        med({ id: 'b', name: 'B', autoDeductEnabled: false, currentPills: 22 }),
        med({ id: 'c', name: 'C', autoDeductEnabled: true, currentPills: 33 }),
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
      persistGlobal: () => null,
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

    __setManualRecurrenceInvalidationTestHook(async (medicationId, doseId) => {
      invalidationCalls.push({ medId: medicationId, doseId });
      return { ok: true };
    });

    vi.spyOn(autoNative, 'scheduleAutoDeduction').mockImplementation(async (args) => {
      scheduleCalls.push({ medId: args.medicationId, doseId: args.doseId });
      return { ok: true };
    });
  });

  afterEach(() => {
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __setManualRecurrenceInvalidationTestHook(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('Global OFF: invalidates native recurrences then bulk-sets all meds OFF without stock settle', async () => {
    const pillsBefore = durable.medications.map((m) => m.currentPills);
    const logsBefore = durable.logs.length;

    const result = await runGatedGlobalAutoDeductToggle({
      enable: false,
      todayStr: '2026-09-14',
    });

    expect(result.outcome).toBe('applied');
    expect(result.enable).toBe(false);
    expect(result.medications.map((m) => m.autoDeductEnabled)).toEqual([
      false,
      false,
      false,
    ]);
    expect(result.medications.map((m) => m.currentPills)).toEqual(pillsBefore);
    expect(result.settleLogs).toEqual([]);
    expect(result.logs.length).toBe(logsBefore);
    expect(durable.globalAutoDeductEnabled).toBe(false);
    // Invalidation ran for each dose of each med before durable commit.
    expect(invalidationCalls.length).toBeGreaterThan(0);
    const medIdsInvalidated = new Set(invalidationCalls.map((c) => c.medId));
    expect(medIdsInvalidated.has('a')).toBe(true);
    expect(medIdsInvalidated.has('b')).toBe(true);
    expect(medIdsInvalidated.has('c')).toBe(true);
    expect(commitCalls).toBe(1);
  });

  it('Global ON: bulk-sets all meds ON without native invalidation', async () => {
    durable = {
      medications: [
        med({ id: 'a', autoDeductEnabled: false, currentPills: 5 }),
        med({ id: 'b', autoDeductEnabled: false, currentPills: 9 }),
      ],
      logs: [],
      globalAutoDeductEnabled: false,
    };
    const pillsBefore = durable.medications.map((m) => m.currentPills);

    const result = await runGatedGlobalAutoDeductToggle({
      enable: true,
      todayStr: '2026-09-14',
    });

    expect(result.outcome).toBe('applied');
    expect(result.enable).toBe(true);
    expect(result.medications.every((m) => m.autoDeductEnabled === true)).toBe(true);
    expect(result.medications.map((m) => m.currentPills)).toEqual(pillsBefore);
    expect(result.settleLogs).toEqual([]);
    expect(invalidationCalls).toEqual([]);
    expect(commitCalls).toBe(1);
    expect(durable.globalAutoDeductEnabled).toBe(true);
  });

  it('Global OFF: native invalidation failure does not bulk-commit OFF', async () => {
    __setManualRecurrenceInvalidationTestHook(async (medicationId, doseId) => {
      invalidationCalls.push({ medId: medicationId, doseId });
      if (medicationId === 'c') {
        return { ok: false, error: 'native_fail_test' };
      }
      return { ok: true };
    });

    const result = await runGatedGlobalAutoDeductToggle({
      enable: false,
      todayStr: '2026-09-14',
    });

    expect(result.outcome).toBe('native_invalidation_failed');
    expect(result.reason).toBe('native_fail_test');
    expect(commitCalls).toBe(0);
    expect(durable.globalAutoDeductEnabled).toBe(true);
    expect(durable.medications.map((m) => m.autoDeductEnabled)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('Global OFF: partial invalidation restores successfully invalidated recurrences', async () => {
    __setManualRecurrenceInvalidationTestHook(async (medicationId, doseId) => {
      invalidationCalls.push({ medId: medicationId, doseId });
      // Fail after med a fully invalidated (all its doses succeed first).
      if (medicationId === 'b') {
        return { ok: false, error: 'partial_fail' };
      }
      return { ok: true };
    });

    const result = await runGatedGlobalAutoDeductToggle({
      enable: false,
      todayStr: '2026-09-14',
    });

    expect(result.outcome).toBe('native_invalidation_failed');
    expect(result.reason).toBe('partial_fail');
    expect(commitCalls).toBe(0);
    expect(durable.globalAutoDeductEnabled).toBe(true);
    // Compensation: restore schedules for meds fully invalidated before the failure.
    expect(scheduleCalls.some((c) => c.medId === 'a')).toBe(true);
  });
});
