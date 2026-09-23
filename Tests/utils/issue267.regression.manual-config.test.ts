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
