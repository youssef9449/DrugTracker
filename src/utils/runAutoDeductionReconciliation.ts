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
  applyAutoDeductionStock,
  convergeAutoDeductionStock,
  type AutoDeductionEvent,
  type ListFiredEventsResult,
  type MarkReconciledResult,
} from './autoDeductionNative';
import {
  reconcileFiredEvents,
  type ReconcileFiredResult,
} from './autoDeductionReconciliation';
import {
  withAutoStockMutationGate,
  commitDurableAutoStockState,
  loadDurableGlobalAutoDeductEnabled,
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
import { persist } from './storage';
import { STORAGE_MEDS_KEY } from './autoDeductionStockGate';

export interface ExactAutoEnvelope {
  version: 1;
  status: 'js_ready';
  medications: Medication[];
  logs: ConsumptionLog[];
  /** Phase 4 durable global master switch (required). */
  globalAutoDeductEnabled: boolean;
  toAcknowledge: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }>;
  createdAt: string;
  /** Shared causal order with Manual envelopes — required (no legacy seq). */
  mutationSeq: number;
}

export interface RunReconciliationInput {
  globalAutoDeductEnabled: boolean;
  /** Prefer omit — gate loads durable state. Kept for tests that inject. */
  medications?: Medication[];
  logs?: ConsumptionLog[];
  listFired?: () => Promise<ListFiredEventsResult>;
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
  /** Fresh durable state from the already-held gate, including the global master switch. */
  durableState?: AutoStockDurableState;
  now?: Date;
}

export interface RunReconciliationOutput extends ReconcileFiredResult {
  markedCount: number;
  recoveredEnvelope: boolean;
  /** True when at least one native mark failed after JS commit (retryable). */
  partialNativeAck: boolean;
  /** True when the exact stock mutation could not be durably finalized; callers must fail closed. */
  durabilityBlocked?: boolean;
  /** True when native FIRED list failed — distinct from empty events; no mutation/ack. */
  nativeListFailed?: boolean;
  nativeListError?: string;
  /** True when Native Auto stock could not be initialized, repaired, or read. */
  nativeStockSyncFailed?: boolean;
  nativeStockSyncError?: string;
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

export function runAutoDeductionReconciliation(
  input: RunReconciliationInput
): Promise<RunReconciliationOutput> {
  if (input.alreadyInGate) {
    return runOnce(
      input,
      input.durableState ?? {
        medications: input.medications ?? [],
        logs: input.logs ?? [],
      }
    );
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
  const preNativeConvergenceMeds = baseMeds;

  // Auto owns the live stock balance in Native. Seed only missing rows and
  // mirror authoritative Native currentPills into the JS durable snapshot.
  const initialStockConvergence = await convergeAutoDeductionStock(baseMeds);
  if (!initialStockConvergence.ok) {
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
      durabilityBlocked: true,
      nativeStockSyncFailed: true,
      nativeStockSyncError: initialStockConvergence.error,
    };
  }
  baseMeds = initialStockConvergence.medications;
  const nativeStockChanged = baseMeds.some((m) => {
    const before = preNativeConvergenceMeds.find((x) => x.id === m.id);
    return before != null && Number(before.currentPills) !== Number(m.currentPills);
  });

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
        globalAutoDeductEnabled: manualEnv.globalAutoDeductEnabled,
        stockDeltas: manualEnv.stockDeltas ?? [],
        clear: () => saveManualStockEnvelope(null),
      });
    }

    // Issue #267: Legacy Exact Auto envelope migration removed. Only
    // current Phase 4 envelopes (with mutationSeq) are valid.
    const existingExact = loadEnvelope();
    if (existingExact) {
      pending.push({
        kind: 'exact_auto',
        mutationSeq: existingExact.mutationSeq,
        medications: existingExact.medications,
        logs: existingExact.logs,
        globalAutoDeductEnabled: existingExact.globalAutoDeductEnabled,
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

      const unified = await recoverAllPendingStockEnvelopes(
        {
          medications: baseMeds,
          logs: baseLogs,
          globalAutoDeductEnabled: fresh.globalAutoDeductEnabled,
        },
        pending,
        commit
      );

      baseMeds = unified.state.medications;
      baseLogs = unified.state.logs;

      // A recovered foreground envelope may contain a snapshot captured before
      // a later Native Auto deduction. Re-read Native stock after replay so the
      // returned JS mirror can never overwrite a newer background deduction.
      const postEnvelopeConvergence = await convergeAutoDeductionStock(baseMeds);
      if (!postEnvelopeConvergence.ok) {
        return {
          medications: baseMeds,
          logs: baseLogs,
          toAcknowledge: [],
          details: [],
          mutated: unified.recovered,
          newExactLogs: [],
          markedCount: 0,
          recoveredEnvelope: unified.recovered,
          partialNativeAck: false,
          durabilityBlocked: true,
          nativeStockSyncFailed: true,
          nativeStockSyncError: postEnvelopeConvergence.error,
        };
      }
      baseMeds = postEnvelopeConvergence.medications;

      if (unified.exactToAcknowledge.length > 0) {
        const { markedCount, failed } = await markAll(unified.exactToAcknowledge, mark);
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
            occurrenceKey: `${a.medicationId}${a.doseId}${a.calendarDate}`,
          })),
          mutated: unified.recovered,
          newExactLogs: [],
          markedCount,
          recoveredEnvelope: true,
          partialNativeAck: failed.length > 0,
          durabilityBlocked: unified.durabilityBlocked,
        };
      }

      if (unified.durabilityBlocked) {
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
          durabilityBlocked: true,
        };
      }
      // Manual-only recovery may have completed; fall through to listFired.
    }
  }
  // On read failure: do not mutate stock, do not acknowledge, remain retryable.
  let events: AutoDeductionEvent[] = [];
  let listOk = true;
  try {
    const listed = await listFired();
    listOk = listed.ok !== false;
    events = listed.events ?? [];
    if (!listOk) {
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
          nativeListFailed: true,
          nativeListError: listed.error,
        } as RunReconciliationOutput;
    }
  } catch (e) {
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
      nativeListFailed: true,
      nativeListError: e instanceof Error ? e.message : 'list_fired_failed',
    } as RunReconciliationOutput;
  }

  if (!events.length) {
    if (nativeStockChanged) {
      // Native is the Android authority; persist only the JS mirror here.
      // This is not a stock mutation and must not create a new mutationSeq.
      const mirrorPersistError = persist(STORAGE_MEDS_KEY, baseMeds, { json: true });
      if (mirrorPersistError) {
        console.warn(
          '[App] Native Auto stock converged but JS stock mirror persist failed:',
          mirrorPersistError
        );
      }
    }
    return {
      medications: baseMeds,
      logs: baseLogs,
      toAcknowledge: [],
      details: [],
      mutated: nativeStockChanged,
      newExactLogs: [],
      markedCount: 0,
      recoveredEnvelope: false,
      partialNativeAck: false,
    };
  }

  // Every FIRED occurrence is repaired/verified against the Native stock
  // authority before JS creates its log/history evidence. This also repairs
  // occurrences created before Native stock execution was introduced.
  const repairedEvents: AutoDeductionEvent[] = [];
  for (const event of events) {
    const med = baseMeds.find((m) => m.id === event.medicationId);
    if (!med) {
      // Keep the existing missing-med terminalization policy; there is no
      // current stock to mutate for a deleted medication.
      repairedEvents.push(event);
      continue;
    }

    const stockResult = await applyAutoDeductionStock(
      event.medicationId,
      event.doseId,
      event.calendarDate,
      event.amount
    );
    if (!stockResult.ok) {
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
        durabilityBlocked: true,
        nativeStockSyncFailed: true,
        nativeStockSyncError: stockResult.error,
      };
    }
    repairedEvents.push({
      ...event,
      nativeStockApplied: stockResult.native,
      ...(stockResult.native
        ? { actualDeducted: stockResult.actualDeducted }
        : {}),
    });
  }

  const postRepairConvergence = await convergeAutoDeductionStock(baseMeds);
  if (!postRepairConvergence.ok) {
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
      durabilityBlocked: true,
      nativeStockSyncFailed: true,
      nativeStockSyncError: postRepairConvergence.error,
    };
  }
  baseMeds = postRepairConvergence.medications;

  // Recovery may have durably changed the global master switch while the
  // original `fresh` snapshot is now stale. Re-read it after envelope recovery
  // and before creating/committing any new Exact-Auto mutation envelope.
  const durableGlobalAutoDeductEnabled = loadDurableGlobalAutoDeductEnabled();

  const result = reconcileFiredEvents(baseMeds, baseLogs, repairedEvents, {
    globalAutoDeductEnabled: durableGlobalAutoDeductEnabled,
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
      durabilityBlocked: true,
    };
  }
  const mutationSeq = alloc.seq;
  const envelope: ExactAutoEnvelope = {
    version: 1,
    status: 'js_ready',
    medications: result.medications,
    logs: result.logs,
    globalAutoDeductEnabled: durableGlobalAutoDeductEnabled,
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
      durabilityBlocked: true,
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
        globalAutoDeductEnabled: durableGlobalAutoDeductEnabled,
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
      durabilityBlocked: true,
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


