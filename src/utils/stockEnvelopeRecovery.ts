/**
 * Shared recovery for pending Manual / Exact Auto stock envelopes.
 *
 * Causal rule: envelopes store full post-mutation snapshots. When several are
 * pending above lastAppliedMutationSeq, recover the highest seq first; lower
 * seqs become obsolete once lastApplied advances past them.
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
import { loadJson, persist } from './storage';
import { applyForegroundAutoStockDeltas } from './autoDeductionNative';

export const STORAGE_MANUAL_ENVELOPE_KEY =
  'android_med_tracker_manual_stock_envelope_v1';

/** Same key as Phase 3 Exact Auto envelope (shared recovery). */
export const STORAGE_EXACT_AUTO_ENVELOPE_KEY =
  'android_med_tracker_exact_auto_envelope_v1';

export interface ExactAutoEnvelopeStored {
  version: 1;
  status: 'js_ready';
  medications: Medication[];
  logs: ConsumptionLog[];
  /** Phase 4 durable global master switch (required on current envelopes). */
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

let testLoadExact: (() => ExactAutoEnvelopeStored | null) | null = null;
let testSaveExact: ((env: ExactAutoEnvelopeStored | null) => string | null) | null =
  null;

/** @internal test-only */
export function __setExactAutoEnvelopeStorageTestHooks(hooks: {
  load?: () => ExactAutoEnvelopeStored | null;
  save?: (env: ExactAutoEnvelopeStored | null) => string | null;
} | null): void {
  testLoadExact = hooks?.load ?? null;
  testSaveExact = hooks?.save ?? null;
}

function isValidPhase4ExactEnvelope(
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

export function loadExactAutoStockEnvelope(): ExactAutoEnvelopeStored | null {
  const raw = testLoadExact
    ? testLoadExact()
    : loadJson<ExactAutoEnvelopeStored | null>(STORAGE_EXACT_AUTO_ENVELOPE_KEY, null);
  if (!isValidPhase4ExactEnvelope(raw)) return null;
  return raw;
}

export function saveExactAutoStockEnvelope(
  env: ExactAutoEnvelopeStored | null
): string | null {
  if (testSaveExact) return testSaveExact(env);
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
  /** Phase 4 durable global master switch. */
  globalAutoDeductEnabled?: boolean;
  createdAt: string;
  baseGeneration: number;
  mutationSeq: number;
  /** Native Auto-owned stock deltas applied with this foreground mutation. */
  stockDeltas: Array<{ medicationId: string; delta: number }>;
}

export interface PendingEnvelopeRef {
  kind: 'manual' | 'exact_auto';
  mutationSeq: number;
  medications: Medication[];
  logs: ConsumptionLog[];
  /** Durable global master switch captured with Phase 4 snapshots. */
  globalAutoDeductEnabled?: boolean;
  /** Exact Auto only — native ACK ownership stays with Exact Auto path. */
  toAcknowledge?: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }>;
  /** Manual only — durable foreground stock deltas, replayed idempotently in Native. */
  stockDeltas?: Array<{ medicationId: string; delta: number }>;
  clear: () => string | null;
}

let testLoadManual: (() => ManualStockEnvelope | null) | null = null;
let testSaveManual: ((env: ManualStockEnvelope | null) => string | null) | null =
  null;

/** @internal test-only */
export function __setManualEnvelopeTestHooks(hooks: {
  load?: () => ManualStockEnvelope | null;
  save?: (env: ManualStockEnvelope | null) => string | null;
} | null): void {
  testLoadManual = hooks?.load ?? null;
  testSaveManual = hooks?.save ?? null;
}

export function loadManualStockEnvelope(): ManualStockEnvelope | null {
  if (testLoadManual) return testLoadManual();
  const raw = loadJson<ManualStockEnvelope | null>(
    STORAGE_MANUAL_ENVELOPE_KEY,
    null
  );
  if (!raw || raw.version !== 1 || raw.status !== 'manual_js_ready') return null;
  if (!Array.isArray(raw.medications) || !Array.isArray(raw.logs)) return null;
  return raw;
}

export function saveManualStockEnvelope(
  env: ManualStockEnvelope | null
): string | null {
  if (testSaveManual) return testSaveManual(env);
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
    globalAutoDeductEnabled?: boolean;
  },
  durable: AutoStockDurableState
): boolean {
  // Global master switch is part of Phase 4 durable snapshots. If absent,
  // only the medication/log snapshot is compared.
  if (
    envelope.globalAutoDeductEnabled !== undefined &&
    durable.globalAutoDeductEnabled !== undefined &&
    envelope.globalAutoDeductEnabled !== durable.globalAutoDeductEnabled
  ) {
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
 * envelopes are cleared only after lastApplied covers them.
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
    deltas: Array<{ medicationId: string; delta: number }>
  ) => Promise<{ ok: boolean; error?: string }> = applyForegroundAutoStockDeltas
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

    if (env.kind === 'manual') {
      const nativeResult = await applyNativeStockDeltas(
        env.mutationSeq,
        env.stockDeltas ?? []
      );
      if (!nativeResult.ok) {
        durabilityBlocked = true;
        blocked = true;
        break;
      }
    }

    if (durableMatchesEnvelopeSnapshot(env, state)) {
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
        medications: env.medications,
        logs: env.logs,
        globalAutoDeductEnabled:
          env.globalAutoDeductEnabled ?? state.globalAutoDeductEnabled,
      },
      env.mutationSeq
    );
    if (err) {
      durabilityBlocked = true;
      blocked = true;
      break;
    }
    state = {
      medications: env.medications,
      logs: env.logs,
      globalAutoDeductEnabled:
        env.globalAutoDeductEnabled ?? state.globalAutoDeductEnabled,
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
): {
  ok: true;
  state: AutoStockDurableState;
  exactToAcknowledge: UnifiedRecoveryResult['exactToAcknowledge'];
} | {
  ok: false;
  state: AutoStockDurableState;
  exactToAcknowledge: UnifiedRecoveryResult['exactToAcknowledge'];
} {
  const pending: PendingEnvelopeRef[] = [];
  const manual = loadManualStockEnvelope();
  if (manual) {
    pending.push({
      kind: 'manual',
      mutationSeq: manual.mutationSeq,
      medications: manual.medications,
      logs: manual.logs,
      globalAutoDeductEnabled: manual.globalAutoDeductEnabled,
      stockDeltas: manual.stockDeltas ?? [],
      clear: () => saveManualStockEnvelope(null),
    });
  }
  // Only current Phase 4 envelopes (with mutationSeq) are valid.
  const exact = loadExactAutoStockEnvelope();
  if (exact) {
    pending.push({
      kind: 'exact_auto',
      mutationSeq: exact.mutationSeq,
      medications: exact.medications,
      logs: exact.logs,
      globalAutoDeductEnabled: exact.globalAutoDeductEnabled,
      toAcknowledge: exact.toAcknowledge,
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


