import {
  __setStockMutationOrderingTestHooks,
  __resetStockMutationOrderingForTests,
  __setManualEnvelopeTestHooks,
  __setAutoStockGateTestHooks,
} from './autoStockTestHooks';
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
import { makeMedication as med, makeAutoDeductionEvent as fired, makeDoseTakenLog, makeExactAutoLog, makeRefillLog } from '../fixtures/testFixtures';
import { exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';
import {
  consumeDose,
  restoreDose,
  applyDurableStockDelta } from '../../src/utils/medActions';
import {
  runGatedManualConsume,
  runGatedManualRestore,
  runGatedRefill,
  runGatedUndoRefill,
  runGatedAutoDeductToggle,
  runGatedMedicationUpdate } from '../../src/utils/manualStockMutation';
import {
type AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';
import {
  runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNativeTypes';

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
describe('#267 regression 1 — Manual Take after old elapsed-day settlement', () => {
  it('deducts only the dose amount (no historical catch-up) from durable currentPills only (unit)', () => {
    const m = med({ currentPills: 30}); // 6 days before TODAY
    const result = consumeDose(m, 'manual', TODAY, new Date(`${TODAY}T15:00:00`), 'd1');
    expect(result.doseAmount).toBe(1);
    expect(result.updatedMed).not.toBeNull();
    // 30 - 1 = 29 (NOT 30 - 6*2 - 1 = 17 — no historical catch-up).
    expect(result.updatedMed!.currentPills).toBe(29);
  });

  it('gate-level: Take does not invent stock from elapsed days', async () => {
    installDurableState({ medications: [med({ currentPills: 30})], logs: [] });
    const r = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
      getOccurrenceSnapshot: async () => ({ ok: true, status: 'ABSENT' }),
    });
    expect(r.outcome).toBe('applied');
    expect(r.doseAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(29); // 30 - 1 (no catch-up)
  });
});

// ───────────────────────────────────────────────────────────────────────
// 2. Refill after several days: `currentPills += addedPills` only.
// ───────────────────────────────────────────────────────────────────────
describe('#267 regression 2 — Refill after several days', () => {
  it('adds the addedPills to durable currentPills only (no settlement; currentPills += addedPills only)', async () => {
    installDurableState({
      medications: [med({ currentPills: 20})],
      logs: [],
    });
    const r = await runGatedRefill({
      medicationId: 'med-1',
      addedPills: 15,
      todayStr: TODAY,
      makeLogId: () => 'refill-1',
    });
    expect(r.outcome).toBe('applied');
    expect(r.addedPills).toBe(15);
    // 20 + 15 = 35 (no past-day settlement baked in).
    expect(durable.medications[0].currentPills).toBe(35);
    // A refill log is prepended (no exact_auto log).
    expect(durable.logs.some((l) => l.id === 'refill-1' && l.type === 'refill')).toBe(true);
    expect(durable.logs.some((l) => l.type === 'exact_auto')).toBe(false);
  });

  it('applyDurableStockDelta: pure helper adds the delta to currentPills only', () => {
    const m = med({ currentPills: 20});
    const result = applyDurableStockDelta(m, 15);
    expect(result.currentPills).toBe(35);
  });
});

// ───────────────────────────────────────────────────────────────────────
// 3. Refill Undo after Exact deductions: reverses only refill amount from
//    durable balance, no re-settlement.
// ───────────────────────────────────────────────────────────────────────
describe('#267 regression 3 — Refill Undo after Exact deductions', () => {
  it('reverses min(refill.amount, currentPills) from the durable balance only (no re-settlement)', async () => {
    // Med was refilled +20 (currentPills=25 after some auto deductions).
    // Undo reverses min(20, 25) = 20 from the durable balance.
    installDurableState({
      medications: [med({ currentPills: 25})],
      logs: [
        makeRefillLog('med-1', 'TestMed', TODAY, 20, 'refill-1'),
        // Some exact deductions already baked into the durable snapshot:
        makeExactAutoLog('med-1', 'TestMed', 'd1', TODAY, 1, 'auto-1'),
      ],
    });
    const r = await runGatedUndoRefill({
      medicationId: 'med-1',
      todayStr: TODAY,
      makeLogId: () => 'refill-undo-1',
    });
    expect(r.outcome).toBe('applied');
    // reversedAmount = min(20, 25) = 20 (no re-settlement of past days).
    expect(r.addedPills).toBe(-20);
    expect(durable.medications[0].currentPills).toBe(5); // 25 - 20
    // A refill_undo log is prepended, linked to the original refill.
    const undoLog = durable.logs.find((l) => l.id === 'refill-undo-1');
    expect(undoLog?.type).toBe('refill_undo');
    expect(undoLog?.amount).toBe(-20);
    expect(undoLog?.relatedLogId).toBe('refill-1');
    // The original refill is marked reversed.
    expect(durable.logs.find((l) => l.id === 'refill-1')?.reversedAt).toBeTruthy();
  });

  it('refill undo clamps the reversal at 0 (no negative balance, no re-settlement)', async () => {
    // currentPills=5; refill amount=20; only 5 is reversible.
    installDurableState({
      medications: [med({ currentPills: 5, autoDeductEnabled: false })],
      logs: [makeRefillLog('med-1', 'TestMed', TODAY, 20, 'refill-1')],
    });
    const r = await runGatedUndoRefill({
      medicationId: 'med-1',
      todayStr: TODAY,
      makeLogId: () => 'refill-undo-1',
    });
    expect(r.outcome).toBe('applied');
    expect(r.addedPills).toBe(-5);
    expect(durable.medications[0].currentPills).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// 4. Dose edit after several days: `currentPills` unchanged, no
//    `exact_auto` log.
// ───────────────────────────────────────────────────────────────────────
describe('#267 regression 4 — Dose edit after several days', () => {
  it('changes dailyDose/doseSchedule without changing currentPills or adding an exact_auto log', async () => {
    installDurableState({
      medications: [med({ currentPills: 30})],
      logs: [],
    });
    const next: Medication = {
      ...med(),
      currentPills: 30,
      dailyDose: 6,
      doseSchedule: [
        { id: 'd1', amount: 3, time: '09:00' },
        { id: 'd2', amount: 1, time: '14:00' },
        { id: 'd3', amount: 2, time: '22:00' },
      ],
    };
    const r = await runGatedMedicationUpdate({
      editId: 'med-1',
      medData: next,
      globalAutoDeductEnabled: true,
      todayStr: TODAY,
    });
    expect(r.outcome).toBe('applied');
    expect(r.settleLog).toBeNull(); // no exact_auto log
    // currentPills unchanged.
    expect(durable.medications[0].currentPills).toBe(30);
    // dailyDose + doseSchedule are updated.
    expect(durable.medications[0].dailyDose).toBe(6);
    expect(durable.medications[0].doseSchedule?.find((d) => d.id === 'd1')?.amount).toBe(3);
    // No exact_auto log was created.
    expect(durable.logs.some((l) => l.type === 'exact_auto')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────
// 5. Auto ON/OFF after several days: `currentPills` unchanged, no
//    historical log.
// ───────────────────────────────────────────────────────────────────────
describe('#267 regression 5 — Auto ON/OFF after several days', () => {
  it('toggle ON→OFF: flips the flag only (no stock change, no exact_auto log)', async () => {
    installDurableState({
      medications: [med({ currentPills: 30, autoDeductEnabled: true })],
      logs: [],
    });
    const r = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      globalAutoDeductEnabled: true,
      todayStr: TODAY,
    });
    expect(r.outcome).toBe('applied');
    expect(r.settleLog).toBeNull();
    expect(durable.medications[0].autoDeductEnabled).toBe(false);
    // currentPills unchanged.
    expect(durable.medications[0].currentPills).toBe(30);
    // No exact_auto log was created.
    expect(durable.logs.some((l) => l.type === 'exact_auto')).toBe(false);
  });

  it('toggle OFF→ON: flips the flag only (no retroactive deduction, no log)', async () => {
    installDurableState({
      medications: [med({ currentPills: 30, autoDeductEnabled: false })],
      logs: [],
    });
    const r = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      globalAutoDeductEnabled: true,
      todayStr: TODAY,
    });
    expect(r.outcome).toBe('applied');
    expect(r.settleLog).toBeNull();
    expect(durable.medications[0].autoDeductEnabled).toBe(true);
    // currentPills unchanged (no retroactive deduction for the frozen period).
    expect(durable.medications[0].currentPills).toBe(30);
    // No exact_auto log was created.
    expect(durable.logs.some((l) => l.type === 'exact_auto')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────
// 6. Exact Auto → Manual Take: no double deduction.
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

// ───────────────────────────────────────────────────────────────────────
// 7. Manual Take → Exact Auto: same occurrence not deducted twice.
// ───────────────────────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────────────────────
// 8. Exact Auto → Restore: Restore amount = exact active log amount.
// ───────────────────────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────────────────────
// 9. Manual Take → Restore: Restore amount = actual `dose_taken` amount.
// ───────────────────────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────────────────────
// 10. Schedule amount changed after Exact deduction: Restore uses
//     historical deduction log amount, not new schedule amount.
// ───────────────────────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────────────────────
// 11. Schedule removed after Exact FIRED: FIRED reconciliation still
//     authoritative, no `dailyDose` fallback.
// ───────────────────────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────────────────────
// 12. Multiple dose isolation: d1 mutation doesn't affect d2.
// ───────────────────────────────────────────────────────────────────────
describe('#267 regression 12 — Multiple dose isolation', () => {
  it('Manual Take d1 does not affect d2 (unit)', () => {
    const m = med({ currentPills: 30});
    const r = consumeDose(m, 'manual', TODAY, new Date(`${TODAY}T15:00:00`), 'd1');
    expect(r.doseAmount).toBe(1); // d1 amount
    expect(r.updatedMed?.doseConsumptionHistory?.d1).toBe(TODAY);
    expect(r.updatedMed?.doseConsumptionHistory?.d2).toBeUndefined();
    expect(r.updatedMed?.doseConsumptionHistory?.d3).toBeUndefined();
    // d1 only deducted 1 (d2, d3 untouched).
    expect(r.updatedMed?.currentPills).toBe(29);
  });

  it('gate-level: Take d1 then Auto FIRED d2 → both applied, no cross-effect', async () => {
    installDurableState({
      medications: [med({ currentPills: 30})],
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
    const pillsAfterD1 = durable.medications[0].currentPills;
    expect(pillsAfterD1).toBe(29); // 30 - 1 (d1)
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
    expect(isDoseConsumedOnDate(durable.medications[0], 'd2', TODAY)).toBe(false);

    // Auto FIRED d2 → applied independently (no double from d1).
    const recon = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: durable.medications,
      logs: durable.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [fired({ doseId: 'd2', calendarDate: TODAY, amount: 1 })] }),
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
    expect(durable.medications[0].currentPills).toBe(pillsAfterD1 - 1); // 28 (d2 deducted 1)
    expect(isDoseConsumedOnDate(durable.medications[0], 'd2', TODAY)).toBe(true);
  });

  it('Take d1 then Restore d1 leaves d2 untouched (unit)', () => {
    const m = med({
      currentPills: 29, // 30 - 1 (after Take d1)
      doseConsumptionHistory: { d1: [TODAY] },
    });
    const logs: ConsumptionLog[] = [makeDoseTakenLog('med-1', 'TestMed', 'd1', TODAY, 1, 'take-1')];
    const r = restoreDose(m, 'd1', TODAY, new Date(`${TODAY}T15:00:00`), logs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.restoredAmount).toBe(1);
    expect(r.updatedMed.currentPills).toBe(30); // back to 30
    // d1 consume marker cleared; d2 untouched (still undefined).
    expect(r.updatedMed.doseConsumptionHistory?.d1).toBeUndefined();
    expect(r.updatedMed.doseConsumptionHistory?.d2).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────
describe('#267 regression 13 — manual mutations do not perform elapsed-day settlement', () => {
  it('consumeDose deducts only the intended dose amount from currentPills', () => {
    const m = med({ currentPills: 30 });
    const r = consumeDose(m, 'manual', TODAY, new Date(`${TODAY}T15:00:00`), 'd1');
    expect(r.updatedMed!.currentPills).toBe(29);
  });

  it('restoreDose restores only the evidenced dose amount', () => {
    const m = med({
      currentPills: 29,
      doseConsumptionHistory: { d1: [TODAY] },
    });
    const logs: ConsumptionLog[] = [makeDoseTakenLog('med-1', 'TestMed', 'd1', TODAY, 1, 'take-1')];
    const r = restoreDose(m, 'd1', TODAY, new Date(`${TODAY}T15:00:00`), logs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.updatedMed.currentPills).toBe(30);
  });

  it('applyDurableStockDelta changes currentPills by the signed delta only', () => {
    const m = med({ currentPills: 30 });
    const r = applyDurableStockDelta(m, 5);
    expect(r.currentPills).toBe(35);
  });

  it('runGatedRefill adds only the refill amount to currentPills', async () => {
    installDurableState({
      medications: [med({ currentPills: 20 })],
      logs: [],
    });
    const r = await runGatedRefill({
      medicationId: 'med-1',
      addedPills: 10,
      todayStr: TODAY,
      makeLogId: () => 'refill-1',
    });
    expect(r.outcome).toBe('applied');
    expect(r.medications[0].currentPills).toBe(30);
  });

  it('runGatedUndoRefill reverses only the refill amount', async () => {
    installDurableState({
      medications: [med({ currentPills: 30 })],
      logs: [makeRefillLog('med-1', 'TestMed', TODAY, 10, 'refill-1')],
    });
    const r = await runGatedUndoRefill({
      medicationId: 'med-1',
      todayStr: TODAY,
      makeLogId: () => 'refill-undo-1',
    });
    expect(r.outcome).toBe('applied');
    expect(r.medications[0].currentPills).toBe(20);
  });

  it('runGatedAutoDeductToggle flips the flag without inventing stock from elapsed days', async () => {
    installDurableState({
      medications: [med({ currentPills: 30, autoDeductEnabled: true })],
      logs: [],
    });
    const r = await runGatedAutoDeductToggle({
      medicationId: 'med-1',
      globalAutoDeductEnabled: true,
      todayStr: TODAY,
    });
    expect(r.outcome).toBe('applied');
    expect(r.medications[0].currentPills).toBe(30);
  });

  it('runGatedMedicationUpdate preserves currentPills (config-only edit)', async () => {
    installDurableState({
      medications: [med({ currentPills: 30 })],
      logs: [],
    });
    const next: Medication = {
      ...med(),
      currentPills: 30,
      dailyDose: 4,
      doseSchedule: [
        { id: 'd1', amount: 2, time: '09:00' },
        { id: 'd2', amount: 1, time: '14:00' },
        { id: 'd3', amount: 1, time: '22:00' },
      ],
    };
    const { id: _id, createdAt: _c, ...medData } = next;
    const r = await runGatedMedicationUpdate({
      editId: 'med-1',
      medData,
      todayStr: TODAY,
    });
    expect(r.outcome).toBe('applied');
    expect(r.medications[0].currentPills).toBe(30);
  });
});


describe('#267 regression 14 — No pure-projection Restore', () => {
  it('restoreDose rejects with missing_deduction_evidence when no log exists (elapsed time alone does not add stock)', () => {
    // is NO durable deduction log for d1 today. Restore must NOT add stock.
    const m = med({ currentPills: 30});
    const r = restoreDose(m, 'd1', TODAY, new Date(`${TODAY}T15:00:00`), []);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('missing_deduction_evidence');
  });

  it('gate-level: Restore without an active deduction log is rejected (no projection-only restore)', async () => {
    installDurableState({
      medications: [med({ currentPills: 30})], // 6 days elapsed
      logs: [],
    });
    const r = await runGatedManualRestore({
      medicationId: 'med-1',
      doseId: 'd1',
      todayStr: TODAY,
      makeLogId: () => 'restore-1',
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('missing_deduction_evidence');
    // Stock unchanged (no projection-only restore).
    expect(durable.medications[0].currentPills).toBe(30);
    // No restore log was created.
    expect(durable.logs.some((l) => l.id === 'restore-1')).toBe(false);
  });

  it('a reversed deduction log is NOT evidence (already_restored when consume marker exists)', () => {
    // The user manually consumed d1 today (dose_taken log), then restored it
    // (the dose_taken log is reversed). The consume marker was cleared by the
    // restore. Now another Restore has NO active deduction to reverse → rejects.
    const m = med({
      currentPills: 30, // back to 30 after the first restore
      // doseConsumptionHistory.d1 was cleared by the first restore.
    });
    const logs: ConsumptionLog[] = [
      {
        ...makeDoseTakenLog('med-1', 'TestMed', 'd1', TODAY, 1, 'take-1'),
        reversedAt: `${TODAY}T10:00:00.000Z`,
      },
    ];
    const r = restoreDose(m, 'd1', TODAY, new Date(`${TODAY}T15:00:00`), logs);
    // No active deduction (the only one is reversed) and no consume marker
    // → missing_deduction_evidence (not already_restored because the marker
    // was cleared by the first restore).
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('missing_deduction_evidence');
  });
});
