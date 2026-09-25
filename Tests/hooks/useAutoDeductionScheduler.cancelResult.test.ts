/**
 * Phase 2 — JS scheduler must respect CancelResult from native.
 * SUCCESS / ALREADY_ABSENT → occurrence reaches terminal state (no retry)
 * FAILED → retain retry path (re-attempted while native still lists the row)
 *
 * Current contract notes:
 * - Scheduling/cancellation decisions are executed against DURABLE
 *   medication state re-read inside withAutoStockMutationGate, so tests seed
 *   localStorage (STORAGE_MEDS_KEY/STORAGE_LOGS_KEY) instead of relying on
 *   React props alone.
 * - Destructive reconciliation is driven by the authoritative native list:
 *   a native-listed occurrence that is no longer desired is invalidated then
 *   cancelled. Per-medication Auto (not the global flag) decides desire.
 *
 * These tests mock the native bridge; they do not require Android runtime.
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
  invalidateAutoDeductionRecurrence: (...args: unknown[]) =>
    invalidateMock(...args),
}));

vi.mock('../../src/utils/autoDeductionNativeRecovery', () => ({
  listScheduledAutoDeductionOccurrences: (...args: unknown[]) =>
    listScheduledMock(...args),
  restoreFutureAutoDeductionSchedules: () =>
    Promise.resolve({ ok: true, restored: 0, failed: 0 }),
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
    autoDeductEnabled: true,
    reminderTime: '10:00',
    // Late-evening slot: today's occurrence is future for almost the whole
    // day and tomorrow's is always future, so the desired set is never empty.
    doseSchedule: [{ id: 'd1', amount: 1, time: '23:59' }],
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

function scheduledOccurrenceKeys(): Set<string> {
  return new Set(
    scheduleMock.mock.calls.map((c) => {
      const p = c[0] as {
        medicationId: string;
        doseId: string;
        calendarDate: string;
      };
      return `${p.medicationId}::${p.doseId}::${p.calendarDate}`;
    })
  );
}

describe('useAutoDeductionScheduler CancelResult handling', () => {
  beforeEach(() => {
    cancelMock.mockReset();
    scheduleMock.mockReset();
    invalidateMock.mockReset();
    listScheduledMock.mockReset();
    localStorage.clear();
    // Default: invalidate succeeds (recurrence generation bumped), so the
    // scheduler may proceed to cancelAutoDeduction. Native schedule list is
    // empty so the desired-state pass only operates on trackedRef.
    invalidateMock.mockResolvedValue({ ok: true });
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [] });
    scheduleMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('removes tracking when cancel returns ok=true (SUCCESS)', async () => {
    cancelMock.mockResolvedValue({ ok: true, status: 'SUCCESS' });
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

    // Allow chain to schedule
    await new Promise((r) => setTimeout(r, 30));
    expect(scheduleMock).toHaveBeenCalled();

    // Disable Auto on the DURABLE medication (per-med Auto decides desire)
    // while native still lists the previously scheduled occurrence.
    persistDurableMeds([{ ...med, autoDeductEnabled: false }]);
    listScheduledMock.mockResolvedValue({
      ok: true,
      schedules: [staleListedRow],
    });
    rerender({ meds: [med], enabled: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(cancelMock).toHaveBeenCalledWith('med-1', 'd1', '2099-01-01');

    // SUCCESS is terminal: once the row is gone from the native list, later
    // reconciliation passes make no further cancel attempts for it.
    cancelMock.mockClear();
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [] });
    rerender({ meds: [med], enabled: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelMock).not.toHaveBeenCalled();
    unmount();
  });

  it('retains retry path when cancel returns ok=false (FAILED)', async () => {
    cancelMock.mockResolvedValue({
      ok: false,
      status: 'FAILED',
      error: 'schedule_metadata_remove_failed',
    });
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

    await new Promise((r) => setTimeout(r, 30));

    // Disable durable Auto; native still lists the scheduled occurrence →
    // cancel attempted and FAILED.
    persistDurableMeds([{ ...med, autoDeductEnabled: false }]);
    listScheduledMock.mockResolvedValue({
      ok: true,
      schedules: [staleListedRow],
    });
    rerender({ meds: [med], enabled: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledWith('med-1', 'd1', '2099-01-01');

    // FAILED cancel → the occurrence stays listed natively, so a subsequent
    // reconciliation pass retries the cancel (retry path retained).
    rerender({ meds: [med], enabled: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelMock.mock.calls.length).toBeGreaterThan(1);
    expect(cancelMock).toHaveBeenCalledWith('med-1', 'd1', '2099-01-01');
    unmount();
  });
});

describe('Exact Auto scheduler signature ignores dailyDose/reminder fields', () => {
  beforeEach(() => {
    cancelMock.mockReset();
    scheduleMock.mockReset();
    invalidateMock.mockReset();
    listScheduledMock.mockReset();
    localStorage.clear();
    invalidateMock.mockResolvedValue({ ok: true });
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [] });
    scheduleMock.mockResolvedValue({ ok: true });
    cancelMock.mockResolvedValue({ ok: true, status: 'SUCCESS' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function scheduledMed(over: Partial<Medication> = {}): Medication {
    return baseMed({
      autoDeductEnabled: true,
      dailyDose: 1,
      reminderEnabled: true,
      reminderTime: '20:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '23:59' }],
      dosesPerDay: 1,
      ...over,
    });
  }

  async function settle() {
    await new Promise((r) => setTimeout(r, 40));
  }

  it('dailyDose change does not cancel or alter desired Exact occurrences when doseSchedule is unchanged', async () => {
    const med = scheduledMed();
    persistDurableMeds([med]);
    const { rerender, unmount } = renderHook(
      (props: { meds: Medication[] }) =>
        useAutoDeductionScheduler({
          medications: props.meds,
          globalAutoDeductEnabled: true,
          hydrated: true,
          isFirstRun: false,
          exactAlarmPermission: 'granted',
        }),
      { initialProps: { meds: [med] } }
    );
    await settle();
    const keysAfter = scheduledOccurrenceKeys();
    expect(keysAfter.size).toBeGreaterThan(0);
    const cancelAfter = cancelMock.mock.calls.length;
    const invalidateAfter = invalidateMock.mock.calls.length;

    rerender({ meds: [{ ...med, dailyDose: med.dailyDose + 99 }] });
    await settle();
    // Desired occurrence set is unchanged → same identities re-armed, and
    // NO destructive invalidate/cancel is triggered by the field change.
    expect(scheduledOccurrenceKeys()).toEqual(keysAfter);
    expect(cancelMock.mock.calls.length).toBe(cancelAfter);
    expect(invalidateMock.mock.calls.length).toBe(invalidateAfter);
    unmount();
  });

  it('reminderTime change does not cancel or alter desired Exact occurrences when doseSchedule is unchanged', async () => {
    const med = scheduledMed();
    persistDurableMeds([med]);
    const { rerender, unmount } = renderHook(
      (props: { meds: Medication[] }) =>
        useAutoDeductionScheduler({
          medications: props.meds,
          globalAutoDeductEnabled: true,
          hydrated: true,
          isFirstRun: false,
          exactAlarmPermission: 'granted',
        }),
      { initialProps: { meds: [med] } }
    );
    await settle();
    const keysAfter = scheduledOccurrenceKeys();
    const cancelAfter = cancelMock.mock.calls.length;
    const invalidateAfter = invalidateMock.mock.calls.length;

    rerender({
      meds: [
        {
          ...med,
          reminderTime: '21:00',
          doseSchedule: [{ id: 'd1', amount: 1, time: '23:59' }],
        },
      ],
    });
    await settle();
    expect(scheduledOccurrenceKeys()).toEqual(keysAfter);
    expect(cancelMock.mock.calls.length).toBe(cancelAfter);
    expect(invalidateMock.mock.calls.length).toBe(invalidateAfter);
    unmount();
  });

  it('reminderEnabled change does not cancel or alter desired Exact occurrences when doseSchedule is unchanged', async () => {
    const med = scheduledMed({ reminderEnabled: true });
    persistDurableMeds([med]);
    const { rerender, unmount } = renderHook(
      (props: { meds: Medication[] }) =>
        useAutoDeductionScheduler({
          medications: props.meds,
          globalAutoDeductEnabled: true,
          hydrated: true,
          isFirstRun: false,
          exactAlarmPermission: 'granted',
        }),
      { initialProps: { meds: [med] } }
    );
    await settle();
    const keysAfter = scheduledOccurrenceKeys();
    const cancelAfter = cancelMock.mock.calls.length;
    const invalidateAfter = invalidateMock.mock.calls.length;

    rerender({ meds: [{ ...med, reminderEnabled: false }] });
    await settle();
    expect(scheduledOccurrenceKeys()).toEqual(keysAfter);
    expect(cancelMock.mock.calls.length).toBe(cancelAfter);
    expect(invalidateMock.mock.calls.length).toBe(invalidateAfter);
    unmount();
  });
});
