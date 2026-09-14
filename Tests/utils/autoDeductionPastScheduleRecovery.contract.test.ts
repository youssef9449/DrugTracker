/**
 * Phase 2 regression contract: past-schedule metadata may be removed only when
 * a durable recovery source exists for the exact occurrence.
 *
 * Mirrors AutoDeductionScheduler.shouldRemovePastScheduleMetadata:
 *   CREATED              → remove
 *   ALREADY_EXISTS       → remove
 *   FAILED + pending     → remove
 *   FAILED + no pending  → PRESERVE (critical regression)
 *
 * Native Java execution is not available in this environment; these tests
 * lock the decision matrix so a future harness can assert the same rule.
 */
import { describe, it, expect } from 'vitest';

/** Pure decision matching native shouldRemovePastScheduleMetadata. */
function shouldRemovePastScheduleMetadata(result: {
  status: 'CREATED' | 'ALREADY_EXISTS' | 'FAILED';
  pendingRecorded: boolean;
}): boolean {
  if (result.status === 'CREATED' || result.status === 'ALREADY_EXISTS') {
    return true;
  }
  if (result.status === 'FAILED' && result.pendingRecorded) {
    return true;
  }
  return false;
}

describe('past-schedule recovery matrix (PR #210 durability invariant)', () => {
  it('CREATED → remove schedule metadata', () => {
    expect(
      shouldRemovePastScheduleMetadata({ status: 'CREATED', pendingRecorded: false })
    ).toBe(true);
  });

  it('ALREADY_EXISTS → remove schedule metadata', () => {
    expect(
      shouldRemovePastScheduleMetadata({
        status: 'ALREADY_EXISTS',
        pendingRecorded: false,
      })
    ).toBe(true);
  });

  it('FAILED + pendingRecorded=true → remove schedule metadata', () => {
    expect(
      shouldRemovePastScheduleMetadata({ status: 'FAILED', pendingRecorded: true })
    ).toBe(true);
  });

  it('FAILED + pendingRecorded=false → PRESERVE schedule metadata (critical)', () => {
    expect(
      shouldRemovePastScheduleMetadata({ status: 'FAILED', pendingRecorded: false })
    ).toBe(false);
  });

  it('pathological triple-failure still has a recovery source (metadata kept)', () => {
    // fire → main fail → retry fail → pending fail → restore past → insert fail again
    // → metadata must remain so a later restore can still attempt recovery
    const remove = shouldRemovePastScheduleMetadata({
      status: 'FAILED',
      pendingRecorded: false,
    });
    expect(remove).toBe(false);
  });
});
