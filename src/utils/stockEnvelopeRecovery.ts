/**
 * Shared recovery for pending Manual / Exact Auto stock envelopes.
 * Orders by mutationSeq; never lets an older envelope overwrite newer durable
 * state (including when lastApplied lagged after a successful pair write).
 */

import type { ConsumptionLog, Medication } from '../types';
import {
  commitDurableAutoStockState,
  type AutoStockDurableState,
} from './autoDeductionStockGate';
import {
  classifyEnvelopeBySeq,
  envelopeLogIdsPresentInDurable,
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

export interface PendingEnvelopeRef {
  mutationSeq: number;
  logs: ConsumptionLog[];
  medications: Medication[];
}

/**
 * True when a higher-seq pending envelope is already reflected in durable logs.
 * Older envelopes must not overwrite in that case (lastApplied may still lag).
 */
export function isSupersededByHigherPending(
  env: PendingEnvelopeRef,
  durable: AutoStockDurableState,
  allPending: PendingEnvelopeRef[]
): boolean {
  return allPending.some(
    (other) =>
      other.mutationSeq > env.mutationSeq &&
      envelopeLogIdsPresentInDurable(other.logs, durable.logs)
  );
}

/**
 * Finalize lastApplied for seq then allow envelope clear.
 * Returns error if lastApplied cannot be persisted — caller must keep envelope.
 */
export function finalizeMutationSeq(mutationSeq: number): string | null {
  if (!(mutationSeq > 0)) return null;
  const last = loadLastAppliedMutationSeq();
  if (mutationSeq <= last) return null;
  return persistLastAppliedMutationSeq(mutationSeq);
}

export type ResolveAction = 'apply' | 'already_applied' | 'superseded';

export function resolveEnvelopeAction(
  env: PendingEnvelopeRef,
  durable: AutoStockDurableState,
  allPending: PendingEnvelopeRef[]
): ResolveAction {
  const last = loadLastAppliedMutationSeq();
  if (
    env.mutationSeq > 0 &&
    classifyEnvelopeBySeq(env.mutationSeq, last) === 'already_applied'
  ) {
    return 'already_applied';
  }
  if (isSupersededByHigherPending(env, durable, allPending)) {
    return 'superseded';
  }
  if (envelopeLogIdsPresentInDurable(env.logs, durable.logs)) {
    return 'already_applied';
  }
  return 'apply';
}

/**
 * Recover Manual envelope only (Manual gate entry).
 * Never markReconciled.
 */
export function recoverManualEnvelopeInto(
  fresh: AutoStockDurableState,
  opts?: {
    persistMeds?: (meds: Medication[]) => string | null;
    persistLogs?: (logs: ConsumptionLog[]) => string | null;
    /** Other pending envelopes (e.g. Exact Auto) for supersession checks. */
    otherPending?: PendingEnvelopeRef[];
  }
): { ok: true; state: AutoStockDurableState } | { ok: false; state: AutoStockDurableState } {
  const existing = loadManualStockEnvelope();
  if (!existing) {
    return { ok: true, state: fresh };
  }

  const self: PendingEnvelopeRef = {
    mutationSeq: existing.mutationSeq,
    logs: existing.logs,
    medications: existing.medications,
  };
  const allPending = [self, ...(opts?.otherPending ?? [])];
  const action = resolveEnvelopeAction(self, fresh, allPending);

  if (action === 'already_applied' || action === 'superseded') {
    const finErr = finalizeMutationSeq(existing.mutationSeq);
    if (finErr && action === 'already_applied') {
      // Keep envelope until lastApplied is durable.
      return { ok: false, state: fresh };
    }
    // superseded: clear without forcing lastApplied to older seq
    if (action === 'superseded') {
      saveManualStockEnvelope(null);
      return { ok: true, state: fresh };
    }
    if (finErr) {
      return { ok: false, state: fresh };
    }
    saveManualStockEnvelope(null);
    return { ok: true, state: fresh };
  }

  const pair: AutoStockDurableState = {
    medications: existing.medications,
    logs: existing.logs,
  };

  let err: string | null;
  if (opts?.persistMeds && opts?.persistLogs) {
    const medErr = opts.persistMeds(pair.medications);
    if (medErr) err = medErr;
    else {
      const logErr = opts.persistLogs(pair.logs);
      err = logErr;
      if (!err) {
        err = finalizeMutationSeq(existing.mutationSeq);
      }
    }
  } else {
    err = commitDurableAutoStockState(pair, {
      appliedMutationSeq: existing.mutationSeq,
    });
  }

  if (err) {
    return { ok: false, state: fresh };
  }
  saveManualStockEnvelope(null);
  return { ok: true, state: pair };
}

export interface ExactAutoEnvelopeLike {
  medications: Medication[];
  logs: ConsumptionLog[];
  mutationSeq?: number;
  toAcknowledge: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }>;
}

export function recoverExactAutoEnvelopeState(
  existing: ExactAutoEnvelopeLike,
  fresh: AutoStockDurableState,
  commit: (state: AutoStockDurableState) => string | null,
  otherPending?: PendingEnvelopeRef[]
): {
  action: 'apply' | 'already_applied' | 'write_failed' | 'superseded';
  state: AutoStockDurableState;
  finalizeFailed?: boolean;
} {
  const seq = existing.mutationSeq ?? 0;
  const self: PendingEnvelopeRef = {
    mutationSeq: seq,
    logs: existing.logs,
    medications: existing.medications,
  };
  const allPending = [self, ...(otherPending ?? [])];
  const action = resolveEnvelopeAction(self, fresh, allPending);

  if (action === 'already_applied' || action === 'superseded') {
    if (action === 'already_applied') {
      const finErr = finalizeMutationSeq(seq);
      if (finErr) {
        return { action: 'write_failed', state: fresh, finalizeFailed: true };
      }
    }
    return { action, state: fresh };
  }

  const pair = {
    medications: existing.medications,
    logs: existing.logs,
  };
  const err = commit(pair);
  if (err) {
    return { action: 'write_failed', state: fresh };
  }
  return { action: 'apply', state: pair };
}
