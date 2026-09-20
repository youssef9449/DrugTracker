import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';
import type { Medication } from '../../src/types';
import {
  __setAutoStockGateTestHooks } from '../../src/utils/autoDeductionStockGate';

function baseMed(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'TestMed',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    ...over,
  };
}

describe('listFired explicit result (native read failure vs empty)', () => {
  beforeEach(() => {
    __setAutoStockGateTestHooks({
      load: () => ({ medications: [baseMed()], logs: [] }),
      commit: () => null,
    });
  });
  afterEach(() => {
    __setAutoStockGateTestHooks(null);
  });

  it('native list failure does not mutate stock and reports nativeListFailed', async () => {
    const result = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      medications: [baseMed({ currentPills: 30 })],
      logs: [],
      alreadyInGate: true,
      listFired: async () => ({ ok: false, events: [], error: 'native_boom' }),
      markReconciled: async () => ({ ok: true, changed: true }),
    });
    expect(result.nativeListFailed).toBe(true);
    expect(result.mutated).toBe(false);
    expect(result.medications[0].currentPills).toBe(30);
    expect(result.toAcknowledge).toHaveLength(0);
  });

  it('valid empty native state is distinct from failure', async () => {
    const result = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      medications: [baseMed({ currentPills: 30 })],
      logs: [],
      alreadyInGate: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async () => ({ ok: true, changed: true }),
    });
    expect(result.nativeListFailed).toBeFalsy();
    expect(result.mutated).toBe(false);
    expect(result.medications[0].currentPills).toBe(30);
  });
});
