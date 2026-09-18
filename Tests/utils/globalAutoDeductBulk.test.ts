import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '@/types';
import { runGatedGlobalAutoDeductToggle } from '@/utils/manualStockMutation';
import {
  __setManualEnvelopeTestHooks,
} from '@/utils/stockEnvelopeRecovery';
import {
  __setAutoStockGateTestHooks,
  type AutoStockDurableState,
} from '@/utils/autoDeductionStockGate';
import * as preSettleModule from '@/utils/reconcileExactBeforeLegacySettlement';

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
    lastSyncDate: '2026-09-14',
    autoDeductEnabled: true,
    ...over,
  };
}

describe('runGatedGlobalAutoDeductToggle — bulk medication Auto state', () => {
  let durable: AutoStockDurableState;
  let manualEnvelope: unknown = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
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
      'reconcileExactBeforeLegacySettlement'
    ).mockImplementation(async (opts) => ({
      state: opts.fresh,
      reconciliation: null,
      nativeListFailed: false,
      durabilityBlocked: false,
    }));
  });

  afterEach(() => {
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('Global OFF sets every existing medication to autoDeductEnabled=false without stock settle', async () => {
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
    expect(durable.medications.map((m) => m.autoDeductEnabled)).toEqual([
      false,
      false,
      false,
    ]);
    expect(durable.globalAutoDeductEnabled).toBe(false);
  });

  it('Global ON sets every existing medication to autoDeductEnabled=true without stock settle', async () => {
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
    expect(durable.medications.every((m) => m.autoDeductEnabled === true)).toBe(true);
    expect(durable.globalAutoDeductEnabled).toBe(true);
  });
});
