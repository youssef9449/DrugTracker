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
  migrateLegacyExactAutoEnvelope,
  finalizeMutationSeq,
  type PendingEnvelopeRef,
  type ExactAutoEnvelopeStored,
} from './stockEnvelopeRecovery';
import { allocateMutationSeq } from './stockMutationOrdering';

export interface ExactAutoEnvelope {
  version: 1;
  status: 'js_ready';
  medications: Medication[];
  logs: ConsumptionLog[];
  /** Phase 4 durable global master switch; absent only on pre-fix envelopes. */
  globalAutoDeductEnabled?: boolean;
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
  listFired?: () => Promise<ListFiredEventsResult | AutoDeductionEvent[]>;
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
        clear: () => saveManualStockEnvelope(null),
      });
    }
    // Legacy Exact Auto envelope barrier: run BEFORE unified recovery (and
    // before any new Phase 4 mutation allocates a mutationSeq). The barrier
    // NEVER allocates a new seq for a legacy envelope — that would make an
    // old envelope look newer than existing Phase 4 mutations and break
    // causal ordering. Instead it confirms the legacy mutation is durable
    // (full snapshot match OR legacy log IDs present) → clear + ACK; or, if
    // never applied and no newer mutation exists, applies the snapshot; or,
    // if a newer mutation exists, clears and lets reconcileFiredEvents
    // (below) re-drive via native FIRED events with a proper Phase 4 seq.
    const legacyCommit = (state: AutoStockDurableState): string | null => {
      if (input.persistMeds || input.persistLogs) {
        const medErr = input.persistMeds
          ? input.persistMeds(state.medications)
          : null;
        const logErr = input.persistLogs ? input.persistLogs(state.logs) : null;
        if (medErr || logErr) return medErr || logErr || 'persist_failed';
        return null;
      }
      return commitDurableAutoStockState(state);
    };
    const legacy = migrateLegacyExactAutoEnvelope(
      { medications: baseMeds, logs: baseLogs },
      loadEnvelope as () => ExactAutoEnvelopeStored | null,
      saveEnvelope as (env: ExactAutoEnvelopeStored | null) => string | null,
      legacyCommit
    );
    if (legacy.blocked) {
      // Recovery was attempted (envelope was present). Two sub-cases:
      // - Persist failure: mutation NOT durable → no acks (toAcknowledge=[]).
      // - Clear failure after durable commit: mutation IS durable → acks are
      //   safe to send (toAcknowledge collected by the barrier).
      const blockedAcks = legacy.toAcknowledge;
      if (blockedAcks.length > 0) {
        const { markedCount, failed } = await markAll(blockedAcks, mark);
        return {
          medications: legacy.state.medications,
          logs: legacy.state.logs,
          toAcknowledge: blockedAcks,
          details: blockedAcks.map((a) => ({
            medicationId: a.medicationId,
            doseId: a.doseId,
            calendarDate: a.calendarDate,
            amount: 0,
            outcome: 'already_applied' as const,
            occurrenceKey: `${a.medicationId}${a.doseId}${a.calendarDate}`,
          })),
          mutated: legacy.recovered,
          newExactLogs: [],
          markedCount,
          recoveredEnvelope: legacy.recovered,
          partialNativeAck: failed.length > 0,
          durabilityBlocked: legacy.durabilityBlocked,
        };
      }
      return {
        medications: legacy.state.medications,
        logs: legacy.state.logs,
        toAcknowledge: [],
        details: [],
        mutated: legacy.recovered,
        newExactLogs: [],
        markedCount: 0,
        recoveredEnvelope: legacy.recovered,
        partialNativeAck: false,
      };
    }
    // After the barrier, reload fresh state (the barrier may have applied
    // the legacy snapshot or cleared the envelope).
    baseMeds = legacy.state.medications;
    baseLogs = legacy.state.logs;
    const legacyAcks = legacy.toAcknowledge;

    // After the barrier, only Phase 4 envelopes (with mutationSeq) remain.
    const existingExact = loadEnvelope();
    if (existingExact) {
      pending.push({
        kind: 'exact_auto',
        mutationSeq: existingExact.mutationSeq ?? 0,
        medications: existingExact.medications,
        logs: existingExact.logs,
        globalAutoDeductEnabled: existingExact.globalAutoDeductEnabled,
        toAcknowledge: existingExact.toAcknowledge,
        clear: () => saveEnvelope(null),
      });
    }

    if (pending.length > 0 || legacyAcks.length > 0) {
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

      // Merge barrier acks + unified acks (deduplicated by occurrence key).
      const allAcks = mergeAckLists(legacyAcks, unified.exactToAcknowledge);

      if (allAcks.length > 0) {
        const { markedCount, failed } = await markAll(allAcks, mark);
        return {
          medications: baseMeds,
          logs: baseLogs,
          toAcknowledge: allAcks,
          details: allAcks.map((a) => ({
            medicationId: a.medicationId,
            doseId: a.doseId,
            calendarDate: a.calendarDate,
            amount: 0,
            outcome: 'already_applied' as const,
            occurrenceKey: `${a.medicationId}${a.doseId}${a.calendarDate}`,
          })),
          mutated: unified.recovered || legacy.recovered,
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

  // Explicit native-read result: failure must NOT look like empty events.
  // On read failure: do not mutate stock, do not acknowledge, remain retryable.
  let events: AutoDeductionEvent[] = [];
  let listOk = true;
  try {
    const listed = await listFired();
    if (Array.isArray(listed)) {
      // Legacy test injects that still return AutoDeductionEvent[]
      events = listed;
    } else {
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

  // Recovery may have durably changed the global master switch while the
  // original `fresh` snapshot is now stale. Re-read it after envelope recovery
  // and before creating/committing any new Exact-Auto mutation envelope.
  const durableGlobalAutoDeductEnabled = loadDurableGlobalAutoDeductEnabled();

  const result = reconcileFiredEvents(baseMeds, baseLogs, events, {
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

/** Deduplicate ACKs by medicationId+doseId+calendarDate, preserving order. */
function mergeAckLists(
  a: Array<{ medicationId: string; doseId: string; calendarDate: string }>,
  b: Array<{ medicationId: string; doseId: string; calendarDate: string }>
): Array<{ medicationId: string; doseId: string; calendarDate: string }> {
  const out: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }> = [];
  const seen = new Set<string>();
  for (const ack of [...a, ...b]) {
    const key = `${ack.medicationId}|${ack.doseId}|${ack.calendarDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ack);
  }
  return out;
}
