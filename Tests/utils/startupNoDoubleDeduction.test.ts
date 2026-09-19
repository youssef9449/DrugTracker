/**
 * Issue #268 / PR #271 — Exact FIRED + startup no-double-deduction contract.
 *
 * The legacy day-based catch-up (`syncAutoDailyDeductions`) was removed
 * entirely. Exact FIRED occurrences are the SOLE source of timed automatic
 * stock deduction. There is no automatic deduction for app startup / app
 * open / resume / calendar-day passing / or a later mutation running a
 * day-based catch-up. No `dailyDose`-based catch-up, no `lastConsumedDate` /
 * `lastSyncDate` / `LEGACY_DOSE_ID` workaround.
 *
 * The production startup path is `useStartupAutoDeduction` →
 * `reconcileExactBeforeManualMutation` (→ `runAutoDeductionReconciliation`).
 * These tests prove that core does not double-deduct: a FIRED Exact
 * occurrence is applied once via `event.amount`, and a second startup/app-open
 * pass (re-listing the same FIRED) sees `already_applied` — no second charge.
 *
 * Cases (per the task):
 *   1 — Exact only: no-schedule med, dailyDose=5, FIRED amount=2 → 8; no
 *       automatic second deduction.
 *   2 — no double deduction: Exact reconciliation then the same startup path
 *       again → stays 8 (not 3).
 *   3 — explicit schedule: a FIRED event uses event.amount once only.
 *   4 — manual flows: removing legacy auto-settlement does not turn Manual
 *       Take / Refill into an extra unintended deduction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNative';
import { exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';
import {
  runAutoDeductionReconciliation,
  __setExactAutoEnvelopeTestHooks,
} from '../../src/utils/runAutoDeductionReconciliation';
import {
  runGatedManualConsume,
  runGatedRefill,
  __setManualEnvelopeTestHooks,
} from '../../src/utils/manualStockMutation';
import { __setAutoStockGateTestHooks } from '../../src/utils/autoDeductionStockGate';
import { __setStockMutationOrderingTestHooks } from '../../src/utils/stockMutationOrdering';
import { effectiveCurrentPills } from '../../src/utils/dateCalculations';

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
    // lastSync strictly BEFORE the event day so the exact occurrence is
    // reconcilable on any real calendar day.
    lastSyncDate: '2026-09-13',
    autoDeductEnabled: true,
    doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    ...over,
  };
}

function firedEvent(
  amount: number,
  over: Partial<AutoDeductionEvent> = {}
): AutoDeductionEvent {
  return {
    medicationId: 'med-1',
    doseId: 'd1',
    calendarDate: '2026-09-14',
    amount,
    status: 'FIRED',
    scheduledAtEpochMs: 1,
    createdAtEpochMs: 1,
    reconciledAtEpochMs: null,
    ...over,
  };
}

let durable: { medications: Medication[]; logs: ConsumptionLog[] };
let seqCounter: { n: number };

function installGateHooks() {
  __setAutoStockGateTestHooks({
    load: () => ({
      medications: durable.medications.map((m) => ({ ...m })),
      logs: [...durable.logs],
    }),
    commit: (state) => {
      durable.medications = state.medications.map((m) => ({ ...m }));
      durable.logs = [...state.logs];
      return null;
    },
  });
  __setManualEnvelopeTestHooks({ load: () => null, save: () => null });
  __setExactAutoEnvelopeTestHooks({ load: () => null, save: () => null });
  __setStockMutationOrderingTestHooks({
    loadLastApplied: () => 0,
    persistLastApplied: () => null,
    allocate: () => ({ ok: true as const, seq: seqCounter.n++ }),
  });
}

function clearHooks() {
  __setAutoStockGateTestHooks(null);
  __setManualEnvelopeTestHooks(null);
  __setExactAutoEnvelopeTestHooks(null);
  __setStockMutationOrderingTestHooks(null);
  vi.restoreAllMocks();
}

/**
 * Run the production startup reconciliation core (runAutoDeductionReconciliation,
 * the exact orchestrator that useStartupAutoDeduction →
 * reconcileExactBeforeManualMutation drives inside the gate). The hook
 * mirrors the post-state into React; this helper returns that post-state.
 */
async function runStartupReconciliation(opts: {
  medications: Medication[];
  logs: ConsumptionLog[];
  events: AutoDeductionEvent[];
  markChanged?: boolean;
}) {
  return runAutoDeductionReconciliation({
    globalAutoDeductEnabled: true,
    medications: opts.medications,
    logs: opts.logs,
    alreadyInGate: true,
    listFired: async () => ({ ok: true, events: opts.events }),
    markReconciled: async () => ({ ok: true, changed: opts.markChanged ?? true }),
    persistMeds: () => null,
    persistLogs: () => null,
    loadEnvelope: () => null,
    saveEnvelope: () => null,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  durable = { medications: [], logs: [] };
  seqCounter = { n: 1 };
  installGateHooks();
});

afterEach(() => {
  clearHooks();
  vi.useRealTimers();
});

describe('Case 1 — Exact only: no-schedule med, dailyDose=5, FIRED amount=2 → 8', () => {
  it('applies event.amount once; no automatic second deduction', async () => {
    const med = baseMed({
      currentPills: 10,
      dailyDose: 5,
      doseSchedule: undefined,
      lastSyncDate: '2026-09-13',
    });
    const events: AutoDeductionEvent[] = [firedEvent(2)];

    const r = await runStartupReconciliation({ medications: [med], logs: [], events });

    expect(r.details[0]?.outcome).toBe('applied');
    // event.amount (2) authoritative, NOT dailyDose (5).
    expect(r.medications[0].currentPills).toBe(8);
    expect(r.newExactLogs).toHaveLength(1);
    expect(r.newExactLogs[0].amount).toBe(-2);
    // The exact log (type 'auto_daily', deterministic exact-auto:* id) is
    // the only auto_daily log. No day-based catch-up log (which would have a
    // random log-* id) was created — there is no automatic second deduction.
    const autoDailyLogs = r.logs.filter((l) => l.type === 'auto_daily');
    expect(autoDailyLogs).toHaveLength(1);
    expect(autoDailyLogs[0].id).toBe(exactAutoLogId('med-1', 'd1', '2026-09-14'));
  });
});

describe('Case 2 — no double deduction: Exact then the same startup path again → stays 8', () => {
  it('a second startup/app-open pass does not charge again (8, not 3)', async () => {
    // Scenario: currentPills=10, dailyDose=5, no schedule. First startup
    // applies FIRED amount=2 → 8. A second app-open (re-listing the same
    // FIRED before ACK lands, or a fresh session reading the durable
    // consume marker) must NOT add a dailyDose-based charge (which would
    // yield 3 = 8 − 5). It stays 8.
    const med = baseMed({
      currentPills: 10,
      dailyDose: 5,
      doseSchedule: undefined,
      lastSyncDate: '2026-09-13',
    });
    const events: AutoDeductionEvent[] = [firedEvent(2)];

    // First startup pass.
    const first = await runStartupReconciliation({ medications: [med], logs: [], events });
    expect(first.medications[0].currentPills).toBe(8);

    // Second startup pass: the same FIRED is re-listed. The durable exact
    // log + consume marker make it already_applied → no mutation, no second
    // charge. The result stays 8 (NOT 3 = 8 − dailyDose 5).
    const second = await runStartupReconciliation({
      medications: first.medications,
      logs: first.logs,
      events,
      markChanged: false,
    });
    expect(second.mutated).toBe(false);
    expect(second.medications[0].currentPills).toBe(8);
    expect(second.newExactLogs).toEqual([]);
    // No dailyDose-based catch-up log was created on either pass: the only
    // auto_daily log is the exact one (deterministic exact-auto:* id).
    const autoDailyLogs = second.logs.filter((l) => l.type === 'auto_daily');
    expect(autoDailyLogs).toHaveLength(1);
    expect(autoDailyLogs[0].id).toBe(exactAutoLogId('med-1', 'd1', '2026-09-14'));
  });

  it('runAutoDeductionReconciliation directly: a second call is already_applied (no double)', async () => {
    const med = baseMed({
      currentPills: 10,
      dailyDose: 5,
      doseSchedule: undefined,
      lastSyncDate: '2026-09-13',
    });
    const events: AutoDeductionEvent[] = [firedEvent(2)];

    const r1 = await runStartupReconciliation({ medications: [med], logs: [], events });
    expect(r1.medications[0].currentPills).toBe(8);

    const r2 = await runStartupReconciliation({
      medications: r1.medications,
      logs: r1.logs,
      events,
      markChanged: false,
    });
    expect(r2.mutated).toBe(false);
    expect(r2.medications[0].currentPills).toBe(8);
    expect(r2.newExactLogs).toEqual([]);
  });
});

describe('Case 3 — explicit schedule: Exact event uses event.amount once only', () => {
  it('explicit doseSchedule + FIRED amount=2 → 8; no second charge on re-entry', async () => {
    const med = baseMed({
      currentPills: 10,
      dailyDose: 1,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      lastSyncDate: '2026-09-13',
    });
    const events: AutoDeductionEvent[] = [firedEvent(2)];

    const r = await runStartupReconciliation({ medications: [med], logs: [], events });
    // event.amount (2) is authoritative, NOT the schedule amount (1).
    expect(r.medications[0].currentPills).toBe(8);
    expect(r.newExactLogs[0].amount).toBe(-2);

    // Second pass: already_applied, no duplicate.
    const r2 = await runStartupReconciliation({
      medications: r.medications,
      logs: r.logs,
      events,
      markChanged: false,
    });
    expect(r2.mutated).toBe(false);
    expect(r2.medications[0].currentPills).toBe(8);
    expect(r2.newExactLogs).toEqual([]);
    // Exactly one exact log across both passes.
    expect(r2.logs.filter((l) => l.id === exactAutoLogId('med-1', 'd1', '2026-09-14'))).toHaveLength(1);
  });
});

describe('Case 4 — manual flows: removing legacy auto-settlement adds no extra deduction', () => {
  it('Manual Take (alarm) deducts exactly the dose amount once; no day-based catch-up on top', async () => {
    durable.medications = [
      baseMed({
        currentPills: 10,
        dailyDose: 5,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        lastSyncDate: '2026-09-13',
      }),
    ];
    // No FIRED events (web: native listFired returns ok:true, events:[]).
    // The manual path reconciles (no-op) then settles the manual Take.
    // There must be no dailyDose-based day catch-up charge.
    const result = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'alarm',
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
    });
    expect(result.outcome).toBe('applied');
    // The manual Take deducts the dose amount (1) → 9. No dailyDose(5)-based
    // day catch-up runs on top (the legacy catch-up was removed). The result
    // is 9, NOT 10 - 5 (day catch-up) - 1 (take) = 4, and NOT 10 - 1 - 5 = 4.
    expect(result.medications[0].currentPills).toBe(9);
    // No auto_daily (day catch-up) log was created.
    expect(result.logs.filter((l) => l.type === 'auto_daily')).toHaveLength(0);
    // A dose_taken log was created for the manual Take.
    expect(result.logs.filter((l) => l.type === 'dose_taken')).toHaveLength(1);
  });

  it('Refill adds pills; no day-based catch-up deducts on top', async () => {
    durable.medications = [
      baseMed({
        currentPills: 10,
        dailyDose: 5,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        lastSyncDate: '2026-09-13',
      }),
    ];
    const result = await runGatedRefill({
      medicationId: 'med-1',
      addedPills: 10,
      todayStr: '2026-09-14',
      now: new Date('2026-09-14T09:00:00'),
    });
    expect(result.outcome).toBe('applied');
    // Refill +10 → 20. No dailyDose(5)-based day catch-up deducts on top
    // (the legacy catch-up was removed). The result is 20, NOT 10 - 5 + 10 = 15.
    expect(result.medications[0].currentPills).toBe(20);
    // No auto_daily (day catch-up) log was created.
    expect(result.logs.filter((l) => l.type === 'auto_daily')).toHaveLength(0);
    // A refill log was created.
    expect(result.logs.filter((l) => l.type === 'refill')).toHaveLength(1);
  });

  it('effectiveCurrentPills projection is unchanged: no automatic settlement on app-open', () => {
    // The projection (effectiveCurrentPills) still reflects due doses for
    // display, but the snapshot is NOT auto-settled on app-open. This proves
    // removing the legacy catch-up did not silently change the live display.
    const med = baseMed({
      currentPills: 10,
      dailyDose: 2,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
      lastSyncDate: '2026-09-13',
    });
    // After 1 day (lastSync 09-13, today 09-14 at 09:00 > 08:00): today's dose
    // is due → projection = 8. The snapshot stays 10 (no auto settlement).
    expect(med.currentPills).toBe(10);
    expect(effectiveCurrentPills(med, '2026-09-14', new Date('2026-09-14T09:00:00'))).toBe(8);
  });
});

/**
 * Direct contract: there is NO production caller of `syncAutoDailyDeductions`.
 * The function was deleted; its symbol no longer exists. This is a structural
 * guard — any re-add would have to re-introduce the export.
 */
describe('structural: syncAutoDailyDeductions is deleted (no production caller)', () => {
  it('the dateCalculations module no longer exports syncAutoDailyDeductions / AutoSyncResult / settlementLastSyncDate', async () => {
    const mod = await import('../../src/utils/dateCalculations');
    const m = mod as unknown as {
      syncAutoDailyDeductions?: unknown;
      AutoSyncResult?: unknown;
      settlementLastSyncDate?: unknown;
    };
    expect(m.syncAutoDailyDeductions).toBeUndefined();
    expect(m.AutoSyncResult).toBeUndefined();
    expect(m.settlementLastSyncDate).toBeUndefined();
  });

  it('useStartupAutoDeduction does not call or import syncAutoDailyDeductions', async () => {
    // Read the source file directly to prove the startup hook no longer
    // calls or imports the deleted legacy catch-up. (A JSDoc mention that it
    // was removed is allowed; a call or import is not.)
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve('src/hooks/useStartupAutoDeduction.ts'),
      'utf8'
    );
    // No call to the deleted function.
    expect(src).not.toContain('syncAutoDailyDeductions(');
    // No import of it (either as a named import or a property access).
    expect(src).not.toMatch(/import\s*\{[^}]*syncAutoDailyDeductions[^}]*\}/);
    expect(src).not.toMatch(/\.syncAutoDailyDeductions\b/);
    // The legacy commit-with-envelope path (which wrapped the legacy sync) is
    // also gone — the hook now mirrors the Exact-reconciled durable state
    // directly.
    expect(src).not.toContain('commitWithManualEnvelope');
  });
});
