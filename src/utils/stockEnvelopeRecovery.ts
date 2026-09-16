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


export interface ManualStockEnvelope {
  version: 1;
  status: 'manual_js_ready';
  medications: Medication[];
  logs: ConsumptionLog[];
  createdAt: string;
  baseGeneration: number;
  mutationSeq: number;
}

export interface PendingEnvelopeRef {
  kind: 'manual' | 'exact_auto';
  mutationSeq: number;
  medications: Medication[];
  logs: ConsumptionLog[];
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
 * Full meds+logs equality for "snapshot already on durable" without using
 * log-id presence alone as ordering proof.
 */
/**
 * Prove the durable medication snapshot is fully equivalent to the envelope.
 * Log IDs are checked separately for presence (idempotent log set) and are
 * NOT a substitute for complete medication snapshot equality.
 */
export function durableMatchesEnvelopeSnapshot(
  envelope: { medications: Medication[]; logs: ConsumptionLog[] },
  durable: AutoStockDurableState
): boolean {
  // Complete medication array: same length, every envelope med has exact match.
  if (envelope.medications.length !== durable.medications.length) return false;
  const byId = new Map(durable.medications.map((m) => [m.id, m]));
  if (byId.size !== durable.medications.length) return false; // duplicate ids

  for (const em of envelope.medications) {
    const d = byId.get(em.id);
    if (!d) return false;
    if (d.currentPills !== em.currentPills) return false;
    if (d.lastConsumedDate !== em.lastConsumedDate) return false;
    if (d.lastSyncDate !== em.lastSyncDate) return false;
    if (!doseMapEqual(em.doseConsumption, d.doseConsumption)) return false;
    if (!doseHistoryEqual(em.doseConsumptionHistory, d.doseConsumptionHistory)) {
      return false;
    }
    if (!doseHistoryEqual(em.doseSkippedHistory, d.doseSkippedHistory)) {
      return false;
    }
  }

  // Logs: same set of ids (order-independent) for complete log snapshot.
  if (envelope.logs.length !== durable.logs.length) return false;
  const envLogIds = new Set(envelope.logs.map((l) => l.id).filter(Boolean));
  const durLogIds = new Set(durable.logs.map((l) => l.id).filter(Boolean));
  if (envLogIds.size !== envelope.logs.length) return false;
  if (durLogIds.size !== durable.logs.length) return false;
  for (const id of envLogIds) {
    if (!durLogIds.has(id)) return false;
  }
  return true;
}

function doseMapEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): boolean {
  const aa = a ?? {};
  const bb = b ?? {};
  const keys = new Set([...Object.keys(aa), ...Object.keys(bb)]);
  for (const k of keys) {
    if (aa[k] !== bb[k]) return false;
  }
  return true;
}

function doseHistoryEqual(
  a: Record<string, string[]> | undefined,
  b: Record<string, string[]> | undefined
): boolean {
  const aa = a ?? {};
  const bb = b ?? {};
  const keys = new Set([...Object.keys(aa), ...Object.keys(bb)]);
  for (const k of keys) {
    const av = [...(aa[k] ?? [])].sort();
    const bv = [...(bb[k] ?? [])].sort();
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) {
      if (av[i] !== bv[i]) return false;
    }
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
      { medications: env.medications, logs: env.logs },
      env.mutationSeq
    );
    if (err) {
      blocked = true;
      break;
    }
    state = { medications: env.medications, logs: env.logs };
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
      clear: () => saveManualStockEnvelope(null),
    });
  }
  const exact = loadExactAutoStockEnvelope();
  if (exact) {
    pending.push({
      kind: 'exact_auto',
      mutationSeq: exact.mutationSeq ?? 0,
      medications: exact.medications,
      logs: exact.logs,
      toAcknowledge: exact.toAcknowledge,
      clear: () => saveExactAutoStockEnvelope(null),
    });
  }

  if (!pending.length) {
    return { ok: true, state: fresh, exactToAcknowledge: [] };
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

  const result = recoverAllPendingStockEnvelopes(fresh, pending, commit);
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

/** @deprecated Prefer recoverAllPendingStockEnvelopes — kept for typed Exact Auto callers. */
export function recoverExactAutoEnvelopeState(
  existing: {
    medications: Medication[];
    logs: ConsumptionLog[];
    mutationSeq?: number;
    toAcknowledge: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }>;
  },
  fresh: AutoStockDurableState,
  commit: (state: AutoStockDurableState) => string | null,
  otherPending?: Array<{
    mutationSeq: number;
    logs: ConsumptionLog[];
    medications: Medication[];
  }>
): {
  action: 'apply' | 'already_applied' | 'write_failed' | 'superseded';
  state: AutoStockDurableState;
  finalizeFailed?: boolean;
} {
  const pending: PendingEnvelopeRef[] = [
    {
      kind: 'exact_auto',
      mutationSeq: existing.mutationSeq ?? 0,
      medications: existing.medications,
      logs: existing.logs,
      toAcknowledge: existing.toAcknowledge,
      clear: () => null,
    },
    ...(otherPending ?? []).map((o) => ({
      kind: 'manual' as const,
      mutationSeq: o.mutationSeq,
      medications: o.medications,
      logs: o.logs,
      clear: () => null,
    })),
  ];
  const result = recoverAllPendingStockEnvelopes(
    fresh,
    pending,
    (state, seq) => {
      const err = commit(state);
      if (err) return err;
      return finalizeMutationSeq(seq);
    }
  );
  if (result.blocked) {
    return { action: 'write_failed', state: fresh, finalizeFailed: true };
  }
  if (!result.recovered) {
    return { action: 'already_applied', state: result.state };
  }
  return { action: 'apply', state: result.state };
}
