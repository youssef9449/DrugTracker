/**
 * Issue #242 — scheduler fail-closed on native schedule list read failure.
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

describe('useAutoDeductionScheduler native list failure (Issue #242)', () => {
  beforeEach(() => {
    cancelMock.mockReset();
    scheduleMock.mockReset();
    invalidateMock.mockReset();
    listScheduledMock.mockReset();
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
    const { unmount } = renderHook(() =>
      useAutoDeductionScheduler({
        medications: [med],
        globalAutoDeductEnabled: true,
        hydrated: true,
        isFirstRun: false,
        exactAlarmEnabled: true,
      })
    );
    await wait(40);
    expect(listScheduledMock).toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
    unmount();
  });

  it('list failure with populated trackedRef does not invalidate/cancel; recovers on success', async () => {
    const med = baseMed();
    const stale = {
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2099-06-01',
      timeHhmm: '08:00',
      amount: 1,
    };

    // ── Pass 1: auto ON → schedule succeeds → trackedRef gains the occurrence ──
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [] });
    scheduleMock.mockResolvedValue({ ok: true });

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
          exactAlarmEnabled: true,
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

    await wait(50);
    expect(scheduleMock).toHaveBeenCalled();
    // No destructive cancel while schedules are desired.
    expect(cancelMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();

    // ── Pass 2: desired empty + native list FAILS ──
    // trackedRef still holds prior schedules; without fail-closed, the scheduler
    // would invalidate+cancel them. Must not.
    cancelMock.mockClear();
    invalidateMock.mockClear();
    scheduleMock.mockClear();
    listScheduledMock.mockResolvedValue({
      ok: false,
      schedules: [],
      error: 'list_schedules_failed',
    });

    rerender({ enabled: false, resumeTick: 1, meds: [med] });
    await wait(50);

    expect(listScheduledMock).toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();

    // ── Pass 3: list succeeds with durable stale row → normal #217 cancel path ──
    cancelMock.mockClear();
    invalidateMock.mockClear();
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [stale] });
    invalidateMock.mockResolvedValue({ ok: true, generation: 3 });
    cancelMock.mockResolvedValue({ ok: true, status: 'SUCCESS' });

    rerender({ enabled: false, resumeTick: 2, meds: [med] });
    await wait(50);

    expect(invalidateMock).toHaveBeenCalledWith('med-1', 'd1');
    expect(cancelMock).toHaveBeenCalledWith('med-1', 'd1', '2099-06-01');
    unmount();
  });

  it('later successful reconciliation discovers and cancels stale native schedule', async () => {
    const med = baseMed();
    const stale = {
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2099-06-01',
      timeHhmm: '08:00',
      amount: 1,
    };

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
          exactAlarmEnabled: true,
          resumeTick: props.resumeTick,
        }),
      { initialProps: { resumeTick: 0 } }
    );

    await wait(40);
    expect(cancelMock).not.toHaveBeenCalled();

    cancelMock.mockClear();
    invalidateMock.mockClear();
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [stale] });
    invalidateMock.mockResolvedValue({ ok: true, generation: 3 });
    cancelMock.mockResolvedValue({ ok: true, status: 'SUCCESS' });

    rerender({ resumeTick: 1 });
    await wait(50);

    expect(invalidateMock).toHaveBeenCalledWith('med-1', 'd1');
    expect(cancelMock).toHaveBeenCalledWith('med-1', 'd1', '2099-06-01');
    unmount();
  });
});
