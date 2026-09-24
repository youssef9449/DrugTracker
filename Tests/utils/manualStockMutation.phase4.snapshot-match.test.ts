import { describe, it, expect } from 'vitest';
import type { AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';
import { makeScheduledMedication as med } from '../fixtures/testFixtures';
import { exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';

import { durableMatchesEnvelopeSnapshot as matchesDurableEnvelope } from '../../src/utils/stockEnvelopeRecovery';

function durableMatchesEnvelopeSnapshot(
  envelope: {
    medications: import('../../src/types').Medication[];
    logs: import('../../src/types').ConsumptionLog[];
    globalAutoDeductEnabled?: boolean;
  },
  durable: AutoStockDurableState
): boolean {
  return matchesDurableEnvelope(envelope as any, durable);
}

describe('Phase 4 — durableMatchesEnvelopeSnapshot pure contract', () => {
  it('durableMatchesEnvelopeSnapshot requires complete medication array', () => {
    const full = {
      medications: [med({ currentPills: 9 }), med({ id: 'med-2', currentPills: 5 })],
      logs: [{ id: 'l1', medicationId: 'med-1', medicationName: 'T', type: 'dose_taken' as const, amount: 1, date: TODAY, timestamp: '', description: '' }],
    };
    const durableFull = {
      medications: full.medications.map((m: ReturnType<typeof med>) => ({ ...m })),
      logs: full.logs.map((l) => ({ ...l })),
    };
    expect(durableMatchesEnvelopeSnapshot(full, durableFull)).toBe(true);

    // Missing medication in durable
    const durableSubset = {
      medications: [med({ currentPills: 9 })],
      logs: durableFull.logs,
    };
    expect(durableMatchesEnvelopeSnapshot(full, durableSubset)).toBe(false);

    // Different currentPills
    const durablePills = {
      medications: [med({ currentPills: 8 }), med({ id: 'med-2', currentPills: 5 })],
      logs: durableFull.logs,
    };
    expect(durableMatchesEnvelopeSnapshot(full, durablePills)).toBe(false);

    // Matching log ids but different meds must be false
    const durableWrongMeds = {
      medications: [med({ currentPills: 10 }), med({ id: 'med-2', currentPills: 5 })],
      logs: durableFull.logs,
    };
    expect(durableMatchesEnvelopeSnapshot(full, durableWrongMeds)).toBe(false);
  });

  it('durableMatchesEnvelopeSnapshot: same log IDs but different log contents → not matched', () => {
    const env = {
      medications: [med({ currentPills: 9 })],
      logs: [{ id: 'l1', medicationId: 'med-1', medicationName: 'T', type: 'dose_taken' as const, amount: -1, date: TODAY, timestamp: 't1', description: 'd', doseId: 'd1' }],
    };
    // Same id, same medication, but amount differs (-1 vs -2).
    const durableDiffAmount = {
      medications: [med({ currentPills: 9 })],
      logs: [{ id: 'l1', medicationId: 'med-1', medicationName: 'T', type: 'dose_taken' as const, amount: -2, date: TODAY, timestamp: 't1', description: 'd', doseId: 'd1' }],
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffAmount)).toBe(false);
    // Same id but different doseId.
    const durableDiffDose = {
      medications: [med({ currentPills: 9 })],
      logs: [{ id: 'l1', medicationId: 'med-1', medicationName: 'T', type: 'dose_taken' as const, amount: -1, date: TODAY, timestamp: 't1', description: 'd', doseId: 'd2' }],
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffDose)).toBe(false);
    // Same id but different date.
    const durableDiffDate = {
      medications: [med({ currentPills: 9 })],
      logs: [{ id: 'l1', medicationId: 'med-1', medicationName: 'T', type: 'dose_taken' as const, amount: -1, date: '2026-09-15', timestamp: 't1', description: 'd', doseId: 'd1' }],
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffDate)).toBe(false);
  });

  it('durableMatchesEnvelopeSnapshot: same stock fields but different medication metadata → not matched', () => {
    const env = {
      medications: [med({ currentPills: 9, name: 'TestMed' })],
      logs: [],
    };
    // Same currentPills but different name.
    const durableDiffName = { medications: [med({ currentPills: 9, name: 'OtherMed' })], logs: [] };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffName)).toBe(false);
    // Same currentPills but different unit.
    const durableDiffUnit = { medications: [med({ currentPills: 9, unit: 'مل' })], logs: [] };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffUnit)).toBe(false);
    // Same currentPills but different dailyDose.
    const durableDiffDose = { medications: [med({ currentPills: 9, dailyDose: 3 })], logs: [] };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffDose)).toBe(false);
    // Same currentPills but different doseSchedule (array content).
    const durableDiffSchedule = {
      medications: [med({ currentPills: 9, doseSchedule: [{ id: 'd1', amount: 1, time: '09:00' }] })],
      logs: [],
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableDiffSchedule)).toBe(false);
  });

  it('durableMatchesEnvelopeSnapshot: medication/log count and order mismatches → not matched', () => {
    const env = {
      medications: [med({ currentPills: 9 }), med({ id: 'med-2', currentPills: 5 })],
      logs: [
        { id: 'l1', medicationId: 'med-1', medicationName: 'T', type: 'dose_taken' as const, amount: -1, date: TODAY, timestamp: '', description: '' },
        { id: 'l2', medicationId: 'med-1', medicationName: 'T', type: 'refill' as const, amount: 10, date: TODAY, timestamp: '', description: '' },
      ],
    };
    // Extra medication in durable.
    const durableExtraMed = {
      medications: [med({ currentPills: 9 }), med({ id: 'med-2', currentPills: 5 }), med({ id: 'med-3', currentPills: 1 })],
      logs: env.logs.map((l) => ({ ...l })),
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableExtraMed)).toBe(false);
    // Extra log in durable.
    const durableExtraLog = {
      medications: env.medications.map((m) => ({ ...m })),
      logs: [...env.logs.map((l) => ({ ...l })), { id: 'l3', medicationId: 'med-1', medicationName: 'T', type: 'refill' as const, amount: 5, date: TODAY, timestamp: '', description: '' }],
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableExtraLog)).toBe(false);
    // Missing log.
    const durableMissingLog = {
      medications: env.medications.map((m) => ({ ...m })),
      logs: [env.logs[0]].map((l) => ({ ...l })),
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableMissingLog)).toBe(false);
    // Same content, different medication order.
    const durableReorderedMeds = {
      medications: [med({ id: 'med-2', currentPills: 5 }), med({ currentPills: 9 })],
      logs: env.logs.map((l) => ({ ...l })),
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableReorderedMeds)).toBe(false);
    // Same content, different log order.
    const durableReorderedLogs = {
      medications: env.medications.map((m) => ({ ...m })),
      logs: [env.logs[1], env.logs[0]].map((l) => ({ ...l })),
    };
    expect(durableMatchesEnvelopeSnapshot(env, durableReorderedLogs)).toBe(false);
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
    expect(durable.medications[0].currentPills).toBe(8);
    expect(durable.logs.filter((l) => l.id === 'match-clear')).toHaveLength(1);
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
    expect(durable.medications[0].currentPills).toBe(7);
    expect(durable.logs.some((l) => l.id === 'mismatch-apply')).toBe(true);
    expect(phase4Exact).toBeNull();
    expect(lastApplied).toBe(4);
    expect(marked).toEqual([`med-1|d1|${TODAY}`]);
    expect(recon.markedCount).toBe(1);
  });

});
