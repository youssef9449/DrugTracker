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

describe('restoreFuture fail-closed + single boundary owner', () => {
  beforeEach(() => {
    __resetRestoreFutureSchedulesBoundaryForTests();
    vi.mocked(restoreFutureAutoDeductionSchedules).mockReset();
  });
  afterEach(() => {
    __resetRestoreFutureSchedulesBoundaryForTests();
    vi.restoreAllMocks();
  });

  it('coalesces concurrent restore into one native call', async () => {
    let resolve!: (v: RestoreFutureSchedulesResult) => void;
    const p = new Promise<RestoreFutureSchedulesResult>((r) => {
      resolve = r;
    });
    vi.mocked(restoreFutureAutoDeductionSchedules).mockReturnValue(p);

    const a = restoreFutureSchedulesOnce();
    const b = restoreFutureSchedulesOnce();
    expect(restoreFutureAutoDeductionSchedules).toHaveBeenCalledTimes(1);
    resolve({ ok: true, restored: 2, failed: 0 });
    await expect(a).resolves.toEqual({ ok: true, restored: 2, failed: 0 });
    await expect(b).resolves.toEqual({ ok: true, restored: 2, failed: 0 });
  });

  it('propagates ok=false restore failure (never pretends success with restored=0)', async () => {
    vi.mocked(restoreFutureAutoDeductionSchedules).mockResolvedValue({
      ok: false,
      restored: 0,
      failed: 0,
      error: 'restore_boundary_incomplete',
    });
    const result = await restoreFutureSchedulesOnce();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('restore_boundary_incomplete');
  });

  it('success path returns restored count with ok true', async () => {
    vi.mocked(restoreFutureAutoDeductionSchedules).mockResolvedValue({
      ok: true,
      restored: 3,
      failed: 0,
    });
    const result = await restoreFutureSchedulesOnce();
    expect(result.ok).toBe(true);
    expect(result.restored).toBe(3);
  });
});
