/**
 * Single-process mutex for auto-stock mutations (exact auto-deduction +
 * Manual Take/Restore). Serializes async work so two reconciliations never
 * interleave durable reads/writes.
 *
 * Not a multi-tab distributed lock.
 */

import type { ConsumptionLog, Medication } from '../types';
import { loadJson, loadString, persist } from './storage';
import { persistLastAppliedMutationSeq } from './stockMutationOrdering';

export const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
export const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
export const STORAGE_STOCK_GEN_KEY = 'android_med_tracker_stock_generation_v1';

export interface AutoStockDurableState {
  medications: Medication[];
  logs: ConsumptionLog[];
}

let chain: Promise<unknown> = Promise.resolve();

let testLoad: (() => AutoStockDurableState) | null = null;
let testCommit: ((state: AutoStockDurableState) => string | null) | null = null;
let testLoadGeneration: (() => number) | null = null;
let testBumpGeneration: (() => string | null) | null = null;

/** @internal test-only */
export function __setAutoStockGateTestHooks(hooks: {
  load?: () => AutoStockDurableState;
  commit?: (state: AutoStockDurableState) => string | null;
  loadGeneration?: () => number;
  bumpGeneration?: () => string | null;
} | null): void {
  testLoad = hooks?.load ?? null;
  testCommit = hooks?.commit ?? null;
  testLoadGeneration = hooks?.loadGeneration ?? null;
  testBumpGeneration = hooks?.bumpGeneration ?? null;
}

export function loadStockGeneration(): number {
  if (testLoadGeneration) return testLoadGeneration();
  const raw = loadString(STORAGE_STOCK_GEN_KEY, '0');
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function bumpStockGeneration(): string | null {
  if (testBumpGeneration) return testBumpGeneration();
  const next = loadStockGeneration() + 1;
  return persist(STORAGE_STOCK_GEN_KEY, String(next), { json: false });
}

export function loadDurableAutoStockState(): AutoStockDurableState {
  if (testLoad) return testLoad();
  const meds = loadJson<Medication[] | null>(STORAGE_MEDS_KEY, null);
  const logs = loadJson<ConsumptionLog[] | null>(STORAGE_LOGS_KEY, null);
  return {
    medications: Array.isArray(meds) ? meds : [],
    logs: Array.isArray(logs) ? logs : [],
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
 * Persist meds then logs then lastAppliedMutationSeq (when provided).
 *
 * Contract:
 * - meds or logs fail → error (pair not durable)
 * - appliedMutationSeq provided and lastApplied fails → error (pair may be
 *   durable but finalization incomplete; keep envelope)
 * - generation bump is best-effort only after finalization succeeds
 */
export function commitDurableAutoStockState(
  state: AutoStockDurableState,
  opts?: CommitDurableOptions
): string | null {
  if (testCommit) {
    const err = testCommit(state);
    if (err) return err;
    if (opts?.appliedMutationSeq != null) {
      const seqErr = persistLastAppliedMutationSeq(opts.appliedMutationSeq);
      if (seqErr) return seqErr;
    }
    bumpStockGeneration();
    return null;
  }
  const medErr = persist(STORAGE_MEDS_KEY, state.medications, { json: true });
  if (medErr) return medErr;
  const logErr = persist(STORAGE_LOGS_KEY, state.logs, { json: true });
  if (logErr) return logErr;
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
    () => {
      const fresh = loadDurableAutoStockState();
      return fn(fresh);
    },
    () => {
      const fresh = loadDurableAutoStockState();
      return fn(fresh);
    }
  );
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
