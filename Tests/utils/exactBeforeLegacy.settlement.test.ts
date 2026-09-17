/**
 * Regression: durable native FIRED amount must win over current schedule amount
 * when exact reconciliation runs before any legacy settlement path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNative';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';
import { reconcileFiredEvents, exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';
import {
  runGatedAutoDeductToggle,
} from '../../src/utils/manualStockMutation';
import {
  __setAutoStockGateTestHooks,
} from '../../src/utils/autoDeductionStockGate';
import {
  __setManualEnvelopeTestHooks,
} from '../../src/utils/manualStockMutation';
import { __setExactAutoEnvelopeTestHooks } from '../../src/utils/runAutoDeductionReconciliation';
import { syncAutoDailyDeductions } from '../../src/utils/dateCalculations';

function baseMed(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'TestMed',
    currentPills: 10,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSyncDate: '2026-09-14',
    autoDeductEnabled: true,
    doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    ...over,
  };
}

function firedEvent(amount: number): AutoDeductionEvent {
  return {
    medicationId: 'med-1',
    doseId: 'd1',
    calendarDate: '2026-09-14',
    amount,
    status: 'FIRED',
    scheduledAtEpochMs: 1,
    createdAtEpochMs: 1,
    reconciledAtEpochMs: null,
  };
}

describe('exact FIRED amount precedes legacy settlement', () => {
  let durable: { medications: Medication[]; logs: ConsumptionLog[] };

  beforeEach(() => {
    durable = {
      medications: [baseMed({ currentPills: 10, lastSyncDate: '2026-09-14' })],
      logs: [],
    };
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: [...durable.logs],
      }),
      commit: (state) => {
        durable = {
          medications: state.medications.map((m) => ({ ...m })),
          logs: [...state.logs],
        };
        return null;
      },
    });
    __setManualEnvelopeTestHooks({
      load: () => null,
      save: () => null,
    });
    __setExactAutoEnvelopeTestHooks({
      load: () => null,
      save: () => null,
    });
  });

  afterEach(() => {
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __setExactAutoEnvelopeTestHooks(null);
  });

  it('reconcileFiredEvents uses event.amount=2 not schedule amount=1', () => {
    const med = baseMed({ currentPills: 10, lastSyncDate: '2026-09-14' });
    const r = reconcileFiredEvents([med], [], [firedEvent(2)]);
    expect(r.medications[0].currentPills).toBe(8);
    expect(r.newExactLogs).toHaveLength(1);
    expect(r.newExactLogs[0].amount).toBe(-2);
    expect(r.medications[0].currentPills).not.toBe(7);
    expect(r.medications[0].currentPills).not.toBe(9);
  });

  it('runAutoDeductionReconciliation then legacy sync does not double-charge', async () => {
    const events = [firedEvent(2)];
    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      medications: durable.medications,
      logs: durable.logs,
      alreadyInGate: true,
      listFired: async () => ({ ok: true, events }),
      markReconciled: async () => ({ ok: true, changed: true }),
    });
    expect(recon.medications[0].currentPills).toBe(8);
    const exactId = exactAutoLogId('med-1', 'd1', '2026-09-14');
    expect(recon.logs.some((l) => l.id === exactId)).toBe(true);

    const legacy = syncAutoDailyDeductions(recon.medications, '2026-09-14');
    expect(legacy.updatedMeds[0].currentPills).toBe(8);
  });

  it('per-med toggle after exact apply does not undo event.amount deduction', async () => {
    durable.medications = [
      baseMed({
        currentPills: 8,
        lastSyncDate: '2026-09-14',
        doseConsumption: { d1: '2026-09-14' },
        doseConsumptionHistory: { d1: ['2026-09-14'] },
      }),
    ];
    durable.logs = [
      {
        id: exactAutoLogId('med-1', 'd1', '2026-09-14'),
        medicationId: 'med-1',
        medicationName: 'TestMed',
        type: 'auto_daily',
        amount: -2,
        date: '2026-09-14',
        timestamp: new Date().toISOString(),
        description: 'exact',
      },
    ];

    const result = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      todayStr: '2026-09-14',
      globalAutoDeductEnabled: true,
    });
    // Must not restore the exact 2 (would be 10) or only charge schedule 1 leftover incorrectly
    expect(result.medications[0].currentPills).not.toBe(10);
    expect(result.medications[0].currentPills).not.toBe(9);
  });

  it('idempotent second reconciliation keeps stock at event.amount deduction', () => {
    const med = baseMed({ currentPills: 10 });
    const e = firedEvent(2);
    const r1 = reconcileFiredEvents([med], [], [e]);
    const r2 = reconcileFiredEvents(r1.medications, r1.logs, [e]);
    expect(r1.medications[0].currentPills).toBe(8);
    expect(r2.medications[0].currentPills).toBe(8);
    expect(r2.newExactLogs).toHaveLength(0);
    expect(r2.details[0].outcome).toBe('already_applied');
  });
});
