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
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_MANUAL_ENVELOPE_KEY);
      } catch {
        /* ignore */
      }
    }
    return null;
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
export function durableMatchesEnvelopeSnapshot(
  envelope: { medications: Medication[]; logs: ConsumptionLog[] },
  durable: AutoStockDurableState
): boolean {
  if (envelope.logs.length !== durable.logs.length) return false;
  const durLogIds = new Set(durable.logs.map((l) => l.id).filter(Boolean));
  if (!envelope.logs.every((l) => l.id && durLogIds.has(l.id))) return false;

  const byId = new Map(durable.medications.map((m) => [m.id, m]));
  if (envelope.medications.length !== durable.medications.length) {
    // Allow durable to have same meds by id even if array length differs
  }
  return envelope.medications.every((em) => {
    const d = byId.get(em.id);
    return d != null && d.currentPills === em.currentPills;
  });
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
export function recoverManualEnvelopeInto(
  fresh: AutoStockDurableState,
  opts?: {
    persistMeds?: (meds: Medication[]) => string | null;
    persistLogs?: (logs: ConsumptionLog[]) => string | null;
    otherPending?: Array<{
      mutationSeq: number;
      logs: ConsumptionLog[];
      medications: Medication[];
    }>;
  }
): { ok: true; state: AutoStockDurableState } | { ok: false; state: AutoStockDurableState } {
  const existing = loadManualStockEnvelope();
  if (!existing) {
    return { ok: true, state: fresh };
  }

  const pending: PendingEnvelopeRef[] = [
    {
      kind: 'manual',
      mutationSeq: existing.mutationSeq,
      medications: existing.medications,
      logs: existing.logs,
      clear: () => saveManualStockEnvelope(null),
    },
  ];
  for (const o of opts?.otherPending ?? []) {
    pending.push({
      kind: 'exact_auto',
      mutationSeq: o.mutationSeq,
      medications: o.medications,
      logs: o.logs,
      clear: () => null, // caller owns Exact Auto clear
    });
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
    return { ok: false, state: fresh };
  }
  return { ok: true, state: result.state };
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
