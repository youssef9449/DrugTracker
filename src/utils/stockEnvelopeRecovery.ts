/**
 * Shared recovery for pending Manual / Exact Auto stock envelopes.
 * Orders by mutationSeq so older snapshots never overwrite newer durable state.
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
  /** Shared causal order with Exact Auto envelopes. */
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

/**
 * Decide whether a pending envelope should be applied to durable state.
 * Primary: mutationSeq vs lastAppliedMutationSeq.
 * Secondary: if seq looks pending but log ids already durable, treat as applied
 * (pair write succeeded, lastApplied/finalization lagged).
 */
export function resolveEnvelopeAction(
  mutationSeq: number | undefined,
  envelopeLogs: ConsumptionLog[],
  durable: AutoStockDurableState
): 'apply' | 'already_applied' {
  const seq =
    typeof mutationSeq === 'number' && mutationSeq > 0 ? mutationSeq : 0;
  const last = loadLastAppliedMutationSeq();
  if (seq > 0 && classifyEnvelopeBySeq(seq, last) === 'already_applied') {
    return 'already_applied';
  }
  if (envelopeLogIdsPresentInDurable(envelopeLogs, durable.logs)) {
    return 'already_applied';
  }
  // seq 0 (legacy envelope without seq): apply only if logs not present
  return 'apply';
}

export function markEnvelopeApplied(mutationSeq: number | undefined): void {
  if (typeof mutationSeq === 'number' && mutationSeq > 0) {
    const last = loadLastAppliedMutationSeq();
    if (mutationSeq > last) {
      persistLastAppliedMutationSeq(mutationSeq);
    }
  }
}

/**
 * Recover Manual envelope only (used at Manual gate entry).
 * Never markReconciled / never touches Exact Auto ACK.
 */
export function recoverManualEnvelopeInto(
  fresh: AutoStockDurableState,
  opts?: {
    persistMeds?: (meds: Medication[]) => string | null;
    persistLogs?: (logs: ConsumptionLog[]) => string | null;
  }
): { ok: true; state: AutoStockDurableState } | { ok: false; state: AutoStockDurableState } {
  const existing = loadManualStockEnvelope();
  if (!existing) {
    return { ok: true, state: fresh };
  }

  const action = resolveEnvelopeAction(
    existing.mutationSeq,
    existing.logs,
    fresh
  );
  if (action === 'already_applied') {
    markEnvelopeApplied(existing.mutationSeq);
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
    }
  } else {
    err = commitDurableAutoStockState(pair, {
      appliedMutationSeq: existing.mutationSeq,
    });
  }

  if (err) {
    return { ok: false, state: fresh };
  }
  markEnvelopeApplied(existing.mutationSeq);
  saveManualStockEnvelope(null);
  return { ok: true, state: pair };
}

/**
 * Apply Exact Auto envelope snapshot if pending and not superseded.
 * Returns durable state and whether JS was recovered. Caller owns native ACK.
 */
export function recoverExactAutoEnvelopeState(
  existing: ExactAutoEnvelopeLike,
  fresh: AutoStockDurableState,
  commit: (state: AutoStockDurableState) => string | null
): {
  action: 'apply' | 'already_applied' | 'write_failed';
  state: AutoStockDurableState;
} {
  const action = resolveEnvelopeAction(
    existing.mutationSeq,
    existing.logs,
    fresh
  );
  if (action === 'already_applied') {
    markEnvelopeApplied(existing.mutationSeq);
    return { action: 'already_applied', state: fresh };
  }
  const pair = {
    medications: existing.medications,
    logs: existing.logs,
  };
  const err = commit(pair);
  if (err) {
    return { action: 'write_failed', state: fresh };
  }
  markEnvelopeApplied(existing.mutationSeq);
  return { action: 'apply', state: pair };
}
