/**
 * Single-process mutex for auto-stock mutations (exact auto-deduction +
 * Manual Take/Restore). Serializes async work so two reconciliations never
 * interleave durable reads/writes.
 *
 * Cross-document correctness is provided by the Web Locks API. The in-memory
 * Promise chain remains the fast same-document queue; the Web Lock surrounds
 * the complete durable mutation so two same-origin tabs cannot both commit
 * from the same stale snapshot.
 */

import type { ConsumptionLog, Medication } from '../types';
import {
  isValidConsumptionLogRecord,
  isValidMedicationRecord,
  loadString,
  persist,
  readJsonOutcome,
} from './storage';
import { persistLastAppliedMutationSeq } from './stockMutationOrdering';

export const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
export const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
export const STORAGE_GLOBAL_AUTO_DEDUCT_KEY = 'android_med_tracker_auto_deduct_v1';
export const STORAGE_STOCK_GEN_KEY = 'android_med_tracker_stock_generation_v1';

export interface AutoStockDurableState {
  medications: Medication[];
  logs: ConsumptionLog[];
  globalAutoDeductEnabled?: boolean;
}

const STOCK_MUTATION_LOCK = 'drugtracker:durable-stock-mutation';
let chain: Promise<unknown> = Promise.resolve();

async function withCrossDocumentStockLock<T>(fn: () => T | Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined') return fn();
  const locks = navigator.locks;
  if (!locks?.request) {
    // Vitest/Node-style non-secure test runtimes have no browser lock manager.
    // Production browser contexts are fail-closed so unsupported browsers cannot
    // silently reintroduce the lost-update race.
    if (typeof window !== 'undefined' && window.isSecureContext !== true) {
      return fn();
    }
    throw new Error('cross_tab_stock_lock_unavailable');
  }
  return locks.request(STOCK_MUTATION_LOCK, { mode: 'exclusive' }, fn);
}

export function loadStockGeneration(): number {
  const raw = loadString(STORAGE_STOCK_GEN_KEY, '0');
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function bumpStockGeneration(): string | null {
  const next = loadStockGeneration() + 1;
  return persist(STORAGE_STOCK_GEN_KEY, String(next), { json: false });
}

export function loadDurableGlobalAutoDeductEnabled(): boolean {
  return loadString(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'true') !== 'false';
}

/** Runtime-validated medication-list parser for durable stock reads. */
function parseMedicationList(raw: unknown): Medication[] | null {
  if (!Array.isArray(raw) || !raw.every(isValidMedicationRecord)) return null;
  return raw;
}

/** Runtime-validated consumption-log parser for durable stock reads. */
function parseConsumptionLogs(raw: unknown): ConsumptionLog[] | null {
  if (!Array.isArray(raw) || !raw.every(isValidConsumptionLogRecord)) return null;
  return raw;
}

export function loadDurableAutoStockState(): AutoStockDurableState {
  // Durable Auto-owned state is a trusted reconciliation input: malformed
  // records are surfaced as explicit invalid outcomes (diagnosable) instead
  // of silently collapsing into an authoritative empty snapshot.
  const meds = readJsonOutcome(STORAGE_MEDS_KEY, parseMedicationList);
  const logs = readJsonOutcome(STORAGE_LOGS_KEY, parseConsumptionLogs);
  if (meds.status === 'invalid' || meds.status === 'read_failed') {
    console.warn(
      `[auto-stock] durable medication state unusable (${meds.status}: ${'reason' in meds ? meds.reason : ''}); failing closed.`
    );
  }
  if (logs.status === 'invalid' || logs.status === 'read_failed') {
    console.warn(
      `[auto-stock] durable log state unusable (${logs.status}: ${'reason' in logs ? logs.reason : ''}); failing closed.`
    );
  }
  return {
    medications: meds.status === 'ok' ? meds.value : [],
    logs: logs.status === 'ok' ? logs.value : [],
    globalAutoDeductEnabled: loadDurableGlobalAutoDeductEnabled(),
  };
}

export interface CommitDurableOptions {
  /**
   * Required finalization marker after meds+logs. If this write fails, the
   * whole commit fails so callers keep the envelope (recovery evidence).
   */
  appliedMutationSeq?: number;
}

/**
 * Persist meds, logs, and the durable global auto-deduct switch, then
 * lastAppliedMutationSeq (when provided).
 *
 * Contract:
 * - meds/logs/global fail → error (recovery evidence must remain)
 * - appliedMutationSeq provided and lastApplied fails → error (pair may be
 *   durable but finalization incomplete; keep envelope)
 * - generation bump is best-effort only after finalization succeeds
 */
export function commitDurableAutoStockState(
  state: AutoStockDurableState,
  opts?: CommitDurableOptions
): string | null {
  const medErr = persist(STORAGE_MEDS_KEY, state.medications, { json: true });
  if (medErr) return medErr;
  const logErr = persist(STORAGE_LOGS_KEY, state.logs, { json: true });
  if (logErr) return logErr;
  if (state.globalAutoDeductEnabled != null) {
    const globalErr = persist(
      STORAGE_GLOBAL_AUTO_DEDUCT_KEY,
      String(state.globalAutoDeductEnabled),
      { json: false }
    );
    if (globalErr) return globalErr;
  }
  if (opts?.appliedMutationSeq != null) {
    const seqErr = persistLastAppliedMutationSeq(opts.appliedMutationSeq);
    if (seqErr) return seqErr;
  }
  bumpStockGeneration();
  return null;
}

export function withAutoStockMutationGate<T>(
  fn: (fresh: AutoStockDurableState) => T | Promise<T>
): Promise<T> {
  const run = chain.then(
    () => withCrossDocumentStockLock(async () => fn(loadDurableAutoStockState())),
    () => withCrossDocumentStockLock(async () => fn(loadDurableAutoStockState()))
  );
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
