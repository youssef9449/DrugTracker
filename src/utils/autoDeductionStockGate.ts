/**
 * Single-process mutex for auto-stock mutations (exact auto-deduction +
 * Manual Take/Restore). Serializes async work so two reconciliations never
 * interleave durable reads/writes.
 *
 * Not a multi-tab distributed lock.
 */

import type { ConsumptionLog, Medication } from '../types';
import { loadJson, loadString, persist } from './storage';

/** Same keys as App.tsx / existing persistence. */
export const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
export const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
/**
 * Monotonic durable generation for meds+logs commits.
 * Bumped after both meds and logs persist successfully (best-effort).
 * Manual envelope stores baseGeneration so recovery can detect a stale
 * snapshot when durable advanced past that mutation.
 *
 * Generation lag after a successful meds+logs pair is tolerated: recovery
 * uses content checks (log ids / markers) when generation has not advanced.
 */
export const STORAGE_STOCK_GEN_KEY = 'android_med_tracker_stock_generation_v1';

export interface AutoStockDurableState {
  medications: Medication[];
  logs: ConsumptionLog[];
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Optional test injectors so pure unit tests can supply in-memory durable state
 * without touching real localStorage.
 */
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

/**
 * Bump durable generation after a successful meds+logs pair write.
 * Returns error string if the generation key cannot be persisted.
 */
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

/**
 * Persist meds then logs, then best-effort bump stock generation.
 *
 * Contract:
 * - Failure of meds or logs → error (pair not durable).
 * - Both meds+logs succeed → success even if generation bump fails.
 *   Generation lag is recovered via Manual envelope content checks
 *   (log ids already present ⇒ treat as applied, do not re-snapshot).
 */
export function commitDurableAutoStockState(state: AutoStockDurableState): string | null {
  if (testCommit) {
    const err = testCommit(state);
    if (err) return err;
    // Pair is durable; generation bump is best-effort only.
    bumpStockGeneration();
    return null;
  }
  const medErr = persist(STORAGE_MEDS_KEY, state.medications, { json: true });
  if (medErr) return medErr;
  const logErr = persist(STORAGE_LOGS_KEY, state.logs, { json: true });
  if (logErr) return logErr;
  // Best-effort: do not fail the commit if generation cannot be written.
  // Recovery distinguishes applied vs pending via log-id content checks.
  bumpStockGeneration();
  return null;
}

/**
 * Serialize mutations. The callback always receives FRESH durable state
 * loaded at the start of this critical section (after previous jobs finish).
 */
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
