/**
 * Shared recovery for pending Manual / Exact Auto stock envelopes.
 *
 * Causal rule: envelopes store full post-mutation snapshots. When several are
 * pending above lastAppliedMutationSeq, recover the highest seq first; lower
 * Earlier sequence values become irrelevant once lastApplied advances past them.
 *
 * lastAppliedMutationSeq is required finalization proof — not best-effort.
 * Log IDs are only used to avoid duplicate log insertion, not as sole proof
 * that a full medication snapshot is newest.
 */

import type { ConsumptionLog, Medication } from '../types';
import {
  commitDurableAutoStockState,
  type AutoStockDurableState,
} from './autoDeductionStockGate';
import {
  loadLastAppliedMutationSeq,
  persistLastAppliedMutationSeq,
} from './stockMutationOrdering';
import { persist, readJsonOutcome, type StorageJsonOutcome } from './storage';
import { applyForegroundAutoStockDeltas } from './autoDeductionNativeStock';

export const STORAGE_MANUAL_ENVELOPE_KEY =
  'android_med_tracker_manual_stock_envelope_v1';

/** Shared Exact Auto envelope key. */
export const STORAGE_EXACT_AUTO_ENVELOPE_KEY =
  'android_med_tracker_exact_auto_envelope_v1';

export interface ExactAutoEnvelopeStored {
  version: 1;
  status: 'js_ready';
  medications: Medication[];
  logs: ConsumptionLog[];
  /** Durable global master switch captured with the current envelope. */
  globalAutoDeductEnabled: boolean;
  toAcknowledge: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }>;
  createdAt: string;
  /** Required causal order with Manual envelopes. mutationSeq is required. */
  mutationSeq: number;
}

function isValidExactAutoEnvelope(
  raw: ExactAutoEnvelopeStored | null | undefined
): raw is ExactAutoEnvelopeStored {
  if (!raw || raw.version !== 1 || raw.status !== 'js_ready') return false;
  if (!Array.isArray(raw.medications) || !Array.isArray(raw.logs)) return false;
  if (!Array.isArray(raw.toAcknowledge)) return false;
  if (typeof raw.createdAt !== 'string' || raw.createdAt.length === 0) return false;
  // mutationSeq is required and must be a finite positive number.
  // Invalid or missing mutationSeq is rejected (no fallback).
  if (
    typeof raw.mutationSeq !== 'number' ||
    !Number.isFinite(raw.mutationSeq) ||
    raw.mutationSeq <= 0
  ) {
    return false;
  }
  if (typeof raw.globalAutoDeductEnabled !== 'boolean') return false;
  return true;
}

/**
 * Outcome-aware Exact Auto envelope read. Distinguishes a legitimately empty
 * store (`missing`) from a present-but-unusable payload (`invalid`) so
 * recovery never treats corruption as "nothing pending".
 */
export function readExactAutoStockEnvelopeOutcome(): StorageJsonOutcome<ExactAutoEnvelopeStored> {
  return readJsonOutcome(STORAGE_EXACT_AUTO_ENVELOPE_KEY, (raw) =>
    isValidExactAutoEnvelope(raw as ExactAutoEnvelopeStored | null | undefined)
      ? (raw as ExactAutoEnvelopeStored)
      : null
  );
}

export function loadExactAutoStockEnvelope(): ExactAutoEnvelopeStored | null {
  const outcome = readExactAutoStockEnvelopeOutcome();
  return outcome.status === 'ok' ? outcome.value : null;
}

export function saveExactAutoStockEnvelope(
  env: ExactAutoEnvelopeStored | null
): string | null {
  if (env == null) {
    if (typeof localStorage === 'undefined') return null;
    try {
      localStorage.removeItem(STORAGE_EXACT_AUTO_ENVELOPE_KEY);
      return null;
    } catch {
      return 'envelope_clear_failed';
    }
  }
  return persist(STORAGE_EXACT_AUTO_ENVELOPE_KEY, env, { json: true });
}

export interface ManualStockEnvelope {
  version: 1;
  status: 'manual_js_ready';
  medications: Medication[];
  logs: ConsumptionLog[];
  /** Durable global master switch captured with the current envelope. */
  globalAutoDeductEnabled: boolean;
  createdAt: string;
  baseGeneration: number;
  mutationSeq: number;
  /** Native Auto-owned stock deltas applied with this foreground mutation. */
  stockDeltas?: Array<{ medicationId: string; delta: number }>;
  /** Manual Take/Restore occurrence resolutions committed atomically in Native. */
  occurrenceResolutions?: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
    type: 'CONSUMED' | 'SKIPPED';
  }>;
}

export interface PendingEnvelopeRef {
  kind: 'manual' | 'exact_auto';
  mutationSeq: number;
  medications: Medication[];
  logs: ConsumptionLog[];
  /** Durable global master switch captured with the current snapshot. */
  globalAutoDeductEnabled: boolean;
  /** Exact Auto only — native ACK ownership stays with Exact Auto path. */
  toAcknowledge?: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }>;
  /** Manual only — durable foreground stock deltas, replayed idempotently in Native. */
  stockDeltas?: Array<{ medicationId: string; delta: number }>;
  /** Manual only — occurrence resolutions committed atomically in Native. */
  occurrenceResolutions?: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
    type: 'CONSUMED' | 'SKIPPED';
  }>;
  clear: () => string | null;
}

/** Outcome-aware Manual envelope read (missing vs invalid distinction). */
export function readManualStockEnvelopeOutcome(): StorageJsonOutcome<ManualStockEnvelope> {
  return readJsonOutcome(STORAGE_MANUAL_ENVELOPE_KEY, (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as Partial<ManualStockEnvelope>;
    if (
      candidate.version !== 1 ||
      candidate.status !== 'manual_js_ready' ||
      !Array.isArray(candidate.medications) ||
      !Array.isArray(candidate.logs) ||
      !Array.isArray(candidate.stockDeltas) ||
      !Array.isArray(candidate.occurrenceResolutions) ||
      typeof candidate.globalAutoDeductEnabled !== 'boolean' ||
      typeof candidate.mutationSeq !== 'number' ||
      !Number.isFinite(candidate.mutationSeq) ||
      candidate.mutationSeq <= 0 ||
      typeof candidate.createdAt !== 'string' ||
      candidate.createdAt.length === 0 ||
      typeof candidate.baseGeneration !== 'number'
    ) {
      return null;
    }
    return raw as ManualStockEnvelope;
  });
}

export function loadManualStockEnvelope(): ManualStockEnvelope | null {
  const outcome = readManualStockEnvelopeOutcome();
  return outcome.status === 'ok' ? outcome.value : null;
}

export function saveManualStockEnvelope(
  env: ManualStockEnvelope | null
): string | null {
  if (env == null) {
    if (typeof localStorage === 'undefined') return null;
    try {
      localStorage.removeItem(STORAGE_MANUAL_ENVELOPE_KEY);
      return null;
    } catch {
      return 'envelope_clear_failed';
    }
  }
  return persist(STORAGE_MANUAL_ENVELOPE_KEY, env, { json: true });
}

/**
 * Finalize lastApplied for seq. Idempotent: seq <= lastApplied is success.
 */
export function finalizeMutationSeq(mutationSeq: number): string | null {
  if (!(mutationSeq > 0)) return null;
  const last = loadLastAppliedMutationSeq();
  if (mutationSeq <= last) return null;
  return persistLastAppliedMutationSeq(mutationSeq);
}

/**
 * Prove the durable medication + log snapshot is FULLY equivalent to the
 * envelope's persisted snapshot. This is the sole "mutation is durable"
 * proof used to decide finalize + clear vs. re-apply.
 *
 * Contract:
 * - medications: same count, same order, every field deep-equal (id, name,
 *   currentPills, dailyDose, unit, warningThresholdDays, colorTag,
 *   category, notes, createdAt, lastConsumedDate,
 *   autoDeductEnabled, packageSize, stripsPerBox, pillsPerStrip,
 *   targetOrderQuantity, reminderEnabled, reminderTime, dosesPerDay,
 *   doseConsumptionHistory (record + per-dose array order-aware),
 *   doseSkippedHistory (record + per-dose array order-aware)).
 * - logs: same count, same order, every field deep-equal (id, medicationId,
 *   medicationName, type, amount, date, timestamp, description, reversedAt,
 *   relatedLogId, doseId).
 *
 * Log IDs alone are NEVER sufficient proof — two logs with the same ID but
 * different amount/date/doseId must NOT count as matched. The comparison is
 * order-aware for every array because the persisted snapshot is an ordered
 * array (localStorage stores it verbatim); a reordered-but-equal-content
 * array is a different persisted snapshot and must trigger re-apply.
 */
export function durableMatchesEnvelopeSnapshot(
  envelope: {
    medications: Medication[];
    logs: ConsumptionLog[];
    globalAutoDeductEnabled: boolean;
  },
  durable: AutoStockDurableState
): boolean {
  if (envelope.globalAutoDeductEnabled !== durable.globalAutoDeductEnabled) {
    return false;
  }
  // Medications: same count, order-aware deep equality per index.
  if (envelope.medications.length !== durable.medications.length) return false;
  for (let i = 0; i < envelope.medications.length; i++) {
    if (!deepEqual(envelope.medications[i], durable.medications[i])) return false;
  }
  // Logs: same count, order-aware deep equality per index.
  if (envelope.logs.length !== durable.logs.length) return false;
  for (let i = 0; i < envelope.logs.length; i++) {
    if (!deepEqual(envelope.logs[i], durable.logs[i])) return false;
  }
  return true;
}

/**
 * Recursive deep equality for persisted snapshot values.
 * - primitives: strict ===.
 * - arrays: same length, order-aware element-wise deep equality.
 * - objects: same key set (by count) + deep-equal values for every key.
 * - null/undefined: only equal to null/undefined (NOT to 0 / '' / false).
 *
 * Intentionally does NOT treat 0 / '' / false as equal to null/undefined,
 * because a persisted field with an empty-string value is a real snapshot
 * difference from a missing field.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // null/undefined: treat null === undefined (both mean "absent" in JSON).
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], (b as unknown[])[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!(k in bo)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

export interface UnifiedRecoveryResult {
  state: AutoStockDurableState;
  /** Exact Auto toAcknowledge lists from recovered exact envelopes (for ACK). */
  exactToAcknowledge: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }>;
  recovered: boolean;
  /** True when the pending stock snapshot is not durably finalized; new mutations must stop. */
  durabilityBlocked: boolean;
  /** True when recovery is incomplete, including best-effort envelope cleanup failure. */
  blocked: boolean;
}

/**
 * Recover all pending stock envelopes using mutationSeq causal order.
 * Highest seq above lastApplied is applied/finalized first; lower pending
 * envelopes are cleared only after lastApplied covers them. Manual envelopes
 * also carry the signed Native stock delta that must be applied idempotently
 * before the JS snapshot is finalized.
 */
export async function recoverAllPendingStockEnvelopes(
  fresh: AutoStockDurableState,
  pending: PendingEnvelopeRef[],
  commit: (
    state: AutoStockDurableState,
    appliedMutationSeq: number
  ) => string | null,
  applyNativeStockDeltas: (
    mutationSeq: number,
    deltas: Array<{ medicationId: string; delta: number }>,
    occurrenceResolutions: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
      type: 'CONSUMED' | 'SKIPPED';
    }>
  ) => Promise<{
    ok: boolean;
    error?: string;
    stocks?: Array<{ medicationId: string; currentPills: number }>;
  }> = applyForegroundAutoStockDeltas
): Promise<UnifiedRecoveryResult> {
  let state = fresh;
  let recovered = false;
  let durabilityBlocked = false;
  let blocked = false;
  const exactToAcknowledge: UnifiedRecoveryResult['exactToAcknowledge'] = [];
  const ackSeen = new Set<string>();

  const collectExactAcks = (
    acks: PendingEnvelopeRef['toAcknowledge'] | undefined
  ): void => {
    if (!acks?.length) return;
    for (const a of acks) {
      const key = `${a.medicationId}${a.doseId}${a.calendarDate}`;
      if (ackSeen.has(key)) continue;
      ackSeen.add(key);
      exactToAcknowledge.push(a);
    }
  };

  /**
   * Attempt envelope clear. On failure: keep evidence, do not re-apply snapshot
   * when mutation is already finalized; do not treat as fully recovered clear.
   */
  const tryClear = (env: PendingEnvelopeRef): boolean => {
    const err = env.clear();
    if (err) {
      blocked = true;
      return false;
    }
    return true;
  };

  if (!pending.length) {
    return {
      state,
      exactToAcknowledge,
      recovered: false,
      durabilityBlocked: false,
      blocked: false,
    };
  }

  let lastApplied = loadLastAppliedMutationSeq();

  // Cleanup: envelopes already covered by lastApplied — collect Exact Auto ACKs
  // before clear so native markReconciled is not lost with the envelope.
  for (const env of pending) {
    if (env.mutationSeq > 0 && env.mutationSeq <= lastApplied) {
      if (env.kind === 'exact_auto') {
        collectExactAcks(env.toAcknowledge);
      }
      if (tryClear(env)) {
        recovered = true;
      }
      // clear failure: leave envelope; lastApplied proves mutation done — no re-apply
    }
  }

  // Pending above lastApplied: process highest seq first (full snapshot).
  const above = pending
    .filter((e) => e.mutationSeq > lastApplied)
    .sort((a, b) => b.mutationSeq - a.mutationSeq);

  for (const env of above) {
    lastApplied = loadLastAppliedMutationSeq();
    if (env.mutationSeq <= lastApplied) {
      if (env.kind === 'exact_auto') {
        collectExactAcks(env.toAcknowledge);
      }
      if (tryClear(env)) {
        recovered = true;
      }
      continue;
    }

    const higherStillPending = above.some(
      (h) =>
        h.mutationSeq > env.mutationSeq &&
        h.mutationSeq > loadLastAppliedMutationSeq()
    );
    if (higherStillPending) {
      continue;
    }

    let envelopeMedications = env.medications;

    if (env.kind === 'manual') {
      const nativeResult = await applyNativeStockDeltas(
        env.mutationSeq,
        env.stockDeltas ?? [],
        env.occurrenceResolutions ?? []
      );
      if (!nativeResult.ok) {
        durabilityBlocked = true;
        blocked = true;
        break;
      }

      // The Native result is newer than the JS snapshot stored in the envelope.
      // Merge currentPills from Native before deciding whether the JS snapshot is
      // already durable; never restore a stale absolute balance over a background
      // Auto deduction that happened after the envelope was created.
      if (nativeResult.stocks && nativeResult.stocks.length > 0) {
        const nativeById = new Map(
          nativeResult.stocks.map((stock) => [
            stock.medicationId,
            Number(stock.currentPills),
          ])
        );
        envelopeMedications = env.medications.map((medication) => {
          const nativePills = nativeById.get(medication.id);
          return nativePills != null &&
              Number.isFinite(nativePills) &&
              nativePills >= 0
            ? { ...medication, currentPills: nativePills }
            : medication;
        });
      }
    }

    const envelopeForComparison = {
      ...env,
      medications: envelopeMedications,
    };

    if (durableMatchesEnvelopeSnapshot(envelopeForComparison, state)) {
      const finErr = finalizeMutationSeq(env.mutationSeq);
      if (finErr) {
        durabilityBlocked = true;
        blocked = true;
        break;
      }
      if (env.kind === 'exact_auto') {
        collectExactAcks(env.toAcknowledge);
      }
      if (tryClear(env)) {
        recovered = true;
      }
      lastApplied = loadLastAppliedMutationSeq();
      continue;
    }

    const err = commit(
      {
        medications: envelopeMedications,
        logs: env.logs,
        globalAutoDeductEnabled: env.globalAutoDeductEnabled,
      },
      env.mutationSeq
    );
    if (err) {
      durabilityBlocked = true;
      blocked = true;
      break;
    }
    state = {
      medications: envelopeMedications,
      logs: env.logs,
      globalAutoDeductEnabled: env.globalAutoDeductEnabled,
    };
    if (env.kind === 'exact_auto') {
      collectExactAcks(env.toAcknowledge);
    }
    if (tryClear(env)) {
      recovered = true;
    }
    // clear failure after successful commit+finalize: mutation is durable;
    // next recovery sees seq <= lastApplied and retries clear only.
    lastApplied = loadLastAppliedMutationSeq();
  }

  // Final cleanup for any remaining covered envelopes.
  lastApplied = loadLastAppliedMutationSeq();
  for (const env of pending) {
    if (env.mutationSeq > 0 && env.mutationSeq <= lastApplied) {
      if (env.kind === 'exact_auto') {
        collectExactAcks(env.toAcknowledge);
      }
      if (tryClear(env)) {
        recovered = true;
      }
    }
  }

  return {
    state,
    exactToAcknowledge,
    recovered,
    durabilityBlocked,
    blocked,
  };
}

/**
 * Manual-only recovery at Manual gate entry (no Exact Auto envelope in scope).
 * Pass otherPending when Exact Auto envelope is known to the caller.
 */
/**
 * Unified recovery at Manual gate entry: pending Manual AND Exact Auto
 * envelopes share mutationSeq ordering. Exact Auto toAcknowledge is collected
 * but NOT natively ACKed here — callers that own reconciliation may ACK.
 */
export async function recoverManualEnvelopeInto(
  fresh: AutoStockDurableState,
  opts?: {
    persistMeds?: (meds: Medication[]) => string | null;
    persistLogs?: (logs: ConsumptionLog[]) => string | null;
  }
): Promise<{
  ok: true;
  state: AutoStockDurableState;
  exactToAcknowledge: UnifiedRecoveryResult['exactToAcknowledge'];
} | {
  ok: false;
  state: AutoStockDurableState;
  exactToAcknowledge: UnifiedRecoveryResult['exactToAcknowledge'];
}> {
  const pending: PendingEnvelopeRef[] = [];
  // Fail closed on unusable envelope evidence: a present-but-invalid envelope
  // is NOT "nothing pending". Recovery must not proceed as if the mutation
  // never happened — the raw payload stays on disk for diagnosis and the
  // caller is told recovery failed so new mutations stop.
  const manualOutcome = readManualStockEnvelopeOutcome();
  if (manualOutcome.status === 'invalid' || manualOutcome.status === 'read_failed') {
    console.warn(
      `[stock-recovery] manual stock envelope unusable (${manualOutcome.status}: ${manualOutcome.status === 'missing' ? '' : manualOutcome.reason}); blocking mutations until repaired.`
    );
    return { ok: false, state: fresh, exactToAcknowledge: [] };
  }
  const exactOutcome = readExactAutoStockEnvelopeOutcome();
  if (exactOutcome.status === 'invalid' || exactOutcome.status === 'read_failed') {
    console.warn(
      `[stock-recovery] exact-auto stock envelope unusable (${exactOutcome.status}: ${exactOutcome.status === 'missing' ? '' : exactOutcome.reason}); blocking mutations until repaired.`
    );
    return { ok: false, state: fresh, exactToAcknowledge: [] };
  }
  const manual = manualOutcome.status === 'ok' ? manualOutcome.value : null;
  if (manual) {
    pending.push({
      kind: 'manual',
      mutationSeq: manual.mutationSeq,
      medications: manual.medications,
      logs: manual.logs,
      globalAutoDeductEnabled: manual.globalAutoDeductEnabled,
      stockDeltas: manual.stockDeltas ?? [],
      occurrenceResolutions: manual.occurrenceResolutions ?? [],
      clear: () => saveManualStockEnvelope(null),
    });
  }
  // Only current envelopes with mutationSeq are valid.
  const exact = exactOutcome.status === 'ok' ? exactOutcome.value : null;
  if (exact) {
    pending.push({
      kind: 'exact_auto',
      mutationSeq: exact.mutationSeq,
      medications: exact.medications,
      logs: exact.logs,
      globalAutoDeductEnabled: exact.globalAutoDeductEnabled,
      toAcknowledge: exact.toAcknowledge,
      stockDeltas: [],
      occurrenceResolutions: [],
      clear: () => saveExactAutoStockEnvelope(null),
    });
  }

  if (!pending.length) {
    return {
      ok: true,
      state: fresh,
      exactToAcknowledge: [],
    };
  }

  const commit = (
    state: AutoStockDurableState,
    appliedMutationSeq: number
  ): string | null => {
    if (opts?.persistMeds && opts?.persistLogs) {
      const medErr = opts.persistMeds(state.medications);
      if (medErr) return medErr;
      const logErr = opts.persistLogs(state.logs);
      if (logErr) return logErr;
      return finalizeMutationSeq(appliedMutationSeq);
    }
    return commitDurableAutoStockState(state, { appliedMutationSeq });
  };

  const result = await recoverAllPendingStockEnvelopes(fresh, pending, commit);
  if (result.blocked) {
    return {
      ok: false,
      state: result.recovered ? result.state : fresh,
      exactToAcknowledge: result.exactToAcknowledge,
    };
  }
  return {
    ok: true,
    state: result.state,
    exactToAcknowledge: result.exactToAcknowledge,
  };
}


