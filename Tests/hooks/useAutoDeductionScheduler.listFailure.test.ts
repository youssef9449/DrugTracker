/**
 * Issue #242 — scheduler fail-closed on native schedule list read failure.
 *
 * Current contract notes:
 * - The native list is the authoritative durable snapshot: a FAILED list
 *   never collapses into "empty" — no invalidate/cancel runs from tracked
 *   state in that pass, and desired scheduling is skipped (fail-closed).
 * - Scheduling/cancellation decisions run against DURABLE medication state
 *   re-read inside withAutoStockMutationGate, so tests seed localStorage
 *   (STORAGE_MEDS_KEY/STORAGE_LOGS_KEY). Per-medication Auto decides desire.
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
  calendarDate: '2099-06-01',
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

describe('useAutoDeductionScheduler native list failure (Issue #242)', () => {
  beforeEach(() => {
    cancelMock.mockReset();
    scheduleMock.mockReset();
    invalidateMock.mockReset();
    listScheduledMock.mockReset();
    localStorage.clear();
    scheduleMock.mockResolvedValue({ ok: true });
    cancelMock.mockResolvedValue({ ok: true, status: 'SUCCESS' });
    invalidateMock.mockResolvedValue({ ok: true, generation: 2 });
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('successful empty native list continues without destructive cancel', async () => {
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [] });
    const med = baseMed();
    persistDurableMeds([med]);
    const { unmount } = renderHook(() =>
      useAutoDeductionScheduler({
        medications: [med],
        globalAutoDeductEnabled: true,
        hydrated: true,
        isFirstRun: false,
        exactAlarmPermission: 'granted',
      })
    );
    await wait(50);
    expect(listScheduledMock).toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
    unmount();
  });

  it('list failure with populated trackedRef does not invalidate/cancel; recovers on success', async () => {
    const med = baseMed();
    const disabledMed = { ...med, autoDeductEnabled: false };

    // ── Pass 1: Auto ON → schedule succeeds → occurrence is armed ──
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [] });
    scheduleMock.mockResolvedValue({ ok: true });

    persistDurableMeds([med]);
    const { rerender, unmount } = renderHook(
      (props: {
        enabled: boolean;
        resumeTick: number;
        meds: Medication[];
      }) =>
        useAutoDeductionScheduler({
          medications: props.meds,
          globalAutoDeductEnabled: props.enabled,
          hydrated: true,
          isFirstRun: false,
          exactAlarmPermission: 'granted',
          resumeTick: props.resumeTick,
        }),
      {
        initialProps: {
          enabled: true,
          resumeTick: 0,
          meds: [med],
        },
      }
    );

    await wait(60);
    expect(scheduleMock).toHaveBeenCalled();
    // No destructive cancel while schedules are desired.
    expect(cancelMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();

    // ── Pass 2: native list FAILS ──
    // Without fail-closed, the scheduler would invalidate+cancel armed
    // occurrences. Must not: a failed list is never treated as an empty set.
    cancelMock.mockClear();
    invalidateMock.mockClear();
    scheduleMock.mockClear();
    listScheduledMock.mockResolvedValue({
      ok: false,
      schedules: [],
      error: 'list_schedules_failed',
    });

    rerender({ enabled: false, resumeTick: 1, meds: [med] });
    await wait(60);

    expect(listScheduledMock).toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();

    // ── Pass 3: list succeeds with durable stale row → normal #217 cancel path ──
    cancelMock.mockClear();
    invalidateMock.mockClear();
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [staleListedRow] });
    invalidateMock.mockResolvedValue({ ok: true, generation: 3 });
    cancelMock.mockResolvedValue({ ok: true, status: 'SUCCESS' });
    // Auto disabled durably so the stale row is no longer desired.
    persistDurableMeds([disabledMed]);

    rerender({ enabled: false, resumeTick: 2, meds: [disabledMed] });
    await wait(60);

    expect(invalidateMock).toHaveBeenCalledWith('med-1', 'd1');
    expect(cancelMock).toHaveBeenCalledWith('med-1', 'd1', '2099-06-01');
    unmount();
  });

  it('later successful reconciliation discovers and cancels stale native schedule', async () => {
    // Durable + React Auto disabled: nothing is desired, but native still
    // holds a stale occurrence from an earlier configuration.
    const med = { ...baseMed(), autoDeductEnabled: false };
    persistDurableMeds([med]);

    listScheduledMock.mockResolvedValue({
      ok: false,
      schedules: [],
      error: 'list_schedules_failed',
    });

    const { rerender, unmount } = renderHook(
      (props: { resumeTick: number }) =>
        useAutoDeductionScheduler({
          medications: [med],
          globalAutoDeductEnabled: false,
          hydrated: true,
          isFirstRun: false,
          exactAlarmPermission: 'granted',
          resumeTick: props.resumeTick,
        }),
      { initialProps: { resumeTick: 0 } }
    );

    await wait(50);
    expect(cancelMock).not.toHaveBeenCalled();

    invalidateMock.mockClear();
    cancelMock.mockClear();
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [staleListedRow] });
    invalidateMock.mockResolvedValue({ ok: true, generation: 3 });
    cancelMock.mockResolvedValue({ ok: true, status: 'SUCCESS' });

    rerender({ resumeTick: 1 });
    await wait(60);

    expect(invalidateMock).toHaveBeenCalledWith('med-1', 'd1');
    expect(cancelMock).toHaveBeenCalledWith('med-1', 'd1', '2099-06-01');
    unmount();
  });
});
