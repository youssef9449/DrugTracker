/**
 * Phase 2 contract tests for JS types that mirror native result semantics.
 * Does not require Android. Ensures CancelOccurrenceResult / status union stay honest.
 */
import { describe, it, expect } from 'vitest';
import type {
  CancelOccurrenceResult,
  CancelOccurrenceStatus,
  ScheduleOccurrenceResult,
} from '../../src/utils/autoDeductionNative';

describe('CancelOccurrenceResult contract', () => {
  it('SUCCESS is ok', () => {
    const r: CancelOccurrenceResult = { ok: true, status: 'SUCCESS' };
    expect(r.ok).toBe(true);
    expect(r.status).toBe('SUCCESS');
  });

  it('ALREADY_ABSENT is ok (terminal)', () => {
    const r: CancelOccurrenceResult = { ok: true, status: 'ALREADY_ABSENT' };
    expect(r.ok).toBe(true);
  });

  it('FAILED is not ok and may carry error', () => {
    const r: CancelOccurrenceResult = {
      ok: false,
      status: 'FAILED',
      error: 'schedule_metadata_remove_failed',
    };
    expect(r.ok).toBe(false);
    expect(r.status).toBe('FAILED');
    expect(r.error).toBeTruthy();
  });

  it('status union is exhaustive for known values', () => {
    const statuses: CancelOccurrenceStatus[] = ['SUCCESS', 'ALREADY_ABSENT', 'FAILED'];
    expect(statuses).toHaveLength(3);
  });
});

describe('ScheduleOccurrenceResult contract', () => {
  it('success carries occurrenceKey', () => {
    const r: ScheduleOccurrenceResult = {
      ok: true,
      occurrenceKey: 'm\u001fd\u001f2026-09-14',
    };
    expect(r.ok).toBe(true);
  });

  it('failure carries error', () => {
    const r: ScheduleOccurrenceResult = { ok: false, error: 'trigger_in_past' };
    expect(r.ok).toBe(false);
  });
});
