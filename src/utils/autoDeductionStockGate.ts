/**
 * Single-process mutex for auto-stock mutations (exact auto-deduction +
 * Manual Take/Restore). Serializes async work so two reconciliations never
 * interleave durable reads/writes.
 *
 * Not a multi-tab distributed lock.
 */

import type { ConsumptionLog, Medication } from '../types';
import { loadJson, loadString, persist } from './storage';
import {
  persistLastAppliedMutationSeq,
} from './stockMutationOrdering';

/** Same keys as App.tsx / existing persistence. */
export const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
export const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
/**
 * Monotonic durable generation for meds+logs commits (diagnostic / lag signal).
 * Causal ordering for envelope recovery uses mutationSeq + lastAppliedMutationSeq
 * from stockMutationOrdering.ts — not generation alone.
 */
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
  /** When set, advance lastAppliedMutationSeq after meds+logs succeed. */
  appliedMutationSeq?: number;
}

/**
 * Persist meds then logs, record applied mutation seq, then best-effort gen bump.
 *
 * Success means meds+logs are durable. lastAppliedMutationSeq is written next
 * (best-effort but attempted before returning success) so recovery can order
 * envelopes. Generation bump remains best-effort only.
 */
export function commitDurableAutoStockState(
  state: AutoStockDurableState,
  opts?: CommitDurableOptions
): string | null {
  if (testCommit) {
    const err = testCommit(state);
    if (err) return err;
    if (opts?.appliedMutationSeq != null) {
      persistLastAppliedMutationSeq(opts.appliedMutationSeq);
    }
    bumpStockGeneration();
    return null;
  }
  const medErr = persist(STORAGE_MEDS_KEY, state.medications, { json: true });
  if (medErr) return medErr;
  const logErr = persist(STORAGE_LOGS_KEY, state.logs, { json: true });
  if (logErr) return logErr;
  if (opts?.appliedMutationSeq != null) {
    // Best-effort causal marker; recovery also uses seq classify + log presence.
    persistLastAppliedMutationSeq(opts.appliedMutationSeq);
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
