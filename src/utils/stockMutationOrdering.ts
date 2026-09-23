/**
 * Shared durable causal ordering for Manual and Exact Auto stock mutations.
 *
 * mutationSeq is allocated only when the next-seq counter persists successfully.
 * lastAppliedMutationSeq is a required finalization marker after meds+logs:
 * envelopes must not be cleared until lastApplied is durable (or recovery
 * finalizes it when the pair is already reflected).
 */

import { loadString, persist } from './storage';

export const STORAGE_LAST_APPLIED_SEQ_KEY =
  'android_med_tracker_stock_mutation_seq_applied_v1';
export const STORAGE_NEXT_SEQ_KEY =
  'android_med_tracker_stock_mutation_seq_next_v1';

export function loadLastAppliedMutationSeq(): number {
  const raw = loadString(STORAGE_LAST_APPLIED_SEQ_KEY, '0');
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Persist last-applied marker. Failure must be treated as non-final by callers:
 * keep envelope, do not report durable success that allows discarding recovery
 * evidence.
 */
export function persistLastAppliedMutationSeq(seq: number): string | null {
  // Invariant: lastAppliedMutationSeq never decreases.
  const current = loadLastAppliedMutationSeq();
  if (!(seq > current)) {
    // Already at or ahead of requested seq — success without downgrade.
    return null;
  }
  return persist(STORAGE_LAST_APPLIED_SEQ_KEY, String(seq), { json: false });
}

export type AllocateMutationSeqResult =
  | { ok: true; seq: number }
  | { ok: false; error: string };

/**
 * Allocate next mutation sequence only if the counter persists.
 * On persistence failure, returns error — callers must not open an envelope.
 */
export function allocateMutationSeq(): AllocateMutationSeqResult {
  const raw = loadString(STORAGE_NEXT_SEQ_KEY, '0');
  const cur = Number(raw);
  const storedNext = Number.isFinite(cur) && cur >= 0 ? Math.floor(cur) : 0;
  // Invariant: every newly allocated mutationSeq > current lastApplied.
  const lastApplied = loadLastAppliedMutationSeq();
  const next = Math.max(storedNext, lastApplied) + 1;
  const err = persist(STORAGE_NEXT_SEQ_KEY, String(next), { json: false });
  if (err) return { ok: false, error: err };
  return { ok: true, seq: next };
}

export type EnvelopeRecoveryClass = 'apply' | 'already_applied';

export function classifyEnvelopeBySeq(
  mutationSeq: number,
  lastApplied: number
): EnvelopeRecoveryClass {
  if (mutationSeq <= lastApplied) return 'already_applied';
  return 'apply';
}

/**
 * Log-id presence only proves the mutation's logs landed (duplicate prevention).
 * Not sufficient alone to prove medications snapshot is newest — combine with
 * mutationSeq / lastApplied and higher-pending supersession checks.
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
