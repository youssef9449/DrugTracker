import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication } from '../../src/types';
import {
  STORAGE_GLOBAL_AUTO_DEDUCT_KEY,
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
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    doseSchedule: [{ id: 'd1', amount: 1, time: '23:59' }],
    ...over,
  };
}

function persistDurableState(meds: Medication[], global: boolean) {
  localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify(meds));
  localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
  localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, global ? 'true' : 'false');
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('useAutoDeductionScheduler — global kill switch', () => {
  beforeEach(() => {
    localStorage.clear();
    cancelMock.mockReset();
    scheduleMock.mockReset();
    invalidateMock.mockReset();
    listScheduledMock.mockReset();
    cancelMock.mockResolvedValue({ ok: true, status: 'SUCCESS' });
    invalidateMock.mockResolvedValue({ ok: true, generation: 2 });
    scheduleMock.mockResolvedValue({ ok: true });
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Global OFF keeps a per-med ON preference intact, arms nothing, and cancels native Auto occurrences', async () => {
    const med = baseMed({ autoDeductEnabled: true });
    const staleRow = {
      medicationId: med.id,
      doseId: 'd1',
      calendarDate: '2099-01-01',
      timeHhmm: '23:59',
      amount: 1,
    };
    persistDurableState([med], false);
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [staleRow] });

    const { rerender, unmount } = renderHook(
      (props: { enabled: boolean; tick: number }) =>
        useAutoDeductionScheduler({
          medications: [med],
          globalAutoDeductEnabled: props.enabled,
          hydrated: true,
          isFirstRun: false,
          exactAlarmPermission: 'granted',
          resumeTick: props.tick,
        }),
      { initialProps: { enabled: false, tick: 0 } }
    );

    await wait();
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(invalidateMock).toHaveBeenCalledWith('med-1', 'd1');
    expect(cancelMock).toHaveBeenCalledWith('med-1', 'd1', '2099-01-01');
    expect(JSON.parse(localStorage.getItem(STORAGE_MEDS_KEY) ?? '[]')[0].autoDeductEnabled).toBe(true);
    expect(localStorage.getItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY)).toBe('false');

    unmount();
  });

  it('Global ON re-arms only medications whose own Auto preference is ON', async () => {
    const enabledMed = baseMed({ id: 'on', autoDeductEnabled: true });
    const disabledMed = baseMed({ id: 'off', autoDeductEnabled: false });
    persistDurableState([enabledMed, disabledMed], true);

    const { unmount } = renderHook(() =>
      useAutoDeductionScheduler({
        medications: [enabledMed, disabledMed],
        globalAutoDeductEnabled: true,
        hydrated: true,
        isFirstRun: false,
        exactAlarmPermission: 'granted',
      })
    );

    await wait();
    const scheduledIds = new Set(
      scheduleMock.mock.calls.map((call) =>
        (call[0] as { medicationId: string }).medicationId
      )
    );
    expect(scheduledIds.has('on')).toBe(true);
    expect(scheduledIds.has('off')).toBe(false);
    unmount();
  });

  it('Global OFF → ON resumes scheduling from the unchanged per-med preferences', async () => {
    const enabledMed = baseMed({ id: 'on', autoDeductEnabled: true });
    const disabledMed = baseMed({ id: 'off', autoDeductEnabled: false });
    persistDurableState([enabledMed, disabledMed], false);

    const { rerender, unmount } = renderHook(
      (props: { enabled: boolean; tick: number }) =>
        useAutoDeductionScheduler({
          medications: [enabledMed, disabledMed],
          globalAutoDeductEnabled: props.enabled,
          hydrated: true,
          isFirstRun: false,
          exactAlarmPermission: 'granted',
          resumeTick: props.tick,
        }),
      { initialProps: { enabled: false, tick: 0 } }
    );

    await wait();
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(enabledMed.autoDeductEnabled).toBe(true);
    expect(disabledMed.autoDeductEnabled).toBe(false);

    persistDurableState([enabledMed, disabledMed], true);
    rerender({ enabled: true, tick: 1 });
    await wait();

    const scheduledIds = new Set(
      scheduleMock.mock.calls.map((call) =>
        (call[0] as { medicationId: string }).medicationId
      )
    );
    expect(scheduledIds.has('on')).toBe(true);
    expect(scheduledIds.has('off')).toBe(false);
    expect(enabledMed.autoDeductEnabled).toBe(true);
    expect(disabledMed.autoDeductEnabled).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_MEDS_KEY) ?? '[]').map(
      (m: Medication) => m.autoDeductEnabled
    )).toEqual([true, false]);

    unmount();
  });

  it('Global OFF prevents a stale queued schedule from reaching the native bridge after the durable kill switch is disabled', async () => {
    const med = baseMed();
    persistDurableState([med], true);
    let releaseSchedule: (() => void) | undefined;
    scheduleMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSchedule = () => resolve({ ok: true });
        })
    );
    listScheduledMock.mockResolvedValue({ ok: true, schedules: [] });

    const { rerender, unmount } = renderHook(
      (props: { enabled: boolean; tick: number }) =>
        useAutoDeductionScheduler({
          medications: [med],
          globalAutoDeductEnabled: props.enabled,
          hydrated: true,
          isFirstRun: false,
          exactAlarmPermission: 'granted',
          resumeTick: props.tick,
        }),
      { initialProps: { enabled: true, tick: 0 } }
    );

    await wait();
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    // Flip the durable kill switch while the first native schedule is in flight.
    localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'false');
    rerender({ enabled: false, tick: 1 });
    releaseSchedule?.();
    await wait();

    // The in-flight stale call may complete, but no newer stale schedule is
    // allowed through the final durable gate while Global OFF.
    const laterScheduleCalls = scheduleMock.mock.calls.slice(1);
    expect(laterScheduleCalls).toHaveLength(0);
    unmount();
  });
});
