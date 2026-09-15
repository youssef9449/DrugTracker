/**
 * Issue #217 — fail-closed JS reconciliation:
 * if invalidateAutoDeductionRecurrence fails, cancelAutoDeduction must NOT run
 * and tracking must be retained for a later pass.
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
    lastSyncDate: '2026-09-14',
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
    listScheduledMock.mockResolvedValue([]);
    cancelMock.mockResolvedValue({ ok: true, status: 'SUCCESS' });
    invalidateMock.mockResolvedValue({ ok: true, generation: 2 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not call cancel when invalidate fails; keeps slot for retry', async () => {
    const med = baseMed();
    // Native still holds a schedule that is no longer desired after disable.
    listScheduledMock.mockResolvedValue([
      {
        medicationId: 'med-1',
        doseId: 'd1',
        calendarDate: '2099-01-01',
        timeHhmm: '08:00',
        amount: 1,
      },
    ]);
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

    // Disable auto-deduct → desired empty → must invalidate then cancel
    cancelMock.mockClear();
    invalidateMock.mockClear();
    listScheduledMock.mockResolvedValue([
      {
        medicationId: 'med-1',
        doseId: 'd1',
        calendarDate: '2099-01-01',
        timeHhmm: '08:00',
        amount: 1,
      },
    ]);
    invalidateMock.mockResolvedValue({
      ok: false,
      error: 'recurrence_generation_commit_failed',
    });

    rerender({ meds: [med], enabled: false });
    await wait(40);

    expect(invalidateMock).toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();

    // Later pass: invalidate succeeds → cancel runs
    cancelMock.mockClear();
    invalidateMock.mockClear();
    invalidateMock.mockResolvedValue({ ok: true, generation: 3 });
    listScheduledMock.mockResolvedValue([
      {
        medicationId: 'med-1',
        doseId: 'd1',
        calendarDate: '2099-01-01',
        timeHhmm: '08:00',
        amount: 1,
      },
    ]);

    // Force another reconcile by toggling exact alarm path via re-enable then disable
    // (signature change). Simpler: re-render enabled true then false again.
    rerender({ meds: [med], enabled: true });
    await wait(20);
    cancelMock.mockClear();
    invalidateMock.mockClear();
    listScheduledMock.mockResolvedValue([
      {
        medicationId: 'med-1',
        doseId: 'd1',
        calendarDate: '2099-01-01',
        timeHhmm: '08:00',
        amount: 1,
      },
    ]);
    invalidateMock.mockResolvedValue({ ok: true, generation: 3 });
    rerender({ meds: [med], enabled: false });
    await wait(40);

    expect(invalidateMock).toHaveBeenCalled();
    expect(cancelMock).toHaveBeenCalledWith('med-1', 'd1', '2099-01-01');

    unmount();
  });

  it('calls cancel only after successful invalidate on tracked-only path', async () => {
    // Empty native list so cancellation comes from trackedRef after a schedule pass.
    listScheduledMock.mockResolvedValue([]);
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
