import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RestoreFutureSchedulesResult } from '../../src/utils/autoDeductionNative';
import {
  recoveryBoundaryKey,
  restoreFutureSchedulesOnce,
  __resetRestoreFutureSchedulesBoundaryForTests } from '../../src/utils/restoreFutureSchedulesBoundary';

vi.mock('../../src/utils/autoDeductionNative', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/autoDeductionNative')>();
  return {
    ...actual,
    restoreFutureAutoDeductionSchedules: vi.fn(),
  };
});

import { restoreFutureAutoDeductionSchedules } from '../../src/utils/autoDeductionNative';

describe('restoreFuture fail-closed + boundary-aware owner', () => {
  beforeEach(() => {
    __resetRestoreFutureSchedulesBoundaryForTests();
    vi.mocked(restoreFutureAutoDeductionSchedules).mockReset();
  });
  afterEach(() => {
    __resetRestoreFutureSchedulesBoundaryForTests();
    vi.restoreAllMocks();
  });

  it('recoveryBoundaryKey is canonical for both hooks', () => {
    expect(recoveryBoundaryKey(1, 2)).toBe('1:2');
    expect(recoveryBoundaryKey(1, 2)).toBe(recoveryBoundaryKey(1, 2));
  });

  it('coalesces concurrent restore for same boundary into one native call', async () => {
    let resolve!: (v: RestoreFutureSchedulesResult) => void;
    const p = new Promise<RestoreFutureSchedulesResult>((r) => {
      resolve = r;
    });
    vi.mocked(restoreFutureAutoDeductionSchedules).mockReturnValue(p);

    const key = recoveryBoundaryKey(3, 4);
    const a = restoreFutureSchedulesOnce(key);
    const b = restoreFutureSchedulesOnce(key);
    expect(restoreFutureAutoDeductionSchedules).toHaveBeenCalledTimes(1);
    resolve({ ok: true, restored: 2, failed: 0 });
    await expect(a).resolves.toEqual({ ok: true, restored: 2, failed: 0 });
    await expect(b).resolves.toEqual({ ok: true, restored: 2, failed: 0 });
  });

  it('same boundary after success does not call native again', async () => {
    vi.mocked(restoreFutureAutoDeductionSchedules).mockResolvedValue({
      ok: true,
      restored: 1,
      failed: 0,
    });
    const key = recoveryBoundaryKey(5, 0);
    await restoreFutureSchedulesOnce(key);
    await restoreFutureSchedulesOnce(key);
    expect(restoreFutureAutoDeductionSchedules).toHaveBeenCalledTimes(1);
  });

  it('failed boundary remains retryable', async () => {
    vi.mocked(restoreFutureAutoDeductionSchedules)
      .mockResolvedValueOnce({
        ok: false,
        restored: 0,
        failed: 1,
        error: 'restore_boundary_incomplete',
      })
      .mockResolvedValueOnce({ ok: true, restored: 1, failed: 0 });
    const key = recoveryBoundaryKey(7, 1);
    const first = await restoreFutureSchedulesOnce(key);
    expect(first.ok).toBe(false);
    const second = await restoreFutureSchedulesOnce(key);
    expect(second.ok).toBe(true);
    expect(restoreFutureAutoDeductionSchedules).toHaveBeenCalledTimes(2);
  });

  it('new boundary triggers a new native restore', async () => {
    vi.mocked(restoreFutureAutoDeductionSchedules).mockResolvedValue({
      ok: true,
      restored: 0,
      failed: 0,
    });
    await restoreFutureSchedulesOnce(recoveryBoundaryKey(1, 0));
    await restoreFutureSchedulesOnce(recoveryBoundaryKey(2, 0));
    expect(restoreFutureAutoDeductionSchedules).toHaveBeenCalledTimes(2);
  });

  it('scheduler and exact recon share the same key for same ticks', async () => {
    vi.mocked(restoreFutureAutoDeductionSchedules).mockResolvedValue({
      ok: true,
      restored: 0,
      failed: 0,
    });
    // Simulates both hooks on the same resume/midnight boundary.
    const shared = recoveryBoundaryKey(9, 3);
    await restoreFutureSchedulesOnce(shared);
    await restoreFutureSchedulesOnce(shared);
    expect(restoreFutureAutoDeductionSchedules).toHaveBeenCalledTimes(1);
  });
});
