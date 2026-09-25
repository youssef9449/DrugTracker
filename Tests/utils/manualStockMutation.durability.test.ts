import { requireDefined } from '../helpers/requireDefined';
import { __setStockMutationOrderingTestHooks, __resetStockMutationOrderingForTests, __setManualEnvelopeTestHooks, __setExactAutoEnvelopeStorageTestHooks, __setAutoStockGateTestHooks } from './autoStockTestHooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';
import type { ManualStockEnvelope } from '../../src/utils/stockEnvelopeRecovery';
import type { ExactAutoEnvelope } from '../../src/utils/runAutoDeductionReconciliation';


import { makeScheduledMedication as med, makeAutoDeductionEvent as fired } from '../fixtures/testFixtures';
import { runGatedManualConsume } from '../../src/utils/manualStockMutation';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';


import { isDoseConsumedOnDate } from '../../src/utils/dateCalculations';
import { exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';

const autoSchedulingMocks = vi.hoisted(() => ({
  invalidateAutoDeductionRecurrence: vi.fn(),
  scheduleAutoDeduction: vi.fn(),
  recoverAutoDeductionOccurrenceForCompensation: vi.fn(),
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
  autoSchedulingMocks.recoverAutoDeductionOccurrenceForCompensation.mockResolvedValue({ ok: true });
});
// findPending used indirectly via runGatedManualConsume

type TestManualStockEnvelope = Omit<ManualStockEnvelope, 'globalAutoDeductEnabled'> & {
  globalAutoDeductEnabled?: boolean;
};

const TODAY = '2026-09-16';




describe('Phase 4 — Manual envelope recovery and persistence failure', () => {
  let durable: AutoStockDurableState;
  let manualEnvelope: TestManualStockEnvelope | null;
  let failLogs: boolean;
  let failClear: boolean;
  let failBump: boolean;
  let failLastApplied: boolean;
  let failAllocate: boolean;
  let generation: number;
  let marked: string[];

    beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T15:00:00`));
    durable = { medications: [med()], logs: [], globalAutoDeductEnabled: false };
    manualEnvelope = null;
    failLogs = false;
    failClear = false;
    failBump = false;
    failLastApplied = false;
    failAllocate = false;
    generation = 0;
    marked = [];
    let lastApplied = 0;
    let nextSeq = 0;
    __resetStockMutationOrderingForTests();
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (seq) => {
        if (failLastApplied) return 'lastApplied write failed';
        lastApplied = seq;
        return null;
      },
      allocate: () => {
        if (failAllocate) return { ok: false, error: 'nextSeq persist failed' };
        nextSeq += 1;
        return { ok: true, seq: nextSeq };
      },
    });

    __setManualEnvelopeTestHooks({
    load: () => manualEnvelope as ManualStockEnvelope | null,
      save: (env) => {
        if (env == null && failClear) {
          return 'envelope clear failed';
        }
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
        durable.medications = state.medications.map((m) => ({ ...m }));
        if (failLogs) {
          return 'logs persist failed';
        }
        durable.logs = state.logs.map((l) => ({ ...l }));
        return null;
      },
      loadGeneration: () => generation,
      bumpGeneration: () => {
        if (failBump) return 'generation bump failed';
        generation += 1;
        return null;
      },
    });
  });

  afterEach(() => {
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __setExactAutoEnvelopeStorageTestHooks(null);
    __resetStockMutationOrderingForTests();
    vi.useRealTimers();
  });
  it('same recon: Manual envelope recovery + actual FIRED → ACK only from FIRED path', async () => {
    failLogs = true;
    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(manualEnvelope).not.toBeNull();
    const pillsAfterPartial = requireDefined(durable.medications[0], 'durable.medications[0]').currentPills;

    failLogs = false;
    marked = [];
    let markPhase = 'before';

    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => {
        expect(manualEnvelope).toBeNull();
        expect(marked).toEqual([]);
        markPhase = 'listFired';
        return {
          ok: true,
          events: [fired({ doseId: 'd1', calendarDate: TODAY, amount: 1 })],
        };
      },
      markReconciled: async (medicationId, doseId, calendarDate) => {
        expect(markPhase).toBe('listFired');
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });

    expect(manualEnvelope).toBeNull();
    expect(durable.logs.some((l) => l.type === 'dose_taken')).toBe(true);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(pillsAfterPartial);
    expect(recon.details[0]?.outcome).toBe('already_applied');
    expect(marked).toEqual([`med-1|d1|${TODAY}`]);
    expect(recon.markedCount).toBe(1);
  });
  it('lastApplied failure after meds+logs keeps envelope; recovery finalizes without double deduct', async () => {
    failLastApplied = true;
    const first = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    // Pair may be on durable but finalization failed → not success for caller.
    expect(first.outcome).toBe('persist_failed');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    expect(durable.logs.some((l) => l.type === 'dose_taken')).toBe(true);
    expect(manualEnvelope).not.toBeNull();
    const logCount = durable.logs.length;
    const logIds = durable.logs.map((l) => l.id);

    failLastApplied = false;
    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });
    expect(manualEnvelope).toBeNull();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    expect(durable.logs.length).toBe(logCount);
    expect(durable.logs.map((l) => l.id)).toEqual(logIds);
    expect(marked).toEqual([]);
  });
  it('generation bump failure after successful finalization is still applied', async () => {
    failBump = true;
    const first = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(first.outcome).toBe('applied');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    expect(manualEnvelope).toBeNull();
  });
  it('stale Manual envelope must not overwrite newer durable state', async () => {
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(generation).toBe(1);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    const newerLogs = durable.logs.map((l) => ({ ...l }));

    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 10 })],
      logs: [],
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
      mutationSeq: 1,
    };

    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });

    expect(manualEnvelope).toBeNull();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    expect(isDoseConsumedOnDate(requireDefined(durable.medications[0], 'durable.medications[0]'), 'd1', TODAY)).toBe(true);
    expect(durable.logs.length).toBe(newerLogs.length);
    expect(marked).toEqual([]);
  });
  it('clear failure after successful meds+logs is idempotent on retry', async () => {
    failClear = true;
    const first = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(first.outcome).toBe('applied');
    expect(generation).toBe(1);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    expect(durable.logs.some((l) => l.type === 'dose_taken')).toBe(true);
    expect(manualEnvelope).not.toBeNull();
    expect(manualEnvelope?.baseGeneration).toBe(0);
    const logCount = durable.logs.length;
    const pills = requireDefined(durable.medications[0], 'durable.medications[0]').currentPills;

    failClear = false;
    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });
    expect(manualEnvelope).toBeNull();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(pills);
    expect(durable.logs.length).toBe(logCount);
    expect(marked).toEqual([]);
  });
  it('persist_failed leaves stock unchanged and is not already_consumed', async () => {
    failLogs = true;
    const before = requireDefined(durable.medications[0], 'durable.medications[0]').currentPills;
    const result = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(result.outcome).toBe('persist_failed');
    expect(result.outcome).not.toBe('already_consumed');
    expect(result.outcome).not.toBe('applied');
    // Durable meds may have partial write; returned snapshot stays pre-commit for caller.
    expect(requireDefined(result.medications[0], 'result.medications[0]').currentPills).toBe(before);
    expect(result.log).toBeNull();
  });
  it('old envelope log id present but newer durable mutation wins (no meds overwrite)', async () => {
    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    const takeLogId = durable.logs.find((l) => l.type === 'dose_taken')?.id;
    expect(takeLogId).toBeTruthy();

    // Stale envelope reuses same log id but wants stock=10 (wrong).
    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 10 })],
      logs: durable.logs.map((l) => ({ ...l })),
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
      mutationSeq: 1,
    };

    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });
    expect(manualEnvelope).toBeNull();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
  });
  it('clear failure after finalization does not re-apply; retry clears only', async () => {
    failClear = true;
    const first = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    // Commit+lastApplied succeed; clear fails → mutation IS durable
    // (lastApplied is the completion proof). Caller sees 'applied'; the
    // envelope stays for retry (cleanup on next gate entry).
    expect(first.outcome).toBe('applied');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    expect(manualEnvelope).not.toBeNull();
    const logCount = durable.logs.length;

    failClear = false;
    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
    });
    expect(manualEnvelope).toBeNull();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    expect(durable.logs.length).toBe(logCount);
    expect(marked).toEqual([]);
  });
  it('crash after persistence before finalization → restart finalizes without double mutation', async () => {
    // Simulate: envelope seq=5, durable already reflects the snapshot (commit
    // succeeded), but lastApplied did NOT advance (finalize crashed). Restart
    // must finalize + clear WITHOUT re-applying the snapshot.
    durable = {
      medications: [med({ currentPills: 6, doseConsumptionHistory: { d1: [TODAY] } })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -1, date: TODAY, timestamp: '', description: '', doseId: 'd1' }],
    };
    let phase4Exact: ExactAutoEnvelope | null = {
      version: 1,
      status: 'js_ready',
      medications: durable.medications.map((m) => ({ ...m })),
      logs: durable.logs.map((l) => ({ ...l })),
      toAcknowledge: [{ medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY }],
      createdAt: new Date().toISOString(),
      mutationSeq: 5,
      globalAutoDeductEnabled: true,
    };
    let lastApplied = 0; // finalize crashed — lastApplied NOT advanced.
    let failFinalize = true;
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (seq) => { if (failFinalize) return 'lastApplied write failed'; lastApplied = seq; return null; },
      allocate: () => { return { ok: true, seq: 5 }; },
    });

    marked = [];
    const first = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (m, d, c) => { marked.push(`${m}|${d}|${c}`); return { ok: true, changed: true }; },
      loadEnvelope: () => phase4Exact,
      saveEnvelope: (e) => { phase4Exact = e; return null; },
    });
    // Finalize failed → blocked, envelope kept, no ACK.
    expect(phase4Exact).not.toBeNull();
    expect(first.recoveredEnvelope).toBe(true);
    expect(first.markedCount).toBe(0);
    const pillsAfterFirst = requireDefined(durable.medications[0], 'durable.medications[0]').currentPills;
    const logCountAfterFirst = durable.logs.length;

    // Restart: finalize succeeds now → snapshot matches → finalize + clear + ACK.
    failFinalize = false;
    marked = [];
    const second = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (m, d, c) => { marked.push(`${m}|${d}|${c}`); return { ok: true, changed: true }; },
      loadEnvelope: () => phase4Exact,
      saveEnvelope: (e) => { phase4Exact = e; return null; },
    });
    expect(phase4Exact).toBeNull();
    // No double mutation: same pills + same log count.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(pillsAfterFirst);
    expect(durable.logs.length).toBe(logCountAfterFirst);
    expect(marked).toEqual([`med-1|d1|${TODAY}`]);
    expect(second.markedCount).toBe(1);
  });
  it('clear failure after finalization → restart does not re-mutate; retries clear only', async () => {
    durable = {
      medications: [med({ currentPills: 6, doseConsumptionHistory: { d1: [TODAY] } })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -1, date: TODAY, timestamp: '', description: '', doseId: 'd1' }],
    };
    let phase4Exact: ExactAutoEnvelope | null = {
      version: 1,
      status: 'js_ready',
      medications: durable.medications.map((m) => ({ ...m })),
      logs: durable.logs.map((l) => ({ ...l })),
      toAcknowledge: [{ medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY }],
      createdAt: new Date().toISOString(),
      mutationSeq: 6,
      globalAutoDeductEnabled: true,
    };
    let lastApplied = 6;
    let failClear = true;
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (seq) => { lastApplied = seq; return null; },
      allocate: () => { return { ok: true, seq: 6 }; },
    });

    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (m, d, c) => { marked.push(`${m}|${d}|${c}`); return { ok: true, changed: true }; },
      loadEnvelope: () => phase4Exact,
      saveEnvelope: (e) => { if (e == null && failClear) return 'envelope_clear_failed'; phase4Exact = e; return null; },
    });
    // lastApplied covers seq 6 → cleanup path: collect acks + tryClear.
    // Clear fails → envelope kept. No ACK (clear is part of the cleanup
    // sequence; the recovery returns the acks but the orchestrator ACKs
    // only after clear succeeds — verify no re-mutation.
    expect(phase4Exact).not.toBeNull();
    const pillsAfterFirst = requireDefined(durable.medications[0], 'durable.medications[0]').currentPills;
    const logCountAfterFirst = durable.logs.length;

    // Restart: clear succeeds → envelope cleared. No re-mutation.
    failClear = false;
    marked = [];
    const second = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (m, d, c) => { marked.push(`${m}|${d}|${c}`); return { ok: true, changed: true }; },
      loadEnvelope: () => phase4Exact,
      saveEnvelope: (e) => { if (e == null && failClear) return 'envelope_clear_failed'; phase4Exact = e; return null; },
    });
    expect(phase4Exact).toBeNull();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(pillsAfterFirst);
    expect(durable.logs.length).toBe(logCountAfterFirst);
    expect(second.markedCount).toBeGreaterThanOrEqual(1);
  });
});
