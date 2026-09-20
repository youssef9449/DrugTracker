/**
 * Issue #217 — fail-closed JS reconciliation:
 * if invalidateAutoDeductionRecurrence fails, cancelAutoDeduction must NOT run.
 *
 * Retry sources (two independent paths):
 * 1) nativeSchedules path — schedule stays in listScheduledAutoDeductionOccurrences()
 *    (cancel was skipped), so a later pass re-discovers it. Not trackedRef.
 * 2) trackedRef path — covered by the second test when native list is empty.
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
  invalidateAutoDeductionRecurrence: (...args: unknown[]) => invalidateMock(...args),
  listScheduledAutoDeductionOccurrences: (...args: unknown[]) =>
    listScheduledMock(...args),
  autoDeductionOccurrenceKey: (m: string, d: string, c: string) =>
    `${m}\u001f${d}\u001f${c}`,
}));

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
    autoDeductEnabled: true,
    reminderTime: '10:00',
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 1, time: '20:00' },
    ],
    ...over,
  };
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('useAutoDeductionScheduler invalidate-before-cancel (Issue #217)', () => {
  beforeEach(() => {
    cancelMock.mockReset();
    scheduleMock.mockReset();
    invalidateMock.mockReset();
    listScheduledMock.mockReset();
    scheduleMock.mockResolvedValue({ ok: true });
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [] });
    cancelMock.mockResolvedValue({ ok: true, status: 'SUCCESS' });
    invalidateMock.mockResolvedValue({ ok: true, generation: 2 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not cancel when invalidate fails; native schedule remains available for later reconciliation', async () => {
    const med = baseMed();
    // Native still holds a schedule that is no longer desired after disable.
    // Retry is via re-listing this schedule — NOT via trackedRef on this path.
    listScheduledMock.mockResolvedValue({
      ok: true,
      schedules: [
        {
          medicationId: 'med-1',
          doseId: 'd1',
          calendarDate: '2099-01-01',
          timeHhmm: '08:00',
          amount: 1,
        },
      ],
    });
    invalidateMock.mockResolvedValue({
      ok: false,
      error: 'recurrence_generation_commit_failed',
    });

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

    await wait(30);

    // Disable auto-deduct → desired empty → invalidate then (only if ok) cancel.
    cancelMock.mockClear();
    invalidateMock.mockClear();
    listScheduledMock.mockResolvedValue({
      ok: true,
      schedules: [
        {
          medicationId: 'med-1',
          doseId: 'd1',
          calendarDate: '2099-01-01',
          timeHhmm: '08:00',
          amount: 1,
        },
      ],
    });
    invalidateMock.mockResolvedValue({
      ok: false,
      error: 'recurrence_generation_commit_failed',
    });

    rerender({ meds: [med], enabled: false });
    await wait(40);

    // invalidate attempted; cancel skipped — native row was not cancelled.
    expect(invalidateMock).toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();

    // Later reconciliation re-discovers the same native schedule (still listed).
    // Retry source = listScheduledAutoDeductionOccurrences, not trackedRef.
    cancelMock.mockClear();
    invalidateMock.mockClear();
    listScheduledMock.mockResolvedValue({
      ok: true,
      schedules: [
        {
          medicationId: 'med-1',
          doseId: 'd1',
          calendarDate: '2099-01-01',
          timeHhmm: '08:00',
          amount: 1,
        },
      ],
    });
    invalidateMock.mockResolvedValue({ ok: true, generation: 3 });

    // Trigger another reconcile pass (signature change via enable → disable).
    rerender({ meds: [med], enabled: true });
    await wait(20);
    cancelMock.mockClear();
    invalidateMock.mockClear();
    listScheduledMock.mockResolvedValue({
      ok: true,
      schedules: [
        {
          medicationId: 'med-1',
          doseId: 'd1',
          calendarDate: '2099-01-01',
          timeHhmm: '08:00',
          amount: 1,
        },
      ],
    });
    invalidateMock.mockResolvedValue({ ok: true, generation: 3 });
    rerender({ meds: [med], enabled: false });
    await wait(40);

    expect(invalidateMock).toHaveBeenCalled();
    expect(cancelMock).toHaveBeenCalledWith('med-1', 'd1', '2099-01-01');

    unmount();
  });

  it('calls cancel only after successful invalidate on tracked-only path', async () => {
    // Empty native list so cancellation comes from trackedRef after a schedule pass.
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [] });
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

    await wait(30);
    expect(scheduleMock).toHaveBeenCalled();

    invalidateMock.mockResolvedValueOnce({
      ok: false,
      error: 'recurrence_generation_commit_failed',
    });
    cancelMock.mockClear();
    invalidateMock.mockClear();
    invalidateMock.mockResolvedValue({
      ok: false,
      error: 'recurrence_generation_commit_failed',
    });

    rerender({ meds: [med], enabled: false });
    await wait(40);

    expect(invalidateMock).toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();

    // Retry with success
    invalidateMock.mockResolvedValue({ ok: true, generation: 2 });
    cancelMock.mockClear();
    invalidateMock.mockClear();
    invalidateMock.mockResolvedValue({ ok: true, generation: 2 });

    // Trigger another pass: enable then disable
    rerender({ meds: [med], enabled: true });
    await wait(20);
    cancelMock.mockClear();
    invalidateMock.mockClear();
    invalidateMock.mockResolvedValue({ ok: true, generation: 2 });
    rerender({ meds: [med], enabled: false });
    await wait(40);

    expect(invalidateMock).toHaveBeenCalled();
    expect(cancelMock).toHaveBeenCalled();
    unmount();
  });
});
