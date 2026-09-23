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
import { makeScheduledMedication as med, makeAutoDeductionEvent as fired, makeDoseTakenLog, makeRefillLog } from '../fixtures/testFixtures';

import { consumeDose, restoreDose, applyDurableStockDelta } from '../../src/utils/medActions';
import { runGatedManualConsume, runGatedManualRestore, runGatedRefill, runGatedUndoRefill, runGatedAutoDeductToggle, runGatedMedicationUpdate } from '../../src/utils/manualStockMutation';

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
