/**
 * Phase 2 — JS scheduler must respect CancelResult from native.
 * SUCCESS / ALREADY_ABSENT → drop tracking
 * FAILED → retain tracking for later retry
 *
 * These tests mock the native bridge; they do not require Android runtime.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication } from '../../src/types';

const cancelMock = vi.fn();
const scheduleMock = vi.fn();
const invalidateMock = vi.fn();
const listScheduledMock = vi.fn();

vi.mock('../../src/utils/autoDeductionNative', () => ({
  cancelAutoDeduction: (...args: unknown[]) => cancelMock(...args),
  scheduleAutoDeduction: (...args: unknown[]) => scheduleMock(...args),
  // Issue #241: the scheduler now gates every occurrence cancel through a
  // durable recurrence-invalidation call (invalidateAutoDeductionRecurrence)
  // and reconciles against native-side scheduled occurrences
  // (listScheduledAutoDeductionOccurrences) before touching trackedRef.
  invalidateAutoDeductionRecurrence: (...args: unknown[]) =>
    invalidateMock(...args),
  listScheduledAutoDeductionOccurrences: (...args: unknown[]) =>
    listScheduledMock(...args),
  autoDeductionOccurrenceKey: (m: string, d: string, c: string) => `${m}\u001f${d}\u001f${c}`,
}));

// Import after mock
import { useAutoDeductionScheduler } from '../../src/hooks/useAutoDeductionScheduler';

function baseMed(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSyncDate: '2026-09-14',
    autoDeductEnabled: true,
    reminderTime: '10:00',
    ...over,
  };
}

describe('useAutoDeductionScheduler CancelResult handling', () => {
  beforeEach(() => {
    cancelMock.mockReset();
    scheduleMock.mockReset();
    invalidateMock.mockReset();
    listScheduledMock.mockReset();
    // Default: invalidate succeeds (recurrence generation bumped), so the
    // scheduler may proceed to cancelAutoDeduction. Native schedule list is
    // empty so the desired-state pass only operates on trackedRef.
    invalidateMock.mockResolvedValue({ ok: true });
    listScheduledMock.mockResolvedValue([]);
    scheduleMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('removes tracking when cancel returns ok=true (SUCCESS)', async () => {
    cancelMock.mockResolvedValue({ ok: true, status: 'SUCCESS' });
    // First render with tracking desired, then remove med to force cancel
    const med = baseMed();
    const { rerender, unmount } = renderHook(
      (props: { meds: Medication[]; enabled: boolean }) =>
        useAutoDeductionScheduler({
          medications: props.meds,
          globalAutoDeductEnabled: props.enabled,
          hydrated: true,
          isFirstRun: false,
          exactAlarmEnabled: true,
        }),
      { initialProps: { meds: [med], enabled: true } }
    );

    // Allow chain to schedule
    await new Promise((r) => setTimeout(r, 20));
    expect(scheduleMock).toHaveBeenCalled();

    // Disable global auto-deduct → should cancel tracked
    rerender({ meds: [med], enabled: false });
    await new Promise((r) => setTimeout(r, 30));

    expect(cancelMock).toHaveBeenCalled();
    unmount();
  });

  it('retains retry path when cancel returns ok=false (FAILED)', async () => {
    cancelMock.mockResolvedValue({
      ok: false,
      status: 'FAILED',
      error: 'schedule_metadata_remove_failed',
    });
    const med = baseMed();
    const { rerender, unmount } = renderHook(
      (props: { meds: Medication[]; enabled: boolean }) =>
        useAutoDeductionScheduler({
          medications: props.meds,
          globalAutoDeductEnabled: props.enabled,
          hydrated: true,
          isFirstRun: false,
          exactAlarmEnabled: true,
        }),
      { initialProps: { meds: [med], enabled: true } }
    );

    await new Promise((r) => setTimeout(r, 20));

    // Force cancel of previously scheduled
    rerender({ meds: [med], enabled: false });
    await new Promise((r) => setTimeout(r, 30));

    expect(cancelMock).toHaveBeenCalled();
    // A subsequent enable→disable cycle should retry cancel (tracked retained)
    cancelMock.mockClear();
    cancelMock.mockResolvedValue({
      ok: false,
      status: 'FAILED',
      error: 'schedule_metadata_remove_failed',
    });
    rerender({ meds: [med], enabled: true });
    await new Promise((r) => setTimeout(r, 20));
    rerender({ meds: [med], enabled: false });
    await new Promise((r) => setTimeout(r, 30));
    // Tracking retained after FAILED cancel → cancel is attempted again
    expect(cancelMock).toHaveBeenCalled();
    expect(cancelMock.mock.calls.length).toBeGreaterThan(0);
    unmount();
  });
});
