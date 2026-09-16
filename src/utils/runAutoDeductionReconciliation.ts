/**
 * Phase 3 orchestrator — runs inside withAutoStockMutationGate so it always
 * mutates FRESH durable state (not a React snapshot captured before the gate).
 *
 * Durability (Option B for partial native ack):
 *   Once meds + logs are successfully written, exact markers + deterministic
 *   log ids are the JS recovery source. Native remaining FIRED events are
 *   re-listed and acknowledged on retry without a second stock/log mutation.
 *   Envelope is cleared after successful meds+logs commit even if some native
 *   marks fail — those marks retry via listFired + already_applied.
 */

import type { ConsumptionLog, Medication } from '../types';
import {
  listFiredAutoDeductionEvents,
  markAutoDeductionEventReconciled,
  type AutoDeductionEvent,
  type MarkReconciledResult,
} from './autoDeductionNative';
import {
  reconcileFiredEvents,
  type ReconcileFiredResult,
} from './autoDeductionReconciliation';
import {
  withAutoStockMutationGate,
  commitDurableAutoStockState,
  type AutoStockDurableState,
} from './autoDeductionStockGate';
import {
  recoverAllPendingStockEnvelopes,
  loadManualStockEnvelope,
  saveManualStockEnvelope,
  loadExactAutoStockEnvelope,
  saveExactAutoStockEnvelope,
  finalizeMutationSeq,
  type PendingEnvelopeRef,
} from './stockEnvelopeRecovery';
import { allocateMutationSeq } from './stockMutationOrdering';
import { loadJson, persist } from './storage';

const STORAGE_ENVELOPE_KEY = 'android_med_tracker_exact_auto_envelope_v1';

export interface ExactAutoEnvelope {
  version: 1;
  status: 'js_ready';
  medications: Medication[];
  logs: ConsumptionLog[];
  toAcknowledge: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }>;
  createdAt: string;
  /** Shared causal order with Manual envelopes (stockMutationOrdering). */
  mutationSeq?: number;
}

export interface RunReconciliationInput {
  globalAutoDeductEnabled: boolean;
  /** Prefer omit — gate loads durable state. Kept for tests that inject. */
  medications?: Medication[];
  logs?: ConsumptionLog[];
  listFired?: () => Promise<AutoDeductionEvent[]>;
  markReconciled?: (
    medicationId: string,
    doseId: string,
    calendarDate: string
  ) => Promise<MarkReconciledResult>;
  persistMeds?: (meds: Medication[]) => string | null;
  persistLogs?: (logs: ConsumptionLog[]) => string | null;
  loadEnvelope?: () => ExactAutoEnvelope | null;
  saveEnvelope?: (env: ExactAutoEnvelope | null) => string | null;
  /** When true, skip outer gate (caller already holds it). */
  alreadyInGate?: boolean;
  now?: Date;
}

export interface RunReconciliationOutput extends ReconcileFiredResult {
  markedCount: number;
  recoveredEnvelope: boolean;
  /** True when at least one native mark failed after JS commit (retryable). */
  partialNativeAck: boolean;
}

/** @internal test-only envelope injectors (shared with Phase 4 manual gate). */
let testLoadEnvelope: (() => ExactAutoEnvelope | null) | null = null;
let testSaveEnvelope: ((env: ExactAutoEnvelope | null) => string | null) | null =
  null;

/** @internal test-only */
export function __setExactAutoEnvelopeTestHooks(hooks: {
  load?: () => ExactAutoEnvelope | null;
  save?: (env: ExactAutoEnvelope | null) => string | null;
} | null): void {
  testLoadEnvelope = hooks?.load ?? null;
  testSaveEnvelope = hooks?.save ?? null;
}

export function defaultLoadEnvelope(): ExactAutoEnvelope | null {
  if (testLoadEnvelope) return testLoadEnvelope();
  return loadExactAutoStockEnvelope() as ExactAutoEnvelope | null;
}

export function defaultSaveEnvelope(env: ExactAutoEnvelope | null): string | null {
  if (testSaveEnvelope) return testSaveEnvelope(env);
  return saveExactAutoStockEnvelope(env);
}

/**
 * Recover a prior js_ready envelope into durable meds+logs (Phase 3 Option B).
 * Used by exact reconciliation and Phase 4 manual Take/Restore after a crash
 * between partial storage writes.
 */
export function recoverExactAutoEnvelopeIfPresent(
  commit: (state: AutoStockDurableState) => string | null = commitDurableAutoStockState,
  loadEnvelope: () => ExactAutoEnvelope | null = defaultLoadEnvelope,
  saveEnvelope: (env: ExactAutoEnvelope | null) => string | null = defaultSaveEnvelope
): {
  recovered: boolean;
  state: AutoStockDurableState | null;
  writeFailed: boolean;
} {
  const existing = loadEnvelope();
  if (!existing) {
    return { recovered: false, state: null, writeFailed: false };
  }
  const err = commit({
    medications: existing.medications,
    logs: existing.logs,
  });
  if (err) {
    return { recovered: true, state: null, writeFailed: true };
  }
  saveEnvelope(null);
  return {
    recovered: true,
    state: {
      medications: existing.medications,
      logs: existing.logs,
    },
    writeFailed: false,
  };
}

export function runAutoDeductionReconciliation(
  input: RunReconciliationInput
): Promise<RunReconciliationOutput> {
  if (input.alreadyInGate) {
    return runOnce(input, {
      medications: input.medications ?? [],
      logs: input.logs ?? [],
    });
  }
  return withAutoStockMutationGate((fresh) => runOnce(input, fresh));
}

async function markAll(
  acks: Array<{ medicationId: string; doseId: string; calendarDate: string }>,
  mark: (
    medicationId: string,
    doseId: string,
    calendarDate: string
  ) => Promise<MarkReconciledResult>
): Promise<{ markedCount: number; failed: typeof acks }> {
  let markedCount = 0;
  const failed: typeof acks = [];
  for (const ack of acks) {
    try {
      const result = await mark(ack.medicationId, ack.doseId, ack.calendarDate);
      // ok=true (whether changed or already RECONCILED) is successful terminal ack.
      // ok=false is a real native acknowledgement failure and must remain retryable.
      if (result && result.ok === true) {
        markedCount += 1;
      } else {
        failed.push(ack);
      }
    } catch {
      failed.push(ack);
    }
  }
  return { markedCount, failed };
}

async function runOnce(
  input: RunReconciliationInput,
  fresh: AutoStockDurableState
): Promise<RunReconciliationOutput> {
  const listFired = input.listFired ?? listFiredAutoDeductionEvents;
  const mark =
    input.markReconciled ??
    ((medicationId: string, doseId: string, calendarDate: string) =>
      markAutoDeductionEventReconciled(medicationId, doseId, calendarDate));
  const loadEnvelope = input.loadEnvelope ?? defaultLoadEnvelope;
  const saveEnvelope = input.saveEnvelope ?? defaultSaveEnvelope;

  // Prefer explicit inject for tests; otherwise durable gate state.
  let baseMeds = input.medications ?? fresh.medications;
  let baseLogs = input.logs ?? fresh.logs;

  // Unified Manual + Exact Auto envelope recovery (mutationSeq causal order).
  // Highest seq above lastApplied is recovered first (full snapshot). Lower
  // pending envelopes never overwrite while higher is unresolved. Manual path
  // never performs native markReconciled — only Exact Auto toAcknowledge lists
  // returned here are ACKed below.
  {
    const pending: PendingEnvelopeRef[] = [];
    const manualEnv = loadManualStockEnvelope();
    if (manualEnv) {
      pending.push({
        kind: 'manual',
        mutationSeq: manualEnv.mutationSeq,
        medications: manualEnv.medications,
        logs: manualEnv.logs,
        clear: () => saveManualStockEnvelope(null),
      });
    }
    const existingExact = loadEnvelope();
    if (existingExact) {
      pending.push({
        kind: 'exact_auto',
        mutationSeq: existingExact.mutationSeq ?? 0,
        medications: existingExact.medications,
        logs: existingExact.logs,
        toAcknowledge: existingExact.toAcknowledge,
        clear: () => saveEnvelope(null),
      });
    }

    if (pending.length > 0) {
      const commit = (
        state: AutoStockDurableState,
        appliedMutationSeq: number
      ): string | null => {
        if (input.persistMeds || input.persistLogs) {
          const medErr = input.persistMeds
            ? input.persistMeds(state.medications)
            : null;
          const logErr = input.persistLogs ? input.persistLogs(state.logs) : null;
          if (medErr || logErr) return medErr || logErr || 'persist_failed';
          return finalizeMutationSeq(appliedMutationSeq);
        }
        return commitDurableAutoStockState(state, { appliedMutationSeq });
      };

      const unified = recoverAllPendingStockEnvelopes(
        { medications: baseMeds, logs: baseLogs },
        pending,
        commit
      );

      baseMeds = unified.state.medications;
      baseLogs = unified.state.logs;

      if (unified.exactToAcknowledge.length > 0) {
        const { markedCount, failed } = await markAll(
          unified.exactToAcknowledge,
          mark
        );
        return {
          medications: baseMeds,
          logs: baseLogs,
          toAcknowledge: unified.exactToAcknowledge,
          details: unified.exactToAcknowledge.map((a) => ({
            medicationId: a.medicationId,
            doseId: a.doseId,
            calendarDate: a.calendarDate,
            amount: 0,
            outcome: 'already_applied' as const,
            occurrenceKey: `${a.medicationId}${a.doseId}${a.calendarDate}`,
          })),
          mutated: unified.recovered,
          newExactLogs: [],
          markedCount,
          recoveredEnvelope: true,
          partialNativeAck: failed.length > 0,
        };
      }

      if (unified.blocked) {
        return {
          medications: baseMeds,
          logs: baseLogs,
          toAcknowledge: [],
          details: [],
          mutated: unified.recovered,
          newExactLogs: [],
          markedCount: 0,
          recoveredEnvelope: true,
          partialNativeAck: false,
        };
      }
      // Manual-only recovery may have completed; fall through to listFired.
    }
  }

  let events: AutoDeductionEvent[] = [];
  try {
    events = await listFired();
  } catch {
    events = [];
  }

  if (!events.length) {
    return {
      medications: baseMeds,
      logs: baseLogs,
      toAcknowledge: [],
      details: [],
      mutated: false,
      newExactLogs: [],
      markedCount: 0,
      recoveredEnvelope: false,
      partialNativeAck: false,
    };
  }

  const result = reconcileFiredEvents(baseMeds, baseLogs, events, {
    globalAutoDeductEnabled: input.globalAutoDeductEnabled,
    now: input.now,
  });

  if (!result.mutated && result.toAcknowledge.length === 0) {
    return {
      ...result,
      markedCount: 0,
      recoveredEnvelope: false,
      partialNativeAck: false,
    };
  }

  // Acknowledge-only: markers already durable in baseMeds
  if (!result.mutated) {
    const { markedCount, failed } = await markAll(result.toAcknowledge, mark);
    return {
      ...result,
      markedCount,
      recoveredEnvelope: false,
      partialNativeAck: failed.length > 0,
    };
  }

  // Mutating path: envelope → meds+logs → mark → clear (Option B)
  const alloc = allocateMutationSeq();
  if (!alloc.ok) {
    return {
      medications: baseMeds,
      logs: baseLogs,
      toAcknowledge: [],
      details: result.details,
      mutated: false,
      newExactLogs: [],
      markedCount: 0,
      recoveredEnvelope: false,
      partialNativeAck: false,
    };
  }
  const mutationSeq = alloc.seq;
  const envelope: ExactAutoEnvelope = {
    version: 1,
    status: 'js_ready',
    medications: result.medications,
    logs: result.logs,
    toAcknowledge: result.toAcknowledge,
    createdAt: new Date().toISOString(),
    mutationSeq,
  };

  const envErr = saveEnvelope(envelope);
  if (envErr) {
    return {
      medications: baseMeds,
      logs: baseLogs,
      toAcknowledge: [],
      details: result.details,
      mutated: false,
      newExactLogs: [],
      markedCount: 0,
      recoveredEnvelope: false,
      partialNativeAck: false,
    };
  }

  let writeOk = true;
  if (input.persistMeds || input.persistLogs) {
    const medErr = input.persistMeds
      ? input.persistMeds(result.medications)
      : null;
    const logErr = input.persistLogs ? input.persistLogs(result.logs) : null;
    if (medErr || logErr) writeOk = false;
  } else {
    const err = commitDurableAutoStockState(
      {
        medications: result.medications,
        logs: result.logs,
      },
      { appliedMutationSeq: mutationSeq }
    );
    if (err) writeOk = false;
  }

  if (!writeOk) {
    // Keep envelope for recovery; do not mark native
    return {
      medications: baseMeds,
      logs: baseLogs,
      toAcknowledge: result.toAcknowledge,
      details: result.details,
      mutated: false,
      newExactLogs: result.newExactLogs,
      markedCount: 0,
      recoveredEnvelope: false,
      partialNativeAck: false,
    };
  }

  const { markedCount, failed } = await markAll(result.toAcknowledge, mark);
  // Option B: JS durable → clear envelope even if some marks failed.
  // Remaining FIRED + markers + deterministic logs recover on next run.
  saveEnvelope(null);

  return {
    ...result,
    markedCount,
    recoveredEnvelope: false,
    partialNativeAck: failed.length > 0,
  };
}
