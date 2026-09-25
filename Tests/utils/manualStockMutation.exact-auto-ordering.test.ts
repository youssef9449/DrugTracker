import { requireDefined } from '../helpers/requireDefined';
import { __setStockMutationOrderingTestHooks, __resetStockMutationOrderingForTests, __setManualEnvelopeTestHooks, __setExactAutoEnvelopeStorageTestHooks, __setAutoStockGateTestHooks } from './autoStockTestHooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';
import type { ManualStockEnvelope } from '../../src/utils/stockEnvelopeRecovery';
import type { ExactAutoEnvelope } from '../../src/utils/runAutoDeductionReconciliation';


import { makeScheduledMedication as med } from '../fixtures/testFixtures';
import { runGatedManualConsume } from '../../src/utils/manualStockMutation';
import { loadExactAutoStockEnvelope } from '../../src/utils/stockEnvelopeRecovery';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';


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




describe('Exact Auto and Manual envelope ordering', () => {
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
    // Seed 10 pills: absolute assertions below expect 9 after a 1-pill Take.
    durable = { medications: [med({ currentPills: 10 })], logs: [], globalAutoDeductEnabled: false };
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
  it('Manual + Exact Auto envelopes together: older seq never overwrites newer durable', async () => {
    // Apply a successful Manual Take (seq=1) so durable is at pills=9.
    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(9);
    const newerLogs = durable.logs.map((l) => ({ ...l }));

    // Plant older Manual envelope (seq 1 already applied) with contradictory stock=10.
    // Production envelopes always carry globalAutoDeductEnabled + stockDeltas +
    // occurrenceResolutions (readManualStockEnvelopeOutcome rejects shapes without them).
    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 10 })],
      logs: [{ id: 'old-log', medicationId: 'med-1', medicationName: 'TestMed', type: 'dose_taken', amount: 1, date: TODAY, timestamp: '', description: '' }],
      globalAutoDeductEnabled: false,
      stockDeltas: [],
      occurrenceResolutions: [],
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
      mutationSeq: 1,
    };

    // Plant Exact Auto envelope with higher seq that matches current durable (no overwrite).
    let exactEnv: {
      version: 1;
      status: 'js_ready';
      medications: typeof durable.medications;
      logs: typeof durable.logs;
      toAcknowledge: Array<{ medicationId: string; doseId: string; calendarDate: string }>;
      createdAt: string;
      mutationSeq: number;
      globalAutoDeductEnabled: true,
    } | null = {
      version: 1,
      status: 'js_ready',
      medications: durable.medications.map((m) => ({ ...m, currentPills: 8 })),
      logs: [
        ...newerLogs,
        {
          id: 'exact-extra',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: 1,
          date: TODAY,
          timestamp: '',
          description: '',
        },
      ],
      toAcknowledge: [
        { medicationId: 'med-1', doseId: 'd2', calendarDate: TODAY },
      ],
      createdAt: new Date().toISOString(),
      mutationSeq: 2,
      globalAutoDeductEnabled: true,
    };

    marked = [];
    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
      loadEnvelope: () => exactEnv,
      saveEnvelope: (env) => {
        exactEnv = env as typeof exactEnv;
        return null;
      },
    });

    // Older Manual (seq 1) discarded; Exact Auto seq 2 applied once.
    expect(manualEnvelope).toBeNull();
    expect(exactEnv).toBeNull();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(8);
    expect(durable.logs.some((l) => l.id === 'exact-extra')).toBe(true);
    // Manual old stock=10 must not win.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).not.toBe(10);
    // ACK only from Exact Auto toAcknowledge (FIRED ownership at envelope time).
    expect(marked).toEqual([`med-1|d2|${TODAY}`]);
    expect(recon.recoveredEnvelope).toBe(true);
  });
  it('seq11 durable with lastApplied lag: pending seq10 must not overwrite', async () => {
    // Durable already reflects newer mutation (seq 2) but lastApplied still 0.
    const seq2Logs = [
      {
        id: 'seq2-log',
        medicationId: 'med-1',
        medicationName: 'TestMed',
        type: 'dose_taken' as const,
        amount: 1,
        date: TODAY,
        timestamp: '',
        description: '',
      },
    ];
    durable.medications = [med({ currentPills: 8 })];
    durable.logs = seq2Logs;

    // Older pending envelope wants to restore stock=10.
    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 10 })],
      logs: [
        {
          id: 'seq1-log',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: 1,
          date: TODAY,
          timestamp: '',
          description: '',
        },
      ],
      globalAutoDeductEnabled: false,
      stockDeltas: [],
      occurrenceResolutions: [],
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
      mutationSeq: 1,
    };

    let exactEnv: {
      version: 1;
      status: 'js_ready';
      medications: typeof durable.medications;
      logs: typeof durable.logs;
      toAcknowledge: Array<{ medicationId: string; doseId: string; calendarDate: string }>;
      createdAt: string;
      mutationSeq: number;
      globalAutoDeductEnabled: true,
    } | null = {
      version: 1,
      status: 'js_ready',
      medications: [med({ currentPills: 8 })],
      logs: seq2Logs,
      toAcknowledge: [],
      createdAt: new Date().toISOString(),
      mutationSeq: 2,
      globalAutoDeductEnabled: true,
    };

    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      loadEnvelope: () => exactEnv,
      saveEnvelope: (env) => {
        exactEnv = env as typeof exactEnv;
        return null;
      },
    });

    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(8);
    expect(durable.logs.some((l) => l.id === 'seq2-log')).toBe(true);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).not.toBe(10);
  });
  it('both pending: higher Exact Auto seq recovered before older Manual can write', async () => {
    // lastApplied=0; durable still at base stock=10
    durable = { medications: [med({ currentPills: 10 })], logs: [] };

    const seq10Logs = [
      {
        id: 'manual-seq10',
        medicationId: 'med-1',
        medicationName: 'TestMed',
        type: 'dose_taken' as const,
        amount: 1,
        date: TODAY,
        timestamp: '',
        description: '',
      },
    ];
    const seq11Logs = [
      ...seq10Logs,
      {
        id: 'exact-seq11',
        medicationId: 'med-1',
        medicationName: 'TestMed',
        type: 'dose_taken' as const,
        amount: 1,
        date: TODAY,
        timestamp: '',
        description: '',
      },
    ];

    // Older Manual wants stock=9 (after one take)
    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 9 })],
      logs: seq10Logs,
      globalAutoDeductEnabled: true,
      stockDeltas: [],
      occurrenceResolutions: [],
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
      mutationSeq: 10,
    };

    // Newer Exact Auto full snapshot stock=8
    let exactEnv: {
      version: 1;
      status: 'js_ready';
      medications: ReturnType<typeof med>[];
      logs: typeof seq11Logs;
      toAcknowledge: Array<{ medicationId: string; doseId: string; calendarDate: string }>;
      createdAt: string;
      mutationSeq: number;
      globalAutoDeductEnabled: true,
    } | null = {
      version: 1,
      status: 'js_ready',
      medications: [med({ currentPills: 8 })],
      logs: seq11Logs,
      toAcknowledge: [
        { medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY },
      ],
      createdAt: new Date().toISOString(),
      mutationSeq: 11,
      globalAutoDeductEnabled: true,
    };

    marked = [];
    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
      loadEnvelope: () => exactEnv,
      saveEnvelope: (env) => {
        exactEnv = env as typeof exactEnv;
        return null;
      },
    });

    // Higher seq wins: stock=8 not Manual's 9
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(8);
    expect(durable.logs.some((l) => l.id === 'exact-seq11')).toBe(true);
    expect(manualEnvelope).toBeNull();
    expect(exactEnv).toBeNull();
    expect(marked).toEqual([`med-1|d1|${TODAY}`]);
  });
  it('both pending reverse: higher Manual seq wins over older Exact Auto', async () => {
    durable = { medications: [med({ currentPills: 10 })], logs: [] };

    manualEnvelope = {
      version: 1,
      status: 'manual_js_ready',
      medications: [med({ currentPills: 7 })],
      logs: [
        {
          id: 'manual-seq11',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: 1,
          date: TODAY,
          timestamp: '',
          description: '',
        },
      ],
      globalAutoDeductEnabled: true,
      stockDeltas: [],
      occurrenceResolutions: [],
      createdAt: new Date().toISOString(),
      baseGeneration: 0,
      mutationSeq: 11,
    };

    let exactEnv: {
      version: 1;
      status: 'js_ready';
      medications: ReturnType<typeof med>[];
      logs: Array<{
        id: string;
        medicationId: string;
        medicationName: string;
        type: 'dose_taken';
        amount: number;
        date: string;
        timestamp: string;
        description: string;
      }>;
      toAcknowledge: Array<{ medicationId: string; doseId: string; calendarDate: string }>;
      createdAt: string;
      mutationSeq: number;
      globalAutoDeductEnabled: true,
    } | null = {
      version: 1,
      status: 'js_ready',
      medications: [med({ currentPills: 9 })],
      logs: [
        {
          id: 'exact-seq10',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: 1,
          date: TODAY,
          timestamp: '',
          description: '',
        },
      ],
      toAcknowledge: [],
      createdAt: new Date().toISOString(),
      mutationSeq: 10,
      globalAutoDeductEnabled: true,
    };

    await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async () => ({ ok: true, changed: true }),
      loadEnvelope: () => exactEnv,
      saveEnvelope: (env) => {
        exactEnv = env as typeof exactEnv;
        return null;
      },
    });

    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(7);
    expect(durable.logs.some((l) => l.id === 'manual-seq11')).toBe(true);
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).not.toBe(9);
  });
  it('Exact Auto envelope seq<=lastApplied still returns toAcknowledge for orchestrator ACK', async () => {
    // Simulate finalized mutation (lastApplied covers seq) but envelope still present.
    durable = { medications: [med({ currentPills: 8 })], logs: [] };
    let lastApplied = 11;
    let nextSeq = 11;
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (seq) => {
        lastApplied = seq;
        return null;
      },
      allocate: () => {
        nextSeq += 1;
        return { ok: true, seq: nextSeq };
      },
    });

    let exactEnv: {
      version: 1;
      status: 'js_ready';
      medications: ReturnType<typeof med>[];
      logs: [];
      toAcknowledge: Array<{ medicationId: string; doseId: string; calendarDate: string }>;
      createdAt: string;
      mutationSeq: number;
      globalAutoDeductEnabled: true,
    } | null = {
      version: 1,
      status: 'js_ready',
      medications: [med({ currentPills: 8 })],
      logs: [],
      toAcknowledge: [
        { medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY },
        { medicationId: 'med-1', doseId: 'd2', calendarDate: TODAY },
      ],
      createdAt: new Date().toISOString(),
      mutationSeq: 11,
      globalAutoDeductEnabled: true,
    };

    marked = [];
    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        marked.push(`${medicationId}|${doseId}|${calendarDate}`);
        return { ok: true, changed: true };
      },
      loadEnvelope: () => exactEnv,
      saveEnvelope: (env) => {
        exactEnv = env as typeof exactEnv;
        return null;
      },
    });

    expect(marked).toEqual([
      `med-1|d1|${TODAY}`,
      `med-1|d2|${TODAY}`,
    ]);
    expect(recon.markedCount).toBe(2);
    expect(exactEnv).toBeNull();
    // No stock mutation on cleanup-only path.
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(8);
  });
  it('Exact envelope missing mutationSeq is rejected (no Phase 4 recovery)', () => {
    // Legacy/pre-fix payload without mutationSeq must not be accepted.
    const legacyLike = {
      version: 1 as const,
      status: 'js_ready' as const,
      medications: [med({ currentPills: 5 })],
      logs: [],
      toAcknowledge: [],
      createdAt: new Date().toISOString(),
      globalAutoDeductEnabled: true,
      // mutationSeq intentionally absent
    };
    __setExactAutoEnvelopeStorageTestHooks({
      load: () => legacyLike as never,
      save: () => null,
    });
    expect(loadExactAutoStockEnvelope()).toBeNull();
    __setExactAutoEnvelopeStorageTestHooks(null);
  });
  it('Exact envelope with non-positive mutationSeq is rejected', () => {
    __setExactAutoEnvelopeStorageTestHooks({
      load: () =>
        ({
          version: 1,
          status: 'js_ready',
          medications: [med({ currentPills: 5 })],
          logs: [],
          toAcknowledge: [],
          createdAt: new Date().toISOString(),
          globalAutoDeductEnabled: true,
          mutationSeq: 0,
        }) as never,
      save: () => null,
    });
    expect(loadExactAutoStockEnvelope()).toBeNull();
    __setExactAutoEnvelopeStorageTestHooks(null);
  });
  it('pending Exact Auto is recovered before Manual Take allocates a new seq', async () => {
    durable = { medications: [med({ currentPills: 10 })], logs: [] };
    // Plant Exact Auto envelope seq=5 with stock=8 (one auto deduction applied in snapshot)
    // Use test hook path via __setExactAutoEnvelopeStorageTestHooks if available
    let exactEnv: ExactAutoEnvelope | null = {
      version: 1,
      status: 'js_ready',
      medications: [med({ currentPills: 8 })],
      logs: [
        {
          id: 'exact-pending',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: 1,
          date: TODAY,
          timestamp: '',
          description: '',
        },
      ],
      toAcknowledge: [{ medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY }],
      createdAt: new Date().toISOString(),
      mutationSeq: 5,
      globalAutoDeductEnabled: true,
    };
    __setExactAutoEnvelopeStorageTestHooks({
      load: () => exactEnv,
      save: (env) => {
        exactEnv = env as ExactAutoEnvelope | null;
        return null;
      },
    });

    await runGatedManualConsume({
      medicationId: 'med-1',
      doseId: 'd2',
      source: 'manual',
      todayStr: TODAY,
    });
    // Exact Auto seq 5 must be applied first (stock 8), then Manual d2 may apply
    // If d2 take applied: stock 7; if already blocked etc.
    expect(exactEnv).toBeNull();
    // Durable must reflect at least the Exact Auto snapshot base (not still 10)
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBeLessThan(10);
    expect(durable.logs.some((l: { id: string }) => l.id === 'exact-pending')).toBe(true);

    __setExactAutoEnvelopeStorageTestHooks(null);
  });
  it('durableMatchesEnvelopeSnapshot: full match → finalize + clear without re-apply (via recovery)', async () => {
    // Envelope snapshot exactly equals durable → recovery finalizes + clears
    // without re-applying the snapshot (no extra mutation).
    durable = {
      medications: [med({ currentPills: 8, doseConsumptionHistory: { d1: [TODAY] } })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -1, date: TODAY, timestamp: '', description: '', doseId: 'd1' }],
    };
    let phase4Exact: ExactAutoEnvelope | null = {
      version: 1,
      status: 'js_ready',
      medications: durable.medications.map((m) => ({ ...m })),
      logs: durable.logs.map((l) => ({ ...l })),
      toAcknowledge: [{ medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY }],
      createdAt: new Date().toISOString(),
      mutationSeq: 3,
      globalAutoDeductEnabled: true,
    };
    let lastApplied = 3;
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (seq) => { lastApplied = seq; return null; },
      allocate: () => { return { ok: true, seq: 99 }; },
    });

    marked = [];
    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (m, d, c) => { marked.push(`${m}|${d}|${c}`); return { ok: true, changed: true }; },
      loadEnvelope: () => phase4Exact,
      saveEnvelope: (e) => { phase4Exact = e; return null; },
    });

    // Snapshot matched → finalize (no-op, seq 3 <= lastApplied 3) + clear + ACK.
    expect(phase4Exact).toBeNull();
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(8);
    // Without re-apply: the original exact_auto log remains exactly once.
    expect(
      durable.logs.filter((l) => l.id === exactAutoLogId('med-1', 'd1', TODAY))
    ).toHaveLength(1);
    expect(marked).toEqual([`med-1|d1|${TODAY}`]);
    expect(recon.markedCount).toBe(1);
  });
  it('durableMatchesEnvelopeSnapshot: mismatch → apply snapshot then finalize then clear', async () => {
    // Envelope snapshot differs from durable → recovery re-applies the
    // envelope snapshot, finalizes, then clears.
    durable = { medications: [med({ currentPills: 10 })], logs: [] };
    let phase4Exact: ExactAutoEnvelope | null = {
      version: 1,
      status: 'js_ready',
      medications: [med({ currentPills: 7, doseConsumptionHistory: { d1: [TODAY] } })],
      logs: [{ id: exactAutoLogId('med-1', 'd1', TODAY), medicationId: 'med-1', medicationName: 'TestMed', type: 'exact_auto', amount: -1, date: TODAY, timestamp: '', description: '', doseId: 'd1' }],
      toAcknowledge: [{ medicationId: 'med-1', doseId: 'd1', calendarDate: TODAY }],
      createdAt: new Date().toISOString(),
      mutationSeq: 4,
      globalAutoDeductEnabled: true,
    };
    let lastApplied = 0;
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => lastApplied,
      persistLastApplied: (seq) => { lastApplied = seq; return null; },
      allocate: () => { return { ok: true, seq: 4 }; },
    });

    marked = [];
    const recon = await runAutoDeductionReconciliation({
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
      markReconciled: async (m, d, c) => { marked.push(`${m}|${d}|${c}`); return { ok: true, changed: true }; },
      loadEnvelope: () => phase4Exact,
      saveEnvelope: (e) => { phase4Exact = e; return null; },
    });

    // Snapshot re-applied: durable now matches envelope (currentPills=7).
    expect(requireDefined(durable.medications[0], 'durable.medications[0]').currentPills).toBe(7);
    expect(
      durable.logs.some((l) => l.id === exactAutoLogId('med-1', 'd1', TODAY))
    ).toBe(true);
    expect(phase4Exact).toBeNull();
    expect(lastApplied).toBe(4);
    expect(marked).toEqual([`med-1|d1|${TODAY}`]);
    expect(recon.markedCount).toBe(1);
  });
});
