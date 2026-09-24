/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushUntil } from '../helpers/asyncTestUtils';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '@/types';

import { useDoseReminderScheduler } from '@/hooks/useDoseReminderScheduler';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { ExactAlarmPermission } from '@/utils/exactAlarm';

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: vi.fn(() => 'web') },
  registerPlugin: () => ({
    getNextOccurrence: () => Promise.resolve({ valid: false, nextOccurrenceMs: 0 }),
    clearReArm: () => Promise.resolve({ ok: true }),
  }),
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: vi.fn(),
    cancel: vi.fn(),
    checkPermissions: vi.fn(),
    checkExactNotificationSetting: vi.fn(),
    getPending: vi.fn(),
  },
}));

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  cancelSnoozed: vi.fn(),
  isPending: vi.fn(),
  isNativeReArmed: vi.fn(),
  cancelStale: vi.fn(),
}));

vi.mock('@/utils/doseReminderScheduling', async () => {
  const actual = await vi.importActual<typeof import('@/utils/doseReminderScheduling')>(
    '@/utils/doseReminderScheduling'
  );
  return {
    ...actual,
    scheduleDoseReminder: mocks.schedule,
    cancelDoseReminder: mocks.cancel,
    isDoseReminderPending: mocks.isPending,
    isNativeDoseReminderReArmed: mocks.isNativeReArmed,
    // cancelStaleDoseReminderAlarms: NOT mocked — real implementation runs
    // so the test can verify actual IDs sent to LocalNotifications.cancel.
  };
});

vi.mock('@/utils/notifications/doseReminderNotifications', async () => {
  const actual = await vi.importActual<
    typeof import('@/utils/notifications/doseReminderNotifications')
  >('@/utils/notifications/doseReminderNotifications');
  return {
    ...actual,
    cancelSnoozedDoseReminder: mocks.cancelSnoozed,
  };
});

function makeMed(overrides: Partial<Medication> = {}): Medication {
  const reminderTime = overrides.reminderTime ?? '09:00';
  const dailyDose = overrides.dailyDose ?? 1;
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 30,
    dailyDose,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    reminderEnabled: true,
    reminderTime,
    // Explicit single-slot schedule so reminder slots are defined by doseSchedule.
    doseSchedule: [{ id: 'd1', amount: dailyDose, time: reminderTime }],
    dosesPerDay: 1,
    ...overrides,
  };
}



function capabilityMap(medications: Medication[]): ReadonlyMap<string, boolean> {
  return new Map(medications.map((medication) => [
    medication.id,
    medication.autoDeductEnabled === false,
  ]));
}

function defaultOpts(overrides: Record<string, unknown> = {}) {
  const medications =
    (overrides.medications as Medication[] | undefined) ?? [];
  return {
    medications,
    allowManualTakeActionByMedicationId: capabilityMap(medications),
    notificationsEnabled: true,
    hydrated: true,
    isFirstRun: false,
    exactAlarmPermission: 'granted' as ExactAlarmPermission | null,
    resumeTick: 0 as number | undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  mocks.schedule.mockReset();
  mocks.cancel.mockReset();
  mocks.cancelSnoozed.mockReset();
  mocks.isPending.mockReset();
  mocks.isNativeReArmed.mockReset();
  mocks.cancel.mockResolvedValue(undefined);
  mocks.cancelSnoozed.mockResolvedValue(undefined);
  mocks.schedule.mockResolvedValue(undefined);
  mocks.isPending.mockResolvedValue({ ok: true, pending: false });
  mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
  // Default: no pending notifications (web platform / no stale alarms).
  vi.mocked(LocalNotifications.getPending).mockResolvedValue({ notifications: [] });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});




describe('useDoseReminderScheduler — native state lookup failures', () => {
  it('retries a pending-state lookup failure without scheduling before the retry', async () => {
    const med = makeMed({ id: 'med-pending-failure', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ lifecycleTick }: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med], lifecycleTick })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    mocks.schedule.mockClear();
    mocks.isPending.mockResolvedValueOnce({
      ok: false,
      error: 'pending_lookup_failed',
      errorCode: 'platform_failure',
    });
    mocks.isPending.mockResolvedValue({
      ok: true,
      pending: true,
    });

    rerender({ lifecycleTick: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.schedule).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('retries a re-arm lookup failure without requiring a medication edit', async () => {
    const med = makeMed({ id: 'med-rearm-failure', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ lifecycleTick }: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med], lifecycleTick })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    mocks.schedule.mockClear();

    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValueOnce({
      ok: false,
      error: 'rearm_lookup_failed',
      errorCode: 'platform_failure',
    });
    mocks.isNativeReArmed.mockResolvedValue({
      ok: true,
      scheduled: true,
    });

    rerender({ lifecycleTick: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.schedule).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

describe('useDoseReminderScheduler — cancellation', () => {
  it('cancels the alarm when a med is removed from the list', async () => {
    const med = makeMed({ id: 'med-del', reminderTime: '09:00' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    rerender({ medications: [] });
    await flushUntil(() => mocks.cancel.mock.calls.some((c) => c[0] === 'med-del'));

    expect(mocks.cancel).toHaveBeenCalledWith('med-del', 'd1');
  });

  it('cancels all alarms when notificationsEnabled is turned off', async () => {
    const med1 = makeMed({ id: 'med-off1', reminderTime: '09:00' });
    const med2 = makeMed({ id: 'med-off2', reminderTime: '10:00' });
    const { rerender } = renderHook(
      ({ notificationsEnabled }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med1, med2], notificationsEnabled })
        ),
      { initialProps: { notificationsEnabled: true } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);

    rerender({ notificationsEnabled: false });
    await flushUntil(() => mocks.cancel.mock.calls.length >= 2);

    expect(mocks.cancel).toHaveBeenCalledWith('med-off1', 'd1');
    expect(mocks.cancel).toHaveBeenCalledWith('med-off2', 'd1');
  });
});

describe('useDoseReminderScheduler — operation retries', () => {
  it('retries a transient schedule failure without a medication edit', async () => {
    const initial = makeMed({
      id: 'med-schedule-retry',
      reminderTime: '20:00',
    });
    const { rerender } = renderHook(
      ({ medication }: { medication: Medication }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [medication] })
        ),
      { initialProps: { medication: initial } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    mocks.schedule.mockClear();

    mocks.schedule.mockRejectedValueOnce(new Error('transient schedule failure'));
    mocks.schedule.mockResolvedValue(undefined);
    const replacement = {
      ...initial,
      reminderTime: '21:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '21:00' }],
    };
    rerender({ medication: replacement });

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    expect(mocks.schedule).toHaveBeenCalledTimes(2);
  });

  it('retries a transient cancellation failure and keeps the removal discoverable', async () => {
    const med = makeMed({ id: 'med-cancel-retry', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ medications }: { medications: Medication[] }) =>
        useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    mocks.cancel.mockClear();
    mocks.cancel.mockRejectedValueOnce(new Error('transient cancel failure'));
    mocks.cancel.mockResolvedValue(undefined);

    rerender({ medications: [] });
    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushUntil(() => mocks.cancel.mock.calls.length >= 2);
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
  });
});

