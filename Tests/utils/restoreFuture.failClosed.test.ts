import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RestoreFutureSchedulesResult } from '../../src/utils/autoDeductionNative';
import {
  restoreFutureSchedulesOnce,
  __resetRestoreFutureSchedulesBoundaryForTests,
} from '../../src/utils/restoreFutureSchedulesBoundary';

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

  it('coalesces concurrent restore for same boundary into one native call', async () => {
    let resolve!: (v: RestoreFutureSchedulesResult) => void;
    const p = new Promise<RestoreFutureSchedulesResult>((r) => {
      resolve = r;
    });
    vi.mocked(restoreFutureAutoDeductionSchedules).mockReturnValue(p);

    const a = restoreFutureSchedulesOnce('b1');
    const b = restoreFutureSchedulesOnce('b1');
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
    await restoreFutureSchedulesOnce('b-success');
    await restoreFutureSchedulesOnce('b-success');
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
    const first = await restoreFutureSchedulesOnce('b-fail');
    expect(first.ok).toBe(false);
    const second = await restoreFutureSchedulesOnce('b-fail');
    expect(second.ok).toBe(true);
    expect(restoreFutureAutoDeductionSchedules).toHaveBeenCalledTimes(2);
  });

  it('new boundary triggers a new native restore', async () => {
    vi.mocked(restoreFutureAutoDeductionSchedules).mockResolvedValue({
      ok: true,
      restored: 0,
      failed: 0,
    });
    await restoreFutureSchedulesOnce('b-a');
    await restoreFutureSchedulesOnce('b-b');
    expect(restoreFutureAutoDeductionSchedules).toHaveBeenCalledTimes(2);
  });

  it('propagates ok=false restore failure', async () => {
    vi.mocked(restoreFutureAutoDeductionSchedules).mockResolvedValue({
      ok: false,
      restored: 0,
      failed: 0,
      error: 'restore_boundary_incomplete',
    });
    const result = await restoreFutureSchedulesOnce('b-err');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('restore_boundary_incomplete');
  });
});
