/**
 * Issue #217 — fail-closed JS reconciliation:
 * if invalidateAutoDeductionRecurrence fails, cancelAutoDeduction must NOT run.
 *
 * Current contract notes:
 * - Scheduling/cancellation decisions run against DURABLE medication state
 *   re-read inside withAutoStockMutationGate, so tests seed localStorage
 *   (STORAGE_MEDS_KEY/STORAGE_LOGS_KEY). Per-medication Auto (not the global
 *   flag) decides whether an occurrence is still desired.
 * - Destructive reconciliation is driven by the authoritative native list:
 *   the retry source for a skipped cancel is the native row re-appearing in
 *   listScheduledAutoDeductionOccurrences on a later pass (a tracked key that
 *   disappeared from a successful native snapshot is already absent natively
 *   and is dropped without cancel).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication } from '../../src/types';
import {
  STORAGE_MEDS_KEY,
  STORAGE_LOGS_KEY,
} from '../../src/utils/autoDeductionStockGate';

const cancelMock = vi.fn();
const scheduleMock = vi.fn();
const invalidateMock = vi.fn();
const listScheduledMock = vi.fn();

vi.mock('../../src/utils/autoDeductionNativeScheduling', () => ({
  cancelAutoDeduction: (...args: unknown[]) => cancelMock(...args),
  scheduleAutoDeduction: (...args: unknown[]) => scheduleMock(...args),
  invalidateAutoDeductionRecurrence: (...args: unknown[]) => invalidateMock(...args),
}));

vi.mock('../../src/utils/autoDeductionNativeRecovery', () => ({
  listScheduledAutoDeductionOccurrences: (...args: unknown[]) =>
    listScheduledMock(...args),
  restoreFutureAutoDeductionSchedules: () =>
    Promise.resolve({ ok: true, restored: 0, failed: 0 }),
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
    // Late-evening slot: today's occurrence is future for almost the whole
    // day and tomorrow's is always future, so the desired set is never empty.
    doseSchedule: [
      { id: 'd1', amount: 1, time: '23:59' },
    ],
    ...over,
  };
}

/** A native-listed occurrence that is never in today's/tomorrow's desired set. */
const staleListedRow = {
  medicationId: 'med-1',
  doseId: 'd1',
  calendarDate: '2099-01-01',
  timeHhmm: '23:59',
  amount: 1,
};

function persistDurableMeds(meds: Medication[]) {
  localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify(meds));
  localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
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
    localStorage.clear();
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
      schedules: [staleListedRow],
    });
    invalidateMock.mockResolvedValue({
      ok: false,
      error: 'recurrence_generation_commit_failed',
    });

    persistDurableMeds([med]);
    const { rerender, unmount } = renderHook(
      (props: { meds: Medication[]; enabled: boolean }) =>
        useAutoDeductionScheduler({
          medications: props.meds,
          globalAutoDeductEnabled: props.enabled,
          hydrated: true,
          isFirstRun: false,
          exactAlarmPermission: 'granted',
        }),
      { initialProps: { meds: [med], enabled: true } }
    );

    await wait(40);

    // Disable Auto on the DURABLE medication → the listed occurrence is no
    // longer desired → invalidate must run and (only if ok) cancel follows.
    persistDurableMeds([{ ...med, autoDeductEnabled: false }]);
    invalidateMock.mockClear();
    cancelMock.mockClear();
    invalidateMock.mockResolvedValue({
      ok: false,
      error: 'recurrence_generation_commit_failed',
    });

    rerender({ meds: [med], enabled: false });
    await wait(50);

    // invalidate attempted; cancel skipped — native row was not cancelled.
    expect(invalidateMock).toHaveBeenCalledWith('med-1', 'd1');
    expect(cancelMock).not.toHaveBeenCalled();

    // Later reconciliation re-discovers the same native schedule (still listed).
    // Retry source = listScheduledAutoDeductionOccurrences, not trackedRef.
    listScheduledMock.mockResolvedValue({
      ok: true,
      schedules: [staleListedRow],
    });
    invalidateMock.mockResolvedValue({ ok: true, generation: 3 });

    // Trigger another reconcile pass (signature change via enable → disable;
    // durable medication stays disabled so the row remains undesired).
    rerender({ meds: [med], enabled: true });
    await wait(40);
    invalidateMock.mockClear();
    cancelMock.mockClear();
    invalidateMock.mockResolvedValue({ ok: true, generation: 3 });
    rerender({ meds: [med], enabled: false });
    await wait(50);

    expect(invalidateMock).toHaveBeenCalledWith('med-1', 'd1');
    expect(cancelMock).toHaveBeenCalledWith('med-1', 'd1', '2099-01-01');

    unmount();
  });

  it('calls cancel only after a successful invalidate on the listed-occurrence path (ordering)', async () => {
    // Native list initially empty so the first pass is a pure schedule pass.
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [] });
    const med = baseMed();
    persistDurableMeds([med]);

    const { rerender, unmount } = renderHook(
      (props: { meds: Medication[]; enabled: boolean }) =>
        useAutoDeductionScheduler({
          medications: props.meds,
          globalAutoDeductEnabled: props.enabled,
          hydrated: true,
          isFirstRun: false,
          exactAlarmPermission: 'granted',
        }),
      { initialProps: { meds: [med], enabled: true } }
    );

    await wait(40);
    expect(scheduleMock).toHaveBeenCalled();

    // Durable Auto disabled + native lists the occurrence → invalidate gate
    // applies. First pass: invalidate FAILS → cancel must not run.
    persistDurableMeds([{ ...med, autoDeductEnabled: false }]);
    listScheduledMock.mockResolvedValue({
      ok: true,
      schedules: [staleListedRow],
    });
    invalidateMock.mockClear();
    cancelMock.mockClear();
    invalidateMock.mockResolvedValue({
      ok: false,
      error: 'recurrence_generation_commit_failed',
    });

    rerender({ meds: [med], enabled: false });
    await wait(50);

    expect(invalidateMock).toHaveBeenCalledWith('med-1', 'd1');
    expect(cancelMock).not.toHaveBeenCalled();

    // Retry with a successful invalidate → cancel runs, strictly AFTER the
    // successful invalidate (recurrence generation bumped first).
    invalidateMock.mockClear();
    cancelMock.mockClear();
    invalidateMock.mockResolvedValue({ ok: true, generation: 2 });

    rerender({ meds: [med], enabled: true });
    await wait(40);
    invalidateMock.mockClear();
    cancelMock.mockClear();
    invalidateMock.mockResolvedValue({ ok: true, generation: 2 });
    rerender({ meds: [med], enabled: false });
    await wait(50);

    expect(invalidateMock).toHaveBeenCalledWith('med-1', 'd1');
    expect(cancelMock).toHaveBeenCalledWith('med-1', 'd1', '2099-01-01');
    expect(invalidateMock.mock.invocationCallOrder[0]).toBeLessThan(
      cancelMock.mock.invocationCallOrder[0]
    );
    unmount();
  });
});
