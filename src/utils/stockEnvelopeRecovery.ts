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
  envelopeLogIdsPresentInDurable,
} from './stockMutationOrdering';
import { loadJson, persist } from './storage';

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
  /** Phase 4 durable global master switch; absent only on pre-fix envelopes. */
  globalAutoDeductEnabled?: boolean;
  toAcknowledge: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }>;
  createdAt: string;
  mutationSeq?: number;
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

export function loadExactAutoStockEnvelope(): ExactAutoEnvelopeStored | null {
  if (testLoadExact) return testLoadExact();
  const raw = loadJson<ExactAutoEnvelopeStored | null>(
    STORAGE_EXACT_AUTO_ENVELOPE_KEY,
    null
  );
  if (!raw || raw.version !== 1 || raw.status !== 'js_ready') return null;
  if (!Array.isArray(raw.medications) || !Array.isArray(raw.logs)) return null;
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

/**
 * Migrate a legacy Exact Auto envelope (Phase 3 js_ready envelope persisted
 * WITHOUT a mutationSeq) through a recovery barrier that runs BEFORE any new
 * Phase 4 mutation is allowed to allocate a sequence.
 *
 * Why a barrier (not a fresh seq allocation):
 *   The previous design called allocateMutationSeq() to give the legacy
 *   envelope a new sequence. That is WRONG — the envelope is chronologically
 *   OLDER than existing Phase 4 mutations (e.g. a Manual Take that already
 *   took seq=10). Allocating seq=11 for the legacy envelope makes it look
 *   NEWER than the Manual mutation, so unified recovery would apply the
 *   legacy (older) snapshot ON TOP of the newer Manual mutation —
 *   overwriting newer state with older state and breaking the meaning of
 *   mutationSeq as a causal order.
 *
 * Barrier contract (no new mutationSeq is ever allocated for a legacy
 * envelope):
 * 1. load fresh durable state + the pending Exact Auto envelope.
 * 2. if the envelope is absent OR already carries a positive mutationSeq
 *    (Phase 4), it is NOT legacy — leave it for unified recovery.
 * 3. legacy envelope (no mutationSeq):
 *    a. if durableMatchesEnvelopeSnapshot(legacy, durable) → the legacy
 *       mutation is already reflected in durable (Phase 3 wrote meds+logs
 *       before the crash). Collect toAcknowledge, clear the envelope, then
 *       ACK. Do NOT re-apply (would be a no-op or a regression).
 *    b. else if the legacy envelope's log IDs are present in durable.logs →
 *       the legacy mutation WAS applied but a newer Phase 4 mutation later
 *       superseded it. Collect toAcknowledge, clear the envelope, ACK. Do
 *       NOT re-apply (would overwrite the newer mutation).
 *    c. else (legacy mutation was never applied to durable):
 *       - if lastAppliedMutationSeq === 0 → no Phase 4 mutation exists yet →
 *         the legacy snapshot is the newest known state → apply it to
 *         durable (commit meds+logs), then clear + ACK.
 *       - if lastAppliedMutationSeq > 0 → a newer Phase 4 mutation exists →
 *         DO NOT apply the legacy snapshot (would overwrite). Clear the
 *         envelope and let the normal Exact Auto reconciliation
 *         (reconcileFiredEvents, driven by native FIRED events) re-drive
 *         the mutation with a proper Phase 4 mutationSeq on top of the
 *         current durable state. Do NOT ACK here (the mutation is not yet
 *         durable; the normal path ACKs after re-applying).
 * 4. on clear failure (or commit failure in 3c): return blocked=true so
 *    the caller blocks new Phase 4 mutations and keeps the envelope as
 *    recovery evidence. The envelope is never erased on failure.
 * 5. idempotent: a restart after a partial migration re-enters the barrier.
 *    If the envelope was cleared → no-op. If the snapshot was applied but
 *    clear failed → snapshot now matches → clear + ACK (no re-apply, no
 *    duplicate deduction, no duplicate ACK — native markReconciled is
 *    itself idempotent).
 *
 * Timestamps (createdAt / Date.now) are NEVER used for ordering. Log IDs
 * are used only as ONE signal (alongside the full snapshot comparison) that
 * a legacy mutation was applied — never as sole proof.
 */
export function migrateLegacyExactAutoEnvelope(
  fresh: AutoStockDurableState,
  load: () => ExactAutoEnvelopeStored | null,
  save: (env: ExactAutoEnvelopeStored | null) => string | null,
  commit: (state: AutoStockDurableState) => string | null
): {
  state: AutoStockDurableState;
  toAcknowledge: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }>;
  recovered: boolean;
  blocked: boolean;
} {
  const existing = load();
  if (!existing) {
    return { state: fresh, toAcknowledge: [], recovered: false, blocked: false };
  }
  // Phase 4 envelope (has mutationSeq) — not legacy. Leave for unified recovery.
  if (typeof existing.mutationSeq === 'number' && existing.mutationSeq > 0) {
    return { state: fresh, toAcknowledge: [], recovered: false, blocked: false };
  }

  const acks = Array.isArray(existing.toAcknowledge) ? existing.toAcknowledge : [];

  // 3a: full snapshot already on durable → already applied & current.
  if (durableMatchesEnvelopeSnapshot(existing, fresh)) {
    const clearErr = save(null);
    if (clearErr) {
      // Recovery was attempted (envelope present, snapshot matched). Clear
      // failed → keep envelope for retry. ACK happens on restart when the
      // barrier re-confirms snapshot match + clear succeeds (NOT immediately
      // — lastApplied is not used for legacy, so snapshot match is the only
      // durability proof, and it requires a successful clear to finalize).
      return { state: fresh, toAcknowledge: [], recovered: true, blocked: true };
    }
    return { state: fresh, toAcknowledge: acks, recovered: true, blocked: false };
  }

  // 3b: legacy log IDs present in durable → legacy was applied, then a
  // newer Phase 4 mutation superseded it. ACK + clear. Do NOT re-apply.
  //
  // Write-ordering proof (why log-ID presence cannot mean "logs without the
  // medication snapshot"): every commit path that can have produced these
  // logs — legacyCommit here, the reconcile-side legacyCommit, and
  // commitDurableAutoStockState — writes medications FIRST, then logs
  // (lastApplied last), and each key write is all-or-nothing. Durable log
  // IDs therefore imply the logs write of that commit landed, which only
  // happens AFTER the same commit's medications write succeeded — so
  // durable medications are the envelope's snapshot or something newer
  // (a later mutation that kept the cumulative logs). Not re-applying is
  // correct in both cases. The barrier also runs before any new Phase 4
  // mutation can allocate a sequence, so no interleaving can produce a
  // logs-present/medications-never-written state.
  const legacyLogsPresent = envelopeLogIdsPresentInDurable(existing.logs, fresh.logs);
  if (legacyLogsPresent) {
    const clearErr = save(null);
    if (clearErr) {
      return { state: fresh, toAcknowledge: [], recovered: true, blocked: true };
    }
    return { state: fresh, toAcknowledge: acks, recovered: true, blocked: false };
  }

  // 3c: legacy mutation was never applied to durable.
  const lastApplied = loadLastAppliedMutationSeq();
  if (lastApplied === 0) {
    // No Phase 4 mutation exists yet → legacy snapshot is newest → apply it.
    const commitErr = commit({
      medications: existing.medications,
      logs: existing.logs,
    });
    if (commitErr) {
      // Recovery was attempted (envelope present). Persist failed → mutation
      // NOT durable → no ACK. recovered=true means recovery was attempted.
      return { state: fresh, toAcknowledge: [], recovered: true, blocked: true };
    }
    const applied: AutoStockDurableState = {
      medications: existing.medications,
      logs: existing.logs,
    };
    const clearErr = save(null);
    if (clearErr) {
      // Snapshot applied (meds+logs durable) but envelope clear failed → keep
      // envelope; next restart sees snapshot matches → clear + ACK. No ACK now
      // (clear not durable; ACK deferred to restart confirmation).
      return { state: applied, toAcknowledge: [], recovered: true, blocked: true };
    }
    return { state: applied, toAcknowledge: acks, recovered: true, blocked: false };
  }

  // lastApplied > 0 → a newer Phase 4 mutation exists. DO NOT apply the
  // legacy snapshot (would overwrite the newer mutation). Clear the
  // envelope and let reconcileFiredEvents re-drive via native FIRED events
  // with a proper Phase 4 mutationSeq. No ACK (mutation not durable here).
  const clearErr = save(null);
  if (clearErr) {
    return { state: fresh, toAcknowledge: [], recovered: true, blocked: true };
  }
  return { state: fresh, toAcknowledge: [], recovered: true, blocked: false };
}


export interface ManualStockEnvelope {
  version: 1;
  status: 'manual_js_ready';
  medications: Medication[];
  logs: ConsumptionLog[];
  /** Phase 4 durable global master switch; absent only on pre-fix envelopes. */
  globalAutoDeductEnabled?: boolean;
  createdAt: string;
  baseGeneration: number;
  mutationSeq: number;
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
 *   category, notes, createdAt, lastSyncDate, lastConsumedDate,
 *   autoDeductEnabled, packageSize, stripsPerBox, pillsPerStrip,
 *   targetOrderQuantity, reminderEnabled, reminderTime, dosesPerDay,
 *   doseSchedule (array order-aware), doseConsumption (record),
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
  // Global master switch is part of Phase 4 durable snapshots. Legacy envelopes
  // may omit it; in that case only the medication/log snapshot is compared.
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
  /** True when a write/finalization failed and evidence was kept. */
  blocked: boolean;
}

/**
 * Recover all pending stock envelopes using mutationSeq causal order.
 * Highest seq above lastApplied is applied/finalized first; lower pending
 * envelopes are cleared only after lastApplied covers them.
 */
export function recoverAllPendingStockEnvelopes(
  fresh: AutoStockDurableState,
  pending: PendingEnvelopeRef[],
  commit: (
    state: AutoStockDurableState,
    appliedMutationSeq: number
  ) => string | null
): UnifiedRecoveryResult {
  let state = fresh;
  let recovered = false;
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
    return { state, exactToAcknowledge, recovered: false, blocked: false };
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

    if (durableMatchesEnvelopeSnapshot(env, state)) {
      const finErr = finalizeMutationSeq(env.mutationSeq);
      if (finErr) {
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

  return { state, exactToAcknowledge, recovered, blocked };
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
export function recoverManualEnvelopeInto(
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
      clear: () => saveManualStockEnvelope(null),
    });
  }
  // Legacy Exact Auto envelope barrier: run BEFORE unified recovery (and
  // before any new Phase 4 mutation allocates a mutationSeq). The barrier
  // never allocates a new seq for a legacy envelope — that would make an
  // old envelope look newer than existing Phase 4 mutations and break
  // causal ordering. Instead it confirms the legacy mutation is durable
  // (full snapshot match OR legacy log IDs present) → clear + ACK; or, if
  // never applied and no newer mutation exists, applies the snapshot; or,
  // if a newer mutation exists, clears and lets reconcileFiredEvents re-drive.
  const legacyCommit = (state: AutoStockDurableState): string | null => {
    if (opts?.persistMeds && opts?.persistLogs) {
      const medErr = opts.persistMeds(state.medications);
      if (medErr) return medErr;
      const logErr = opts.persistLogs(state.logs);
      if (logErr) return logErr;
      return null;
    }
    return commitDurableAutoStockState(state);
  };
  const legacy = migrateLegacyExactAutoEnvelope(
    fresh,
    loadExactAutoStockEnvelope,
    saveExactAutoStockEnvelope,
    legacyCommit
  );
  if (legacy.blocked) {
    return {
      ok: false,
      state: legacy.state,
      exactToAcknowledge: [],
    };
  }
  // After the barrier, reload fresh state so unified recovery sees the
  // post-migration durable state (the barrier may have applied the legacy
  // snapshot or cleared the envelope).
  const barrierState = legacy.state;
  // Collect ACKs from the barrier (native ACK happens via the caller's
  // acknowledgeExactAutoEvents path, same as unified recovery acks).
  const legacyAcks = legacy.toAcknowledge;

  // After the barrier, only Phase 4 envelopes (with mutationSeq) can
  // remain. The legacy envelope was cleared by the barrier (or left for
  // blocked retry). Reload to confirm.
  const exact = loadExactAutoStockEnvelope();
  if (exact) {
    pending.push({
      kind: 'exact_auto',
      mutationSeq: exact.mutationSeq ?? 0,
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
      state: barrierState,
      exactToAcknowledge: legacyAcks,
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

  const result = recoverAllPendingStockEnvelopes(barrierState, pending, commit);
  if (result.blocked) {
    // Merge barrier acks + unified acks so the caller still ACKs everything
    // that became durable even when a later step blocked.
    const mergedAcks = mergeAcks(legacyAcks, result.exactToAcknowledge);
    return {
      ok: false,
      state: result.recovered ? result.state : barrierState,
      exactToAcknowledge: mergedAcks,
    };
  }
  const mergedAcks = mergeAcks(legacyAcks, result.exactToAcknowledge);
  return {
    ok: true,
    state: result.state,
    exactToAcknowledge: mergedAcks,
  };
}

/** Deduplicate ACKs by medicationId+doseId+calendarDate, preserving order. */
function mergeAcks(
  a: UnifiedRecoveryResult['exactToAcknowledge'],
  b: UnifiedRecoveryResult['exactToAcknowledge']
): UnifiedRecoveryResult['exactToAcknowledge'] {
  const out: UnifiedRecoveryResult['exactToAcknowledge'] = [];
  const seen = new Set<string>();
  for (const ack of [...a, ...b]) {
    const key = `${ack.medicationId}|${ack.doseId}|${ack.calendarDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ack);
  }
  return out;
}

