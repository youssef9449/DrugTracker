/**
 * Serialized fresh-state stock mutation boundary for:
 * - legacy syncAutoDailyDeductions
 * - exact native event reconciliation
 *
 * Caller React snapshots are NOT authoritative. Each gate entry loads the
 * latest durable medications/logs from localStorage, runs the mutation on
 * that state, and returns the result for the caller to update React after
 * durable commit.
 *
 * Process-local promise chain only — not a distributed lock.
 */

import type { ConsumptionLog, Medication } from '../types';
import { loadJson, persist } from './storage';

/** Same keys as App.tsx / existing persistence. */
export const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
export const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';

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

/** @internal test-only */
export function __setAutoStockGateTestHooks(hooks: {
  load?: () => AutoStockDurableState;
  commit?: (state: AutoStockDurableState) => string | null;
} | null): void {
  testLoad = hooks?.load ?? null;
  testCommit = hooks?.commit ?? null;
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
 * Persist meds then logs. Returns error string if either write fails.
 * Not a true multi-key transaction — callers that need both should use
 * the exact-auto envelope for recovery of partial failures.
 */
export function commitDurableAutoStockState(state: AutoStockDurableState): string | null {
  if (testCommit) return testCommit(state);
  const medErr = persist(STORAGE_MEDS_KEY, state.medications, { json: true });
  if (medErr) return medErr;
  const logErr = persist(STORAGE_LOGS_KEY, state.logs, { json: true });
  if (logErr) return logErr;
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
