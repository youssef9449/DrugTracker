/**
 * Shared durable causal ordering for Manual and Exact Auto stock mutations.
 *
 * Each in-flight envelope is assigned a monotonic mutationSeq at creation.
 * After meds+logs succeed, lastAppliedMutationSeq is advanced to that seq
 * (best-effort with the pair write). Recovery never applies an envelope whose
 * seq is <= lastApplied, so an older envelope cannot overwrite newer durable
 * state even when generation lag leaves multiple envelopes pending.
 */

import { loadString, persist } from './storage';

export const STORAGE_LAST_APPLIED_SEQ_KEY =
  'android_med_tracker_stock_mutation_seq_applied_v1';
export const STORAGE_NEXT_SEQ_KEY =
  'android_med_tracker_stock_mutation_seq_next_v1';

let testLastApplied: number | null = null;
let testNextSeq: number | null = null;
let testHooks: {
  loadLastApplied?: () => number;
  persistLastApplied?: (seq: number) => string | null;
  allocate?: () => number;
} | null = null;

/** @internal test-only */
export function __setStockMutationOrderingTestHooks(
  hooks: {
    loadLastApplied?: () => number;
    persistLastApplied?: (seq: number) => string | null;
    allocate?: () => number;
  } | null
): void {
  testHooks = hooks;
  if (!hooks) {
    testLastApplied = null;
    testNextSeq = null;
  }
}

export function loadLastAppliedMutationSeq(): number {
  if (testHooks?.loadLastApplied) return testHooks.loadLastApplied();
  if (testLastApplied != null) return testLastApplied;
  const raw = loadString(STORAGE_LAST_APPLIED_SEQ_KEY, '0');
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function persistLastAppliedMutationSeq(seq: number): string | null {
  if (testHooks?.persistLastApplied) return testHooks.persistLastApplied(seq);
  const err = persist(STORAGE_LAST_APPLIED_SEQ_KEY, String(seq), { json: false });
  if (!err) testLastApplied = seq;
  return err;
}

/**
 * Allocate the next mutation sequence for a new envelope.
 * Persists the counter so concurrent process restarts cannot reuse seqs.
 */
export function allocateMutationSeq(): number {
  if (testHooks?.allocate) return testHooks.allocate();
  if (testNextSeq != null) {
    testNextSeq += 1;
    return testNextSeq;
  }
  const raw = loadString(STORAGE_NEXT_SEQ_KEY, '0');
  const cur = Number(raw);
  const base = Number.isFinite(cur) && cur >= 0 ? Math.floor(cur) : 0;
  const next = base + 1;
  persist(STORAGE_NEXT_SEQ_KEY, String(next), { json: false });
  return next;
}

/** @internal test-only in-memory counters without localStorage */
export function __resetStockMutationOrderingForTests(): void {
  testLastApplied = 0;
  testNextSeq = 0;
  testHooks = null;
}

export type EnvelopeRecoveryClass = 'apply' | 'already_applied';

/**
 * Causal classify: never apply seq that is already covered by lastApplied.
 */
export function classifyEnvelopeBySeq(
  mutationSeq: number,
  lastApplied: number
): EnvelopeRecoveryClass {
  if (mutationSeq <= lastApplied) return 'already_applied';
  return 'apply';
}

/**
 * Secondary guard when lastApplied lagged behind a successful pair write:
 * if every envelope log id is already present in durable logs, the mutation
 * effects are present — treat as already_applied (do not use log ids alone
 * to prove "newest medications snapshot", only that this mutation's logs landed).
 */
export function envelopeLogIdsPresentInDurable(
  envelopeLogs: Array<{ id?: string }>,
  durableLogs: Array<{ id?: string }>
): boolean {
  if (!Array.isArray(envelopeLogs) || envelopeLogs.length === 0) return false;
  const ids = new Set(
    durableLogs.map((l) => l.id).filter((id): id is string => !!id)
  );
  return envelopeLogs.every((l) => !!l.id && ids.has(l.id));
}
