import { describe, expect, it } from 'vitest';
import { runWithBoundedRetry, DEFAULT_RETRY_BACKOFF_MS } from '@/utils/async/BoundedRetry';
import {
  pruneConsumptionLogs,
  consumptionLogRetentionCutoff,
  DOSE_HISTORY_RETENTION_DAYS,
} from '@/utils/pruneDoseConsumption';
import { addCalendarDays } from '@/utils/dateCalculations';
import type { ConsumptionLog } from '@/types';

describe('feature-neutral bounded retry primitive (#521)', () => {
  it('runs the attempt once on success', async () => {
    let runs = 0;
    const handle = runWithBoundedRetry({
      runAttempt: () => {
        runs += 1;
      },
      isCurrent: () => true,
      backoffMs: [1, 1],
    });
    await new Promise((r) => setTimeout(r, 5));
    handle.cancel();
    expect(runs).toBe(1);
  });

  it('retries with bounded backoff then succeeds', async () => {
    let runs = 0;
    const handle = runWithBoundedRetry({
      runAttempt: () => {
        runs += 1;
        if (runs < 3) throw new Error('transient');
      },
      isCurrent: () => true,
      backoffMs: [1, 1],
    });
    await new Promise((r) => setTimeout(r, 30));
    handle.cancel();
    expect(runs).toBe(3);
  });

  it('stops at the bounded budget and reports exhaustion', async () => {
    let runs = 0;
    let exhausted = false;
    const handle = runWithBoundedRetry({
      runAttempt: () => {
        runs += 1;
        throw new Error('always fails');
      },
      isCurrent: () => true,
      onExhausted: () => {
        exhausted = true;
      },
      backoffMs: [1, 1],
      maxRetries: 2,
    });
    await new Promise((r) => setTimeout(r, 40));
    handle.cancel();
    expect(runs).toBe(3); // initial + 2 retries
    expect(exhausted).toBe(true);
  });

  it('never runs stale work after the staleness check flips', async () => {
    let runs = 0;
    let current = true;
    const handle = runWithBoundedRetry({
      runAttempt: () => {
        runs += 1;
        current = false; // superseded mid-flight
        throw new Error('stale failure');
      },
      isCurrent: () => current,
      backoffMs: [1, 1],
    });
    await new Promise((r) => setTimeout(r, 20));
    handle.cancel();
    expect(runs).toBe(1);
  });

  it('exposes the documented default backoff schedule', () => {
    expect(DEFAULT_RETRY_BACKOFF_MS).toEqual([1000, 4000, 16000]);
  });
});

describe('centralized bounded retention (#507)', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  function log(id: string, date: string): ConsumptionLog {
    return {
      id,
      medicationId: 'm',
      medicationName: 'M',
      type: 'dose_taken',
      amount: -1,
      date,
      timestamp: date + 'T00:00:00.000Z',
      description: '',
    };
  }

  it('keeps rows inside the retention window and drops older ones', () => {
    // Derive the exact boundary from the production policy so the test
    // documents the real inclusive cutoff (a literal like '2025-05-10' is
    // off-by-one relative to the 400-day window and timezone-fragile):
    // cutoff = local date of `now` minus 400 calendar days; rows with
    // date >= cutoff are kept, anything older is dropped.
    const cutoff = consumptionLogRetentionCutoff(now);
    const fresh = log('fresh', '2026-06-14');
    const edge = log('edge', cutoff); // exactly 400 days before now — kept
    const stale = log('stale', addCalendarDays(cutoff, -1)); // one day beyond — dropped
    const result = pruneConsumptionLogs([stale, fresh, edge], now);
    expect(result.map((l) => l.id)).toEqual(['fresh', 'edge']);
  });

  it('never invents facts about unparsable dates (kept)', () => {
    const weird = log('weird', 'not-a-date');
    expect(pruneConsumptionLogs([weird], now)).toEqual([weird]);
  });

  it('returns the same array when nothing is pruned', () => {
    const logs = [log('a', '2026-06-01')];
    expect(pruneConsumptionLogs(logs, now)).toBe(logs);
  });

  it('documents a bounded window for per-dose history', () => {
    expect(DOSE_HISTORY_RETENTION_DAYS).toBeGreaterThan(365);
  });
});
