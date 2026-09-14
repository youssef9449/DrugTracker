/**
 * Phase 3 orchestrator — durable envelope + persist + native mark.
 *
 * localStorage meds/logs are separate keys (not a true DB transaction).
 * Protocol:
 *   1. Recover any incomplete envelope from prior crash
 *   2. Reconcile FIRED events in memory
 *   3. Persist envelope (meds + logs + acks) as single JSON record
 *   4. Write meds key, then logs key from envelope
 *   5. Mark native RECONCILED for acks
 *   6. Clear envelope
 *
 * Recovery: envelope present → rewrite meds/logs from envelope (idempotent
 * via deterministic log ids + markers), mark native, clear envelope.
 * Never mark RECONCILED without envelope or equivalent durable JS state.
 */

import type { ConsumptionLog, Medication } from '../types';
import {
  listFiredAutoDeductionEvents,
  markAutoDeductionEventReconciled,
  type AutoDeductionEvent,
} from './autoDeductionNative';
import {
  reconcileFiredEvents,
  type ReconcileFiredResult,
  findExactAutoLog,
  exactAutoLogId,
} from './autoDeductionReconciliation';
import { withAutoStockMutationGate } from './autoDeductionStockGate';
import { loadJson, persist } from './storage';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
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
  medications: Medication[];
  logs: ConsumptionLog[];
  globalAutoDeductEnabled: boolean;
  listFired?: () => Promise<AutoDeductionEvent[]>;
  markReconciled?: (medicationId: string, doseId: string, calendarDate: string) => Promise<void>;
  persistMeds?: (meds: Medication[]) => string | null;
  persistLogs?: (logs: ConsumptionLog[]) => string | null;
  loadEnvelope?: () => ExactAutoEnvelope | null;
  saveEnvelope?: (env: ExactAutoEnvelope | null) => string | null;
  now?: Date;
}

export interface RunReconciliationOutput extends ReconcileFiredResult {
  markedCount: number;
  recoveredEnvelope: boolean;
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
  return withAutoStockMutationGate(() => runOnce(input));
}

async function finishEnvelope(
  env: ExactAutoEnvelope,
  mark: (medicationId: string, doseId: string, calendarDate: string) => Promise<void>,
  persistMeds: (meds: Medication[]) => string | null,
  persistLogs: (logs: ConsumptionLog[]) => string | null,
  saveEnvelope: (env: ExactAutoEnvelope | null) => string | null
): Promise<{ markedCount: number; ok: boolean }> {
  const medErr = persistMeds(env.medications);
  const logErr = persistLogs(env.logs);
  if (medErr || logErr) {
    return { markedCount: 0, ok: false };
  }

  let markedCount = 0;
  for (const ack of env.toAcknowledge) {
    try {
      await mark(ack.medicationId, ack.doseId, ack.calendarDate);
      markedCount += 1;
    } catch {
      /* leave FIRED; markers/logs durable */
    }
  }

  saveEnvelope(null);
  return { markedCount, ok: true };
}

async function runOnce(input: RunReconciliationInput): Promise<RunReconciliationOutput> {
  const listFired = input.listFired ?? listFiredAutoDeductionEvents;
  const mark =
    input.markReconciled ??
    (async (medicationId: string, doseId: string, calendarDate: string) => {
      await markAutoDeductionEventReconciled(medicationId, doseId, calendarDate);
    });
  const persistMeds =
    input.persistMeds ??
    ((meds: Medication[]) => persist(STORAGE_MEDS_KEY, meds, { json: true }));
  const persistLogs =
    input.persistLogs ??
    ((logs: ConsumptionLog[]) => persist(STORAGE_LOGS_KEY, logs, { json: true }));
  const loadEnvelope = input.loadEnvelope ?? defaultLoadEnvelope;
  const saveEnvelope = input.saveEnvelope ?? defaultSaveEnvelope;

  // ── Recover incomplete envelope from prior crash ──
  const existing = loadEnvelope();
  if (existing) {
    const fin = await finishEnvelope(existing, mark, persistMeds, persistLogs, saveEnvelope);
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
      markedCount: fin.markedCount,
      recoveredEnvelope: true,
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
      medications: input.medications,
      logs: input.logs,
      toAcknowledge: [],
      details: [],
      mutated: false,
      newExactLogs: [],
      markedCount: 0,
      recoveredEnvelope: false,
    };
  }

  const result = reconcileFiredEvents(input.medications, input.logs, events, {
    globalAutoDeductEnabled: input.globalAutoDeductEnabled,
    now: input.now,
  });

  if (!result.mutated && result.toAcknowledge.length === 0) {
    return { ...result, markedCount: 0, recoveredEnvelope: false };
  }

  // Acknowledge-only (no stock mutation): still mark native; no envelope needed
  // because JS state already durable (markers / lastSync).
  if (!result.mutated) {
    let markedCount = 0;
    for (const ack of result.toAcknowledge) {
      try {
        await mark(ack.medicationId, ack.doseId, ack.calendarDate);
        markedCount += 1;
      } catch {
        /* retry later */
      }
    }
    return { ...result, markedCount, recoveredEnvelope: false };
  }

  // Mutating path: write envelope first, then meds/logs, then mark.
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
      medications: input.medications,
      logs: input.logs,
      toAcknowledge: [],
      details: result.details,
      mutated: false,
      newExactLogs: [],
      markedCount: 0,
      recoveredEnvelope: false,
    };
  }

  const fin = await finishEnvelope(envelope, mark, persistMeds, persistLogs, saveEnvelope);
  if (!fin.ok) {
    // Envelope remains for recovery; do not report mutated to React until durable
    // meds+logs both written — but envelope holds the intended state.
    // Surface intended state so caller can setState if meds write partially succeeded
    // is complex; keep prior React state and let recovery on next run complete.
    return {
      medications: input.medications,
      logs: input.logs,
      toAcknowledge: result.toAcknowledge,
      details: result.details,
      mutated: false,
      newExactLogs: result.newExactLogs,
      markedCount: 0,
      recoveredEnvelope: false,
    };
  }

  return {
    ...result,
    markedCount: fin.markedCount,
    recoveredEnvelope: false,
  };
}

/** Test helper: merge logs without duplicating exact-auto ids. */
export function mergeLogsIdempotent(
  existing: ConsumptionLog[],
  incoming: ConsumptionLog[]
): ConsumptionLog[] {
  const ids = new Set(existing.map((l) => l.id));
  const out = [...existing];
  for (const l of incoming) {
    if (ids.has(l.id)) continue;
    ids.add(l.id);
    out.unshift(l);
  }
  return out;
}

export { exactAutoLogId, findExactAutoLog };
