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

function defaultLoadEnvelope(): ExactAutoEnvelope | null {
  const raw = loadJson<ExactAutoEnvelope | null>(STORAGE_ENVELOPE_KEY, null);
  if (!raw || raw.version !== 1 || raw.status !== 'js_ready') return null;
  if (!Array.isArray(raw.medications) || !Array.isArray(raw.logs)) return null;
  return raw;
}

function defaultSaveEnvelope(env: ExactAutoEnvelope | null): string | null {
  if (env == null) {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_ENVELOPE_KEY);
      } catch {
        /* ignore */
      }
    }
    return null;
  }
  return persist(STORAGE_ENVELOPE_KEY, env, { json: true });
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
  const baseMeds = input.medications ?? fresh.medications;
  const baseLogs = input.logs ?? fresh.logs;

  // ── Envelope recovery (incomplete prior crash before meds/logs settle) ──
  const existing = loadEnvelope();
  if (existing) {
    let writeFailed = false;
    if (input.persistMeds || input.persistLogs) {
      const medErr = input.persistMeds ? input.persistMeds(existing.medications) : null;
      const logErr = input.persistLogs ? input.persistLogs(existing.logs) : null;
      writeFailed = !!(medErr || logErr);
    } else {
      writeFailed = !!commitDurableAutoStockState({
        medications: existing.medications,
        logs: existing.logs,
      });
    }
    if (writeFailed) {
      // JS persistence/recovery failed — no native markReconciled was attempted.
      // partialNativeAck must only reflect actual native acknowledgement failure.
      return {
        medications: baseMeds,
        logs: baseLogs,
        toAcknowledge: existing.toAcknowledge,
        details: [],
        mutated: false,
        newExactLogs: [],
        markedCount: 0,
        recoveredEnvelope: true,
        partialNativeAck: false,
      };
    }
    const { markedCount, failed } = await markAll(existing.toAcknowledge, mark);
    // Option B: JS state durable → clear envelope; remaining FIRED recoverable
    saveEnvelope(null);
    return {
      medications: existing.medications,
      logs: existing.logs,
      toAcknowledge: existing.toAcknowledge,
      details: existing.toAcknowledge.map((a) => ({
        medicationId: a.medicationId,
        doseId: a.doseId,
        calendarDate: a.calendarDate,
        amount: 0,
        outcome: 'already_applied' as const,
        occurrenceKey: `${a.medicationId}\u001f${a.doseId}\u001f${a.calendarDate}`,
      })),
      mutated: true,
      newExactLogs: [],
      markedCount,
      recoveredEnvelope: true,
      partialNativeAck: failed.length > 0,
    };
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
  const envelope: ExactAutoEnvelope = {
    version: 1,
    status: 'js_ready',
    medications: result.medications,
    logs: result.logs,
    toAcknowledge: result.toAcknowledge,
    createdAt: new Date().toISOString(),
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
    const err = commitDurableAutoStockState({
      medications: result.medications,
      logs: result.logs,
    });
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
