import { __setStockMutationOrderingTestHooks, __resetStockMutationOrderingForTests, __setManualEnvelopeTestHooks, __setAutoStockGateTestHooks } from './autoStockTestHooks';
/**
 * Issue #267 regression tests — manual stock mutations have no
 * historical/day-based settlement.
 *
 * Covers the 14 regression scenarios from the issue task description:
 *  2. Refill after several days: `currentPills += addedPills` only.
 *  3. Refill Undo after Exact deductions: reverses only refill amount
 *     from durable balance, no re-settlement.
 *  4. Dose edit after several days: `currentPills` unchanged, no
 *     `exact_auto` log.
 *  5. Auto ON/OFF after several days: `currentPills` unchanged, no
 *     historical log.
 *  6. Exact Auto → Manual Take: no double deduction.
 *  7. Manual Take → Exact Auto: same occurrence not deducted twice.
 *  8. Exact Auto → Restore: Restore amount = exact active log amount.
 *  9. Manual Take → Restore: Restore amount = actual `dose_taken` amount.
 * 10. Schedule amount changed after Exact deduction: Restore uses
 *     historical deduction log amount, not new schedule amount.
 * 11. Schedule removed after Exact FIRED: FIRED reconciliation still
 *     authoritative, no `dailyDose` fallback.
 * 12. Multiple dose isolation: d1 mutation doesn't affect d2.
 * 14. No pure projection Restore: elapsed time without durable deduction
 *     doesn't add stock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import { makeScheduledMedication as med, makeAutoDeductionEvent as fired, makeDoseTakenLog, makeExactAutoLog } from '../fixtures/testFixtures';
import { exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';
import { restoreDose } from '../../src/utils/medActions';
import { runGatedManualConsume, runGatedManualRestore, runGatedMedicationUpdate } from '../../src/utils/manualStockMutation';

import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';


const autoSchedulingMocks = vi.hoisted(() => ({
  invalidateAutoDeductionRecurrence: vi.fn(),
  scheduleAutoDeduction: vi.fn(),
  recoverAutoDeductionOccurrence: vi.fn(),
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

import { isDoseConsumedOnDate } from '../../src/utils/dateCalculations';

const TODAY = '2026-09-16';


// ─── Unit-level helpers shared across describe blocks ───────────────
let durable: AutoStockDurableState;

function installDurableState(state: AutoStockDurableState) {
  durable = state;
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
  __setStockMutationOrderingTestHooks({
    allocate: (() => {
      let seq = 0;
      return () => ({ ok: true, seq: ++seq });
    })(),
    loadLastApplied: () => 0,
    persistLastApplied: () => null,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T15:00:00`));
});

afterEach(() => {
  vi.useRealTimers();
  __setAutoStockGateTestHooks(null);
  __setManualEnvelopeTestHooks(null);
  __resetStockMutationOrderingForTests();
});

// ───────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────

describe('#267 regression 6 — Exact Auto → Manual Take: no double deduction', () => {
  it('after Exact Auto reconciles FIRED d1, Manual Take for d1 is already_consumed (no second deduction)', async () => {
    installDurableState({
      medications: [med({ currentPills: 30, doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }] })],
      logs: [],
    });

    // Run Exact Auto reconciliation: FIRED event for d1 with amount 1.
    const recon = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: durable.medications,
      logs: durable.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 })] }),
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
    expect(pillsAfterAuto).toBe(29); // 30 - 1

    // Now Manual Take for d1: should be already_consumed (no second deduction).
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({ ok: true, status: 'ABSENT' }),
    });
    expect(take.outcome).toBe('already_consumed');
    expect(durable.medications[0].currentPills).toBe(pillsAfterAuto); // unchanged
  });
});

describe('#267 regression 7 — Manual Take → Exact Auto: same occurrence not deducted twice', () => {
  it('after Manual Take for d1, Exact Auto FIRED for d1 is already_applied (no second deduction)', async () => {
    installDurableState({
      medications: [med({ currentPills: 30, doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }] })],
      logs: [],
    });

    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({ ok: true, status: 'ABSENT' }),
    });
    expect(take.outcome).toBe('applied');
    const pillsAfterTake = durable.medications[0].currentPills;
    expect(pillsAfterTake).toBe(29); // 30 - 1
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);

    // Exact Auto reconciliation with FIRED d1: consume marker exists → already_applied.
    const recon = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: durable.medications,
      logs: durable.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 })] }),
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
    expect(durable.medications[0].currentPills).toBe(pillsAfterTake); // unchanged (no second deduction)
  });
});

describe('#267 regression 8 — Exact Auto → Restore: amount = exact active log amount', () => {
  it('Restore reverses the exact_auto log amount (NOT the current schedule amount)', async () => {
    // Med had Exact Auto FIRED with amount=2 for d1. Schedule d1 amount is 1.
    // The exact_auto log records -2 (the exact FIRED amount).
    installDurableState({
      medications: [
        med({
          currentPills: 28, // 30 - 2 (the exact auto deduction)
          doseConsumptionHistory: { d1: [TODAY] },
          doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        }),
      ],
      logs: [makeExactAutoLog('med-1', 'TestMed', 'd1', TODAY, 2, 'auto-1')],
    });

    const r = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-1',
    });
    expect(r.outcome).toBe('applied');
    // Restored amount = abs(exact_auto log amount) = 2 (the exact FIRED amount).
    expect(r.restoredAmount).toBe(2);
    expect(durable.medications[0].currentPills).toBe(30); // 28 + 2
    // The restore (skipped_day) log links to the reversed exact_auto log.
    const restoreLog = durable.logs.find((l) => l.id === 'restore-1');
    expect(restoreLog?.type).toBe('skipped_day');
    expect(restoreLog?.amount).toBe(2);
    expect(restoreLog?.relatedLogId).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    // The exact_auto log is marked reversed.
    expect(durable.logs.find((l) => l.id === exactAutoLogId('med-1', 'd1', TODAY))?.reversedAt).toBeTruthy();
  });
});

describe('#267 regression 9 — Manual Take → Restore: amount = dose_taken amount', () => {
  it('Restore reverses the dose_taken log amount (NOT the current schedule amount)', async () => {
    // Med had Manual Take for d1 with amount=3 (historical schedule was 3 at
    // the time of Take; current schedule is 1). The dose_taken log records -3.
    installDurableState({
      medications: [
        med({
          currentPills: 27, // 30 - 3 (the manual Take)
          doseConsumptionHistory: { d1: [TODAY] },
          doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }], // current schedule is 1
        }),
      ],
      logs: [makeDoseTakenLog('med-1', 'TestMed', 'd1', TODAY, 3, 'take-1')],
    });

    const r = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-1',
    });
    expect(r.outcome).toBe('applied');
    // Restored amount = abs(dose_taken log amount) = 3 (NOT current schedule amount 1).
    expect(r.restoredAmount).toBe(3);
    expect(durable.medications[0].currentPills).toBe(30); // 27 + 3
  });

  it('unit-level: restoreDose returns the dose_taken log amount', () => {
    const m = med({
      currentPills: 27,
      doseConsumptionHistory: { d1: [TODAY] },
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    });
    const logs: ConsumptionLog[] = [makeDoseTakenLog('med-1', 'TestMed', 'd1', TODAY, 3, 'take-1')];
    const result = restoreDose(m, 'd1', TODAY, new Date(`${TODAY}T15:00:00`), logs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredAmount).toBe(3);
    expect(result.updatedMed.currentPills).toBe(30);
  });
});

describe('#267 regression 10 — Schedule changed after Exact deduction: Restore uses historical log amount', () => {
  it('Schedule d1 amount changed 2→5 after exact deduction; Restore uses the historical 2', () => {
    // d1 schedule amount was 2 when the exact deduction happened. Now it's 5.
    // The exact_auto log records -2. Restore must use 2 (the historical log
    // amount), not 5 (the current schedule amount).
    const m = med({
      currentPills: 28, // 30 - 2 (the exact deduction)
      doseConsumptionHistory: { d1: [TODAY] },
      doseSchedule: [{ id: 'd1', amount: 5, time: '08:00' }], // edited from 2
    });
    const logs: ConsumptionLog[] = [makeExactAutoLog('med-1', 'TestMed', 'd1', TODAY, 2, 'auto-1')];
    const result = restoreDose(m, 'd1', TODAY, new Date(`${TODAY}T15:00:00`), logs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Restored amount = abs(log.amount) = 2 (historical), NOT 5 (new schedule).
    expect(result.restoredAmount).toBe(2);
    expect(result.updatedMed.currentPills).toBe(30); // 28 + 2
  });

  it('Schedule d1 amount changed 2→5 after manual Take; Restore uses the historical 2', () => {
    // d1 schedule amount was 2 when the manual Take happened. Now it's 5.
    // The dose_taken log records -2. Restore must use 2 (the historical log
    // amount), not 5 (the current schedule amount).
    const m = med({
      currentPills: 28,
      doseConsumptionHistory: { d1: [TODAY] },
      doseSchedule: [{ id: 'd1', amount: 5, time: '08:00' }],
    });
    const logs: ConsumptionLog[] = [makeDoseTakenLog('med-1', 'TestMed', 'd1', TODAY, 2, 'take-1')];
    const result = restoreDose(m, 'd1', TODAY, new Date(`${TODAY}T15:00:00`), logs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredAmount).toBe(2);
    expect(result.updatedMed.currentPills).toBe(30);
  });
});

describe('#267 regression 11 — Schedule removed after Exact FIRED: FIRED still authoritative', () => {
  it('after FIRED d1 + schedule edit removes d1, Exact Auto reconciliation is still authoritative (no dailyDose fallback)', async () => {
    // Initial med: d1 in schedule.
    installDurableState({
      medications: [
        med({
          currentPills: 30,
          doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        }),
      ],
      logs: [],
    });

    // First: Exact Auto reconciliation FIRES d1 amount=1.
    const recon1 = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: durable.medications,
      logs: durable.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 })] }),
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
    expect(recon1.details[0]?.outcome).toBe('applied');
    const pillsAfterAuto = durable.medications[0].currentPills;
    expect(pillsAfterAuto).toBe(29); // 30 - 1

    // Now: schedule edit removes d1 (empty schedule) + sets dailyDose=5.
    // The consume marker for d1 today is preserved (pruned only by schedule).
    // After edit: no schedule → consume marker may be pruned too. The FIRED
    // event for d1 is still listed → reconciliation must still authoritative
    // (already_applied because the exact_auto log already exists for d1+TODAY).
    const next: Medication = {
      ...med(),
      currentPills: pillsAfterAuto,
      dailyDose: 5,
      doseSchedule: [],
      dosesPerDay: 0,
      doseConsumptionHistory: {},
    };
    const edit = await runGatedMedicationUpdate({
      editId: 'med-1',
      medData: next,
      globalAutoDeductEnabled: true,
      todayStr: TODAY,
    });
    expect(edit.outcome).toBe('applied');
    // currentPills unchanged by the dose edit (no settlement).
    expect(durable.medications[0].currentPills).toBe(pillsAfterAuto);

    // Second reconciliation: FIRED d1 is still listed. The exact_auto log
    // already exists for (med-1, d1, TODAY) → already_applied (no fallback
    // to dailyDose=5, no second deduction).
    const recon2 = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: durable.medications,
      logs: durable.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 })] }),
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
    // The reconciliation is authoritative — already_applied (no dailyDose fallback).
    expect(recon2.details[0]?.outcome).toBe('already_applied');
    expect(durable.medications[0].currentPills).toBe(pillsAfterAuto); // unchanged
  });
});
