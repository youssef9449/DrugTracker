/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '@/types';
import { getTodayDateString } from '@/utils/dateCalculations';
import { useDoseReminderScheduler, getDoseReminderSlots } from '@/hooks/useDoseReminderScheduler';
import {
  doseReminderAlarmIdForDose } from '@/utils/notifications';
import { Capacitor } from '@capacitor/core';
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

vi.mock('@/utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('@/utils/notifications')>(
    '@/utils/notifications'
  );
  return {
    ...actual,
    scheduleDoseReminder: mocks.schedule,
    cancelDoseReminder: mocks.cancel,
    cancelSnoozedDoseReminder: mocks.cancelSnoozed,
    isDoseReminderPending: mocks.isPending,
    isNativeDoseReminderReArmed: mocks.isNativeReArmed,
    // cancelStaleDoseReminderAlarms: NOT mocked — real implementation runs
    // so the test can verify actual IDs sent to LocalNotifications.cancel.
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
  return new Map(
    medications.map((med) => [med.id, med.autoDeductEnabled === false])
  );
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

async function flushUntil(predicate: () => boolean, maxIterations = 20): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
}

describe('useDoseReminderScheduler — basic scheduling', () => {
  it('schedules a recurring dose reminder for each med with reminderEnabled + reminderTime', async () => {
    const med1 = makeMed({ id: 'med-a', name: 'A', reminderTime: '08:00' });
    const med2 = makeMed({ id: 'med-b', name: 'B', reminderTime: '14:00' });

    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med1, med2] })));

    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);

    expect(mocks.schedule).toHaveBeenCalledTimes(2);
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-a', 'A', '08:00', 1, 'قرص', 'd1'
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-b', 'B', '14:00', 1, 'قرص', 'd1'
    );
  });

  it('cancels then reschedules (stable id) on mount', async () => {
    const med = makeMed({ id: 'med-x', reminderTime: '09:00' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    expect(mocks.cancel).toHaveBeenCalledWith('med-x', 'd1');
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-x', 'Test Med', '09:00', 1, 'قرص'
    );
  });
});

describe('useDoseReminderScheduler — gating', () => {
  it('does NOT schedule before hydration', () => {
    const med = makeMed({ id: 'med-seed', reminderTime: '09:00' });
    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med], hydrated: false }))
    );
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('does NOT schedule on first run', () => {
    const med = makeMed({ id: 'med-first', reminderTime: '09:00' });
    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med], isFirstRun: true }))
    );
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('does NOT schedule when notificationsEnabled is false', () => {
    const med = makeMed({ id: 'med-noperm', reminderTime: '09:00' });
    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med], notificationsEnabled: false }))
    );
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('does NOT schedule when exactAlarmPermission is null', () => {
    const med = makeMed({ id: 'med-null', reminderTime: '09:00' });
    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med], exactAlarmPermission: null }))
    );
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('does NOT schedule when exactAlarmPermission is denied', () => {
    const med = makeMed({ id: 'med-false', reminderTime: '09:00' });
    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med], exactAlarmPermission: 'denied' }))
    );
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('does NOT schedule for a med with reminderEnabled false', () => {
    const med = makeMed({ id: 'med-noreminder', reminderEnabled: false, reminderTime: '09:00' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('cancels the alarm when reminderEnabled is turned off', async () => {
    const med = makeMed({ id: 'med-disable', reminderEnabled: true, reminderTime: '09:00' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    const medDisabled = { ...med, reminderEnabled: false };
    rerender({ medications: [medDisabled] });
    await flushUntil(() => mocks.cancel.mock.calls.some((c) => c[0] === 'med-disable'));

    expect(mocks.cancel).toHaveBeenCalledWith('med-disable', 'd1');
  });

  it('does NOT schedule for a med with no reminderTime', () => {
    const med = makeMed({ id: 'med-notime', reminderEnabled: true, reminderTime: '' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
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

describe('useDoseReminderScheduler — exact-alarm gating', () => {
  it('cancels previously-scheduled alarms when exactAlarmPermission turns denied', async () => {
    const med = makeMed({ id: 'med-exact-off', reminderTime: '09:00' });
    const { rerender } = renderHook(
      ({ exactAlarmPermission }: { exactAlarmPermission: ExactAlarmPermission }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med], exactAlarmPermission })
        ),
      { initialProps: { exactAlarmPermission: 'granted' as ExactAlarmPermission } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    rerender({ exactAlarmPermission: 'denied' });
    await flushUntil(() => mocks.cancel.mock.calls.some((c) => c[0] === 'med-exact-off'));

    expect(mocks.cancel).toHaveBeenCalledWith('med-exact-off', 'd1');
  });

  it('reschedules when exactAlarmPermission turns from denied to granted', async () => {
    const med = makeMed({ id: 'med-exact-on', reminderTime: '09:00' });
    const { rerender } = renderHook(
      ({ exactAlarmPermission }: { exactAlarmPermission: ExactAlarmPermission }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med], exactAlarmPermission })
        ),
      { initialProps: { exactAlarmPermission: 'denied' as ExactAlarmPermission } }
    );

    expect(mocks.schedule).not.toHaveBeenCalled();

    rerender({ exactAlarmPermission: 'granted' });
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-exact-on', 'Test Med', '09:00', 1, 'قرص'
    );
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

describe('useDoseReminderScheduler — doseSignature (no unnecessary reschedule)', () => {
  it('does NOT reschedule when currentPills changes (stock change)', async () => {
    const med = makeMed({ id: 'med-stock', reminderTime: '09:00', currentPills: 30 });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    const callsAfterFirst = mocks.schedule.mock.calls.length;

    // Stock changes (take a pill) — should NOT trigger reschedule.
    const medUpdated = { ...med, currentPills: 29 };
    rerender({ medications: [medUpdated] });

    // Wait a few ticks — no new schedule call should happen.
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.schedule.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does NOT reschedule when elapsed-day settlement changes', async () => {
    const med = makeMed({ id: 'med-sync', reminderTime: '09:00'});
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    const callsAfterFirst = mocks.schedule.mock.calls.length;

    const medUpdated = { ...med};
    rerender({ medications: [medUpdated] });

    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.schedule.mock.calls.length).toBe(callsAfterFirst);
  });

  it('DOES reschedule with the new treatment end date when only duration changes', async () => {
    const med = makeMed({
      id: 'med-treatment-end',
      reminderTime: '20:00',
      isChronic: false,
      durationDays: 5,
      treatmentStartDate: '2024-09-10',
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule.mock.calls[0][6]).toEqual({
      treatmentEndDate: '2024-09-14',
    });

    const shortened = {
      ...med,
      durationDays: 2,
    };
    rerender({ medications: [shortened] });

    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    expect(mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1][6]).toEqual({
      treatmentEndDate: '2024-09-11',
    });
  });

  it('DOES reschedule when schedule row time changes', async () => {
    const med = makeMed({
      id: 'med-time',
      reminderTime: '08:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    const medUpdated = {
      ...med,
      reminderTime: '09:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '09:00' }],
    };
    rerender({ medications: [medUpdated] });

    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    const lastCall = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
    expect(lastCall[2]).toBe('09:00');
  });

  it('DOES reschedule when medication name changes (affects title)', async () => {
    const med = makeMed({ id: 'med-name', name: 'Panadol', reminderTime: '09:00' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    const medUpdated = { ...med, name: 'Panadol Extra' };
    rerender({ medications: [medUpdated] });

    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    const lastCall = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
    expect(lastCall[1]).toBe('Panadol Extra');
  });

  it('does NOT reschedule when only dailyDose changes (schedule row unchanged)', async () => {
    const med = makeMed({
      id: 'med-dose',
      dailyDose: 1,
      reminderTime: '09:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '09:00' }],
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    const callsAfterMount = mocks.schedule.mock.calls.length;

    const medUpdated = { ...med, dailyDose: 2 }; // schedule amount still 1
    rerender({ medications: [medUpdated] });

    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule.mock.calls.length).toBe(callsAfterMount);
  });

  it('changing only lastConsumedDate does not trigger per-dose reminder reconciliation', async () => {
    const med = makeMed({
      id: 'med-lcd',
      reminderTime: '09:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '09:00' }],
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    const callsAfterMount = mocks.schedule.mock.calls.length;
    const cancelAfterMount = mocks.cancel.mock.calls.length;

    // Only medication-level lastConsumedDate changes; per-dose markers unchanged.
    rerender({
      medications: [{ ...med, lastConsumedDate: getTodayDateString() }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule.mock.calls.length).toBe(callsAfterMount);
    expect(mocks.cancel.mock.calls.length).toBe(cancelAfterMount);
  });
});

describe('useDoseReminderScheduler — consumption suppression (today\u2019s dose taken)', () => {
  const SNOOZE_KEY = 'android_med_tracker_snooze_v1';

  it('Test 1 — consumed today BEFORE the reminder time: cold start suppresses today\u2019s reminder and re-arms from tomorrow', async () => {
    // reminder 20:00, now 12:00, dose already consumed today.
    const med = makeMed({
      id: 'med-consumed',
      reminderTime: '20:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() =>
      mocks.schedule.mock.calls.some((c) => c[0] === 'med-consumed')
    );

    // The recurring alarm was cancelled (today's occurrence suppressed)…
    expect(mocks.cancel).toHaveBeenCalledWith('med-consumed', 'd1');
    // …and re-armed as the SAME recurring daily schedule starting
    // TOMORROW (skipToday) — tomorrow's reminder remains scheduled.
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-consumed',
      'Test Med',
      '20:00',
      1,
      '\u0642\u0631\u0635',
      'd1',
      { skipToday: true }
    );
    // Any pending snoozed one-shot for the taken dose was cancelled.
    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-consumed', 'd1');
  });

  it('Test 1b — live manual consumption while the app is running: suppression fires on the consumedSignature change', async () => {
    // Dose NOT taken at mount — normal schedule.
    const med = makeMed({
      id: 'med-live',
      reminderTime: '20:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule.mock.calls[0][0]).toBe('med-live');
    expect(mocks.schedule.mock.calls[0].length).toBeGreaterThanOrEqual(6); // includes doseId
    const schedulesBefore = mocks.schedule.mock.calls.length;

    // User manually takes the dose at 12:00 (before the 20:00 reminder):
    // Per-dose consume marker → consumedSignature change.
    const medConsumed = {
      ...med,
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    };
    rerender({ medications: [medConsumed] });

    await flushUntil(() =>
      mocks.schedule.mock.calls.length > schedulesBefore ||
      mocks.cancel.mock.calls.some((c) => c[0] === 'med-live')
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.length > schedulesBefore
    );

    // Today's pending recurring occurrence was cancelled…
    expect(mocks.cancel).toHaveBeenCalledWith('med-live', 'd1');
    // …and the recurring alarm re-armed from tomorrow (skipToday).
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-live',
      'Test Med',
      '20:00',
      1,
      'قرص',
      'd1',
      { skipToday: true }
    );
    // Pending snoozed reminder for the taken dose cancelled too.
    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-live', 'd1');
  });

  it('Test 2 — suppression re-arm is the recurring daily schedule (tomorrow covered at unit level)', async () => {
    // The hook passes { skipToday: true } to scheduleDoseReminder; the
    // notifications-level tests prove skipToday schedules the next fire
    // at TOMORROW HH:MM with repeats:true + every:'day' and the same
    // stable id (notifications.dose.test.ts). Here we assert the hook
    // really hands that option through for a consumed med.
    const med = makeMed({
      id: 'med-tomorrow',
      reminderTime: '20:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-tomorrow' && c[6]?.skipToday === true
      )
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-tomorrow', 'Test Med', '20:00', 1, '\u0642\u0631\u0635', 'd1', { skipToday: true }
    );
  });

  it('Test 3 — consumed today AFTER the reminder already fired: no undo of the fired notification, snooze cleanup only', async () => {
    // now = 21:00, reminder 20:00 already fired, dose consumed at 21:00.
    vi.setSystemTime(new Date('2024-09-10T21:00:00Z'));
    const med = makeMed({
      id: 'med-after',
      reminderTime: '20:00',
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    // Let all chained ops settle.
    await flushUntil(() => mocks.cancelSnoozed.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 20));

    // The fired reminder is NOT retracted and tomorrow is NOT touched:
    // no (re)schedule for this med at all.
    expect(mocks.schedule).not.toHaveBeenCalledWith(
      'med-after', 'Test Med', '20:00', 1, '\u0642\u0631\u0635'
    );
    expect(mocks.schedule).not.toHaveBeenCalledWith(
      'med-after', 'Test Med', '20:00', 1, '\u0642\u0631\u0635', 'd1', { skipToday: true }
    );
    // A pending snoozed one-shot (e.g. a 90-min snooze from the 20:00
    // fire) is still cancelled — a snoozed reminder for a taken dose
    // must never fire.
    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-after', 'd1');
  });

  it('Test 4/5 — app resume after a manual dose re-applies the suppression (reconciliation)', async () => {
    const med = makeMed({
      id: 'med-resume',
      reminderTime: '20:00',
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    });
    const { rerender } = renderHook(
      ({ resumeTick }) =>
        useDoseReminderScheduler(defaultOpts({ medications: [med], resumeTick })),
      { initialProps: { resumeTick: 0 } }
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-resume' && c[6]?.skipToday === true
      )
    );
    const cancelsBefore = mocks.cancel.mock.calls.filter((c) => c[0] === 'med-resume').length;
    const schedulesBefore = mocks.schedule.mock.calls.length;

    // Resume (appStateChange) → resumeTick bump → suppression effect
    // re-runs and re-applies (idempotent): cancel + skipToday re-arm.
    rerender({ resumeTick: 1 });
    await flushUntil(() => mocks.schedule.mock.calls.length > schedulesBefore);

    expect(mocks.cancel).toHaveBeenCalledWith('med-resume', 'd1');
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-resume', 'Test Med', '20:00', 1, '\u0642\u0631\u0635', 'd1', { skipToday: true }
    );
    expect(
      mocks.cancel.mock.calls.filter((c) => c[0] === 'med-resume').length
    ).toBeGreaterThan(cancelsBefore);
  });

  it('Test 6 — a live consumption clears the persisted snooze marker and cancels the pending snoozed one-shot', async () => {
    const med = makeMed({ id: 'med-snooze-consumed', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    // Simulate a pending snooze (marker + the native one-shot exists).
    localStorage.setItem(
      SNOOZE_KEY,
      JSON.stringify({ 'med-snooze-consumed': Date.now() + 10 * 60_000 })
    );

    // User takes the dose manually → suppression must cancel/suppress
    // the pending snoozed reminder for today.
    rerender({ medications: [{ ...med, doseConsumptionHistory: { d1: [getTodayDateString()] } }] });
    await flushUntil(() => mocks.cancelSnoozed.mock.calls.length >= 1);

    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-snooze-consumed', 'd1');
    const snooze = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}') as Record<string, number>;
    expect(snooze['med-snooze-consumed']).toBeUndefined();
  });

  it('Test 7 — dose NOT taken: the reminder still fires normally (no suppression, 5-arg schedule)', async () => {
    const med = makeMed({ id: 'med-taken-no', reminderTime: '20:00' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-taken-no', 'Test Med', '20:00', 1, '\u0642\u0631\u0635'
    );
    expect(mocks.cancelSnoozed).not.toHaveBeenCalled();
  });

  it('Test 8 — YESTERDAY\u2019s lastConsumedDate: today\u2019s reminder still fires normally', async () => {
    const med = makeMed({
      id: 'med-yesterday',
      reminderTime: '20:00',
      doseConsumptionHistory: { d1: ['2024-09-09'] }, // yesterday (today = 2024-09-10)
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    // Normal schedule — today's occurrence NOT skipped (the logic is
    // based on the CURRENT calendar day, not on lastConsumedDate
    // merely having a value).
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-yesterday', 'Test Med', '20:00', 1, '\u0642\u0631\u0635'
    );
    expect(mocks.cancelSnoozed).not.toHaveBeenCalled();
  });

  it('Test 10 — a pure stock change (currentPills/elapsed-day settlement) without consumption does NOT suppress or reschedule', async () => {
    const med = makeMed({ id: 'med-stock2', reminderTime: '09:00', currentPills: 30 });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    const schedulesBefore = mocks.schedule.mock.calls.length;

    rerender({ medications: [{ ...med, currentPills: 29}] });
    await new Promise((r) => setTimeout(r, 30));

    expect(mocks.schedule.mock.calls.length).toBe(schedulesBefore);
    expect(mocks.cancelSnoozed).not.toHaveBeenCalled();
  });

  it('Test 11 — consumption while a config reschedule is in flight: ops serialize on the per-med chain, final state is skipToday (no duplicate/race)', async () => {
    const med = makeMed({ id: 'med-race', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    const schedulesBeforeRerenders = mocks.schedule.mock.calls.length;

    // Hold the chain: the FIRST cancel call gates the ops behind it.
    const gateHolder: { release: () => void } = { release: () => void 0 };
    const gate = new Promise<void>((resolve) => (gateHolder.release = resolve));
    mocks.cancel.mockImplementationOnce(() => gate);

    // Config change (main effect re-runs → cancel+schedule enqueued)…
    rerender({ medications: [{ ...med, name: 'Renamed Med' }] });
    // …immediately followed by the consumption (suppression effect).
    rerender({ medications: [{ ...med, name: 'Renamed Med', doseConsumptionHistory: { d1: [getTodayDateString()] } }] });

    // Release the gate; let everything settle.
    gateHolder.release();
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-race' && c[6]?.skipToday === true
      )
    );
    await new Promise((r) => setTimeout(r, 20));

    // After the rerenders, EXACTLY ONE schedule happened for this med —
    // the suppression's skipToday re-arm. The stale config-change op
    // (superseded by the suppression's generation bump) scheduled
    // nothing, and no un-suppressed follow-up exists.
    const postRerenderSchedules = mocks.schedule.mock.calls
      .slice(schedulesBeforeRerenders)
      .filter((c) => c[0] === 'med-race');
    expect(postRerenderSchedules).toHaveLength(1);
    expect(postRerenderSchedules[0][1]).toBe('Renamed Med');
    expect(postRerenderSchedules[0][6]).toEqual({ skipToday: true });
  });

  it('Test 11b — reminder-config change AFTER a consumption cannot resurrect today\u2019s reminder (skipToday baked into every reschedule)', async () => {
    // Consumed at 12:00 → suppressed. At 14:00 the user renames the med
    // → the main effect re-runs → its schedule MUST still skip today.
    const med = makeMed({
      id: 'med-rename',
      reminderTime: '20:00',
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-rename' && c[6]?.skipToday === true
      )
    );

    rerender({ medications: [{ ...med, name: 'Renamed' }] });
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-rename' && c[1] === 'Renamed'
      )
    );

    // The rename reschedule also skips today (consumed day).
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-rename', 'Renamed', '20:00', 1, '\u0642\u0631\u0635', 'd1', { skipToday: true }
    );
  });

  it('suppression is gated when notifications are disabled (the main cancel-all owns that path)', () => {
    const med = makeMed({
      id: 'med-gated',
      reminderTime: '20:00',
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    });
    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med], notificationsEnabled: false }))
    );

    // No suppression scheduling for the consumed med while disabled.
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.cancelSnoozed).not.toHaveBeenCalled();
  });
});


describe('useDoseReminderScheduler — multi-dose (Phase 2)', () => {
  it('schedules exactly one notification per dose for a three-dose medication', async () => {
    const med = makeMed({
      id: 'med-multi',
      name: 'Drug A',
      reminderEnabled: true,
      reminderTime: '08:00',
      dailyDose: 4,
      doseSchedule: [
        { id: 'd1', amount: 2, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
        { id: 'd3', amount: 1, time: '21:00' },
      ],
      dosesPerDay: 3,
    });

    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() => mocks.schedule.mock.calls.length >= 3);

    expect(mocks.schedule).toHaveBeenCalledTimes(3);
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-multi', 'Drug A', '08:00', 2, 'قرص', { doseId: 'd1' }
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-multi', 'Drug A', '14:00', 1, 'قرص', { doseId: 'd2' }
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-multi', 'Drug A', '21:00', 1, 'قرص', { doseId: 'd3' }
    );

    // Distinct cancel targets (cancel-before-schedule) per dose
    expect(mocks.cancel).toHaveBeenCalledWith('med-multi', 'd1');
    expect(mocks.cancel).toHaveBeenCalledWith('med-multi', 'd2');
    expect(mocks.cancel).toHaveBeenCalledWith('med-multi', 'd3');
  });

  it('no-schedule med does not schedule notifications from reminderTime/dailyDose', async () => {
    const med = makeMed({
      id: 'med-no-sched',
      reminderEnabled: true,
      reminderTime: '20:00',
      dailyDose: 2,
      doseSchedule: undefined,
      dosesPerDay: undefined,
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('reminders disabled schedules zero notifications even with explicit schedule', async () => {
    const med = makeMed({
      id: 'med-off',
      reminderEnabled: false,
      reminderTime: '20:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('adds a dose notification when a new dose row is added', async () => {
    const med = makeMed({
      id: 'med-add',
      name: 'AddMed',
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'c', amount: 1, time: '20:00' },
      ],
      dosesPerDay: 2,
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    mocks.schedule.mockClear();
    mocks.cancel.mockClear();

    const expanded = {
      ...med,
      dosesPerDay: 3,
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 1, time: '14:00' },
        { id: 'c', amount: 1, time: '20:00' },
      ],
    };
    rerender({ medications: [expanded] });
    await flushUntil(() => mocks.schedule.mock.calls.some((c) => c[5]?.doseId === 'b'));

    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-add', 'AddMed', '14:00', 1, 'قرص', { doseId: 'b' }
    );
  });

  it('cancels the removed dose notification when a dose row is deleted', async () => {
    const med = makeMed({
      id: 'med-rm',
      name: 'RmMed',
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 1, time: '14:00' },
        { id: 'c', amount: 1, time: '20:00' },
      ],
      dosesPerDay: 3,
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 3);
    mocks.cancel.mockClear();
    mocks.cancelSnoozed.mockClear();
    mocks.schedule.mockClear();

    const shrunk = {
      ...med,
      dosesPerDay: 2,
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'c', amount: 1, time: '20:00' },
      ],
    };
    rerender({ medications: [shrunk] });
    await flushUntil(() => mocks.cancel.mock.calls.some((c) => c[0] === 'med-rm' && c[1] === 'b'));
    // Sibling doses (a, c) are rescheduled after the removed dose (b) is
    // cancelled — wait for those schedule calls before asserting.
    await flushUntil(() =>
      mocks.schedule.mock.calls.some((c) => c[5]?.doseId === 'a')
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.some((c) => c[5]?.doseId === 'c')
    );

    // Removed dose cancelled exactly once (no duplicate cancelSlot path).
    const cancelB = mocks.cancel.mock.calls.filter(
      (c) => c[0] === 'med-rm' && c[1] === 'b'
    );
    expect(cancelB).toHaveLength(1);

    const cancelSnoozedB = mocks.cancelSnoozed.mock.calls.filter(
      (c) => c[0] === 'med-rm' && c[1] === 'b'
    );
    expect(cancelSnoozedB).toHaveLength(1);

    // Siblings still rescheduled; removed dose is not.
    expect(mocks.schedule.mock.calls.some((c) => c[5]?.doseId === 'a')).toBe(true);
    expect(mocks.schedule.mock.calls.some((c) => c[5]?.doseId === 'c')).toBe(true);
    expect(mocks.schedule.mock.calls.some((c) => c[5]?.doseId === 'b')).toBe(false);
  });

  it('reconciles when a dose time changes (same dose id)', async () => {
    const med = makeMed({
      id: 'med-time',
      name: 'TimeMed',
      doseSchedule: [
        { id: 'x', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 1,
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    mocks.schedule.mockClear();

    const moved = {
      ...med,
      doseSchedule: [{ id: 'x', amount: 1, time: '15:00' }],
    };
    rerender({ medications: [moved] });
    await flushUntil(() =>
      mocks.schedule.mock.calls.some((c) => c[2] === '15:00' && c[5]?.doseId === 'x')
    );

    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-time', 'TimeMed', '15:00', 1, 'قرص', { doseId: 'x' }
    );
  });

  it('reconciles when a dose amount changes (same dose id)', async () => {
    const med = makeMed({
      id: 'med-amt',
      name: 'AmtMed',
      doseSchedule: [{ id: 'x', amount: 1, time: '10:00' }],
      dosesPerDay: 1,
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    mocks.schedule.mockClear();

    const changed = {
      ...med,
      doseSchedule: [{ id: 'x', amount: 2, time: '10:00' }],
    };
    rerender({ medications: [changed] });
    await flushUntil(() =>
      mocks.schedule.mock.calls.some((c) => c[3] === 2 && c[5]?.doseId === 'x')
    );

    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-amt', 'AmtMed', '10:00', 2, 'قرص', { doseId: 'x' }
    );
  });

  it('does not duplicate notifications when doseSchedule is reordered', async () => {
    const med = makeMed({
      id: 'med-ord',
      name: 'OrdMed',
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 1, time: '20:00' },
      ],
      dosesPerDay: 2,
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    const firstWave = mocks.schedule.mock.calls.length;
    mocks.schedule.mockClear();

    const reordered = {
      ...med,
      doseSchedule: [
        { id: 'b', amount: 1, time: '20:00' },
        { id: 'a', amount: 1, time: '08:00' },
      ],
    };
    rerender({ medications: [reordered] });
    // Signature includes each id@time@amount — order change of the joined
    // string may still reschedule (same end state). Ensure we never schedule
    // more than two slots (no third phantom dose).
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    const doseIds = mocks.schedule.mock.calls.map((c) => c[5]?.doseId).sort();
    expect(doseIds).toEqual(['a', 'b']);
    expect(firstWave).toBe(2);
  });

  it('cancels all dose notifications when reminderEnabled turns false', async () => {
    const med = makeMed({
      id: 'med-off-multi',
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 1, time: '20:00' },
      ],
      dosesPerDay: 2,
      reminderEnabled: true,
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    mocks.cancel.mockClear();

    rerender({ medications: [{ ...med, reminderEnabled: false }] });
    await flushUntil(
      () =>
        mocks.cancel.mock.calls.some((c) => c[1] === 'a') &&
        mocks.cancel.mock.calls.some((c) => c[1] === 'b')
    );

    expect(mocks.cancel).toHaveBeenCalledWith('med-off-multi', 'a');
    expect(mocks.cancel).toHaveBeenCalledWith('med-off-multi', 'b');
  });

  it('schedules all dose notifications when reminderEnabled turns true', async () => {
    const med = makeMed({
      id: 'med-on-multi',
      name: 'OnMed',
      reminderEnabled: false,
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 1, time: '20:00' },
      ],
      dosesPerDay: 2,
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    expect(mocks.schedule).not.toHaveBeenCalled();

    rerender({ medications: [{ ...med, reminderEnabled: true }] });
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);

    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-on-multi', 'OnMed', '08:00', 1, 'قرص', { doseId: 'a' }
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-on-multi', 'OnMed', '20:00', 1, 'قرص', { doseId: 'b' }
    );
  });
});



describe('Phase 4 — dose-scoped cancel on removal', () => {
  it('removing d2 cancels only d2 snooze notification and storage', async () => {
    const med = makeMed({
      id: 'med-rm-snooze',
      name: 'RmSnooze',
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 2,
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);

    // Pending snooze for d2 only
    const { SNOOZE_KEY } = await import('@/utils/doseReminderStorage');
    localStorage.setItem(
      SNOOZE_KEY,
      JSON.stringify({
        'med-rm-snooze::d1': Date.now() + 60_000,
        'med-rm-snooze::d2': Date.now() + 60_000,
      })
    );

    mocks.cancel.mockClear();
    mocks.cancelSnoozed.mockClear();

    const shrunk = {
      ...med,
      dosesPerDay: 1,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    };
    rerender({ medications: [shrunk] });
    await flushUntil(() =>
      mocks.cancel.mock.calls.some((c) => c[0] === 'med-rm-snooze' && c[1] === 'd2')
    );

    expect(mocks.cancel).toHaveBeenCalledWith('med-rm-snooze', 'd2');
    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-rm-snooze', 'd2');
    // d1 snooze storage must remain
    const snooze = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}');
    expect(snooze['med-rm-snooze::d1']).toBeDefined();
    expect(snooze['med-rm-snooze::d2']).toBeUndefined();
  });

  it('getDoseReminderSlots skips duplicate doseIds', () => {
    const med = makeMed({
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd1', amount: 9, time: '09:00' }, // duplicate id ignored
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 3,
    });
    const slots = getDoseReminderSlots(med);
    expect(slots.map((s) => s.doseId)).toEqual(['d1', 'd2']);
    expect(slots.find((s) => s.doseId === 'd1')?.amount).toBe(1);
  });

  it('skips empty doseIds', () => {
    const med = makeMed({
      doseSchedule: [
        { id: '', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 2,
    });
    const slots = getDoseReminderSlots(med);
    expect(slots.map((s) => s.doseId)).toEqual(['d2']);
  });

  it('skips whitespace-only doseIds', () => {
    const med = makeMed({
      doseSchedule: [
        { id: '   ', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 2,
    });
    const slots = getDoseReminderSlots(med);
    expect(slots.map((s) => s.doseId)).toEqual(['d2']);
  });

  it('skips missing doseIds', () => {
    const med = makeMed({
      doseSchedule: [
        { id: undefined as unknown as string, amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 2,
    });
    const slots = getDoseReminderSlots(med);
    expect(slots.map((s) => s.doseId)).toEqual(['d2']);
  });

  it('two empty-id rows do not collapse into one legacy slot', () => {
    const med = makeMed({
      doseSchedule: [
        { id: '', amount: 1, time: '08:00' },
        { id: '', amount: 2, time: '14:00' },
      ],
      dosesPerDay: 2,
    });
    const slots = getDoseReminderSlots(med);
    expect(slots).toEqual([]);
  });

  it('no-schedule med produces no reminder slots (no legacy sentinel)', () => {
    // Issue #268 / PR #271: the legacy single-dose reminder sentinel is gone.
    // A med without an explicit doseSchedule produces no reminder slots —
    // getDoseReminderSlots returns [] (no dailyDose/reminderTime synthetic
    // slot, no LEGACY_DOSE_ID).
    const med = makeMed({
      doseSchedule: undefined,
      dosesPerDay: undefined,
      reminderEnabled: true,
      reminderTime: '09:00',
      dailyDose: 1,
    });
    const slots = getDoseReminderSlots(med);
    expect(slots).toEqual([]);
  });
});

describe('useDoseReminderScheduler — restore re-arms future dose notification', () => {
  /**
   * Regression: consume → suppress notification → restore while time still
   * ahead → reminder must be re-armed for today (no skipToday).
   */

  it('Test A/D — future restored multi-dose slot is re-armed without skipToday', async () => {
    // now = 17:00, d2 at 20:00 still ahead. Consume then restore d2.
    vi.setSystemTime(new Date('2024-09-10T17:00:00'));
    const today = getTodayDateString();
    const base = makeMed({
      id: 'med-restore',
      name: 'RestoreMed',
      reminderEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '20:00' },
      ],
      dosesPerDay: 2,
    });

    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [base] } }
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.some((c) => c[5]?.doseId === 'd2')
    );
    const schedulesAfterMount = mocks.schedule.mock.calls.length;

    // Consume d2 → suppression with skipToday
    const consumed = {
      ...base,
      doseConsumptionHistory: { d2: [today] },
    };
    rerender({ medications: [consumed] });
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) =>
          c[0] === 'med-restore' &&
          c[5]?.doseId === 'd2' &&
          c[6]?.skipToday === true
      )
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-restore',
      'RestoreMed',
      '20:00',
      1,
      'قرص',
      'd2', { skipToday: true }
    );

    // Restore d2 (clear consumption) while 20:00 still ahead
    const restored = {
      ...base,
      doseConsumptionHistory: {},
    };
    const schedulesBeforeRestore = mocks.schedule.mock.calls.length;
    rerender({ medications: [restored] });

    await flushUntil(() =>
      mocks.schedule.mock.calls
        .slice(schedulesBeforeRestore)
        .some(
          (c) =>
            c[0] === 'med-restore' &&
            c[2] === '20:00' &&
            c[5]?.doseId === 'd2' &&
            !c[6]?.skipToday
        )
    );

    const postRestore = mocks.schedule.mock.calls.slice(schedulesBeforeRestore);
    const d2Rearm = postRestore.find(
      (c) => c[0] === 'med-restore' && c[5]?.doseId === 'd2' && !c[6]?.skipToday
    );
    expect(d2Rearm).toBeDefined();
    expect(d2Rearm).toEqual([
      'med-restore',
      'RestoreMed',
      '20:00',
      1,
      'قرص',
      { doseId: 'd2' },
    ]);
    // Must not leave a skipToday schedule as the final action for d2
    const lastD2 = [...mocks.schedule.mock.calls]
      .reverse()
      .find((c) => c[0] === 'med-restore' && c[5]?.doseId === 'd2');
    expect(lastD2?.[6]?.skipToday).toBeUndefined();
    void schedulesAfterMount;
  });

  it('Test B — past restored dose is not scheduled for the past occurrence', async () => {
    // now = 17:00, d2 at 14:00 already passed. Restore must not create a
    // past-due reminder (no scheduleDoseReminder for 14:00 without skipToday
    // that would fire today — scheduleDoseReminder itself advances past times
    // to tomorrow, but the scheduler must not invent a past occurrence).
    vi.setSystemTime(new Date('2024-09-10T17:00:00'));
    const today = getTodayDateString();
    const base = makeMed({
      id: 'med-past',
      name: 'PastMed',
      reminderEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 2,
      doseConsumptionHistory: { d2: [today] },
    });

    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [base] } }
    );
    // Let consumption path settle (d2 time already past → no skipToday re-arm)
    await flushUntil(() => mocks.cancelSnoozed.mock.calls.length >= 1).catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    const schedulesBefore = mocks.schedule.mock.calls.length;

    // Restore d2 (clear consumption)
    const restored = {
      ...base,
      doseConsumptionHistory: {},
    };
    rerender({ medications: [restored] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));

    // No new schedule for the already-passed 14:00 occurrence as a
    // "today without skipToday" arm. (Recurring tomorrow may still exist
    // from the main config effect at mount — that is fine.)
    const post = mocks.schedule.mock.calls.slice(schedulesBefore);
    const pastTodayArm = post.find(
      (c) =>
        c[0] === 'med-past' &&
        c[2] === '14:00' &&
        c[5]?.doseId === 'd2' &&
        !c[6]?.skipToday
    );
    // After restore of a past slot, the consumption effect must not schedule
    // for the past occurrence (isDoseReminderTimeStillAhead is false).
    expect(pastTodayArm).toBeUndefined();
  });

  it('Test C — restoring d2 does not run restore re-arm for still-consumed sibling d1', async () => {
    // Both d1 (18:00) and d2 (20:00) are still ahead at 17:00.
    // Both start consumed; restore ONLY d2. Sibling d1 must stay suppressed
    // and must not receive a restore-path re-arm (schedule without skipToday).
    vi.setSystemTime(new Date('2024-09-10T17:00:00'));
    const today = getTodayDateString();
    const base = makeMed({
      id: 'med-sib',
      name: 'SibMed',
      reminderEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 1, time: '18:00' },
        { id: 'd2', amount: 1, time: '20:00' },
      ],
      dosesPerDay: 2,
      doseConsumptionHistory: { d1: [today], d2: [today] },
    });

    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [base] } }
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-sib' && c[5]?.doseId === 'd1' && c[6]?.skipToday === true
      ) &&
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-sib' && c[5]?.doseId === 'd2' && c[6]?.skipToday === true
      )
    );

    const schedulesBeforeRestore = mocks.schedule.mock.calls.length;
    const cancelsBeforeRestore = mocks.cancel.mock.calls.length;

    // Restore ONLY d2 (d1 remains consumed)
    const restoredD2 = {
      ...base,
      doseConsumptionHistory: { d1: [today] },
    };
    rerender({ medications: [restoredD2] });
    await flushUntil(() =>
      mocks.schedule.mock.calls
        .slice(schedulesBeforeRestore)
        .some(
          (c) =>
            c[0] === 'med-sib' &&
            c[5]?.doseId === 'd2' &&
            !c[6]?.skipToday
        )
    );
    await Promise.resolve();
    await Promise.resolve();

    const postRestoreSchedules = mocks.schedule.mock.calls.slice(schedulesBeforeRestore);
    const postRestoreCancels = mocks.cancel.mock.calls.slice(cancelsBeforeRestore);

    // d2: restore re-arm without skipToday
    expect(
      postRestoreSchedules.some(
        (c) =>
          c[0] === 'med-sib' &&
          c[2] === '20:00' &&
          c[5]?.doseId === 'd2' &&
          c[6]?.skipToday !== true
      )
    ).toBe(true);
    expect(postRestoreCancels.some((c) => c[0] === 'med-sib' && c[1] === 'd2')).toBe(
      true
    );

    // d1: must NOT receive restore-path re-arm (schedule without skipToday).
    // Still-consumed sibling may only keep prior skipToday suppression;
    // signature-only restore of d2 must not cancel/reschedule d1.
    expect(
      postRestoreSchedules.some(
        (c) =>
          c[0] === 'med-sib' &&
          c[5]?.doseId === 'd1' &&
          c[6]?.skipToday !== true
      )
    ).toBe(false);
    expect(
      postRestoreSchedules.some((c) => c[0] === 'med-sib' && c[5]?.doseId === 'd1')
    ).toBe(false);
    expect(
      postRestoreCancels.some((c) => c[0] === 'med-sib' && c[1] === 'd1')
    ).toBe(false);

    // Final logical state: d2 armed today, d1 last schedule still skipToday
    const lastD2 = [...mocks.schedule.mock.calls]
      .reverse()
      .find((c) => c[0] === 'med-sib' && c[5]?.doseId === 'd2');
    expect(lastD2?.[6]?.skipToday).toBeUndefined();
    expect(lastD2?.[2]).toBe('20:00');

    const lastD1 = [...mocks.schedule.mock.calls]
      .reverse()
      .find((c) => c[0] === 'med-sib' && c[5]?.doseId === 'd1');
    expect(lastD1?.[5]?.skipToday).toBe(true);
    expect(lastD1?.[2]).toBe('18:00');
  });

  it('Test E — second reconciliation after restore keeps one logical notification identity', async () => {
    // Lifecycle:
    //   consumed → skipToday suppression
    //   → restore while 20:00 still ahead → re-arm without skipToday
    //   → resumeTick 0→1 forces a second real reconciliation
    //
    // Observable contract at the scheduleDoseReminder / cancelDoseReminder
    // boundary (mocks do not hit Capacitor): every op for this dose uses
    // medId=med-idem + doseId=d2, which the production helper
    // doseReminderAlarmIdForDose maps to one stable numeric notification id.
    // Cancel→schedule pairs are reconciliation ops, not extra identities.
    vi.setSystemTime(new Date('2024-09-10T17:00:00'));
    const today = getTodayDateString();
    const medId = 'med-idem';
    const doseId = 'd2';
    const doseTime = '20:00';

    // Production identity: same medId+doseId → same notification id always.
    const logicalNotifId = doseReminderAlarmIdForDose(medId, doseId);
    expect(doseReminderAlarmIdForDose(medId, doseId)).toBe(logicalNotifId);
    // Distinct from a different dose slot on the same med (no identity leak).
    expect(doseReminderAlarmIdForDose(medId, 'd1')).not.toBe(logicalNotifId);

    const base = makeMed({
      id: medId,
      name: 'IdemMed',
      reminderEnabled: true,
      doseSchedule: [{ id: doseId, amount: 1, time: doseTime }],
      dosesPerDay: 1,
      doseConsumptionHistory: { [doseId]: [today] },
    });

    const { rerender } = renderHook(
      ({ medications, resumeTick }) =>
        useDoseReminderScheduler(defaultOpts({ medications, resumeTick })),
      { initialProps: { medications: [base], resumeTick: 0 } }
    );

    // 1) Consumed → skipToday suppression exists
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) =>
          c[0] === medId &&
          c[5]?.doseId === doseId &&
          c[6]?.skipToday === true
      )
    );
    const suppressCall = mocks.schedule.mock.calls.find(
      (c) =>
        c[0] === medId &&
        c[5]?.doseId === doseId &&
        c[6]?.skipToday === true
    );
    expect(suppressCall).toBeDefined();
    expect(suppressCall?.[2]).toBe(doseTime);
    // Suppress path targets the same logical id as any other d2 schedule.
    expect(doseReminderAlarmIdForDose(suppressCall![0], suppressCall![5].doseId)).toBe(
      logicalNotifId
    );

    // 2) Restore while future → re-arm without skipToday
    const restored = {
      ...base,
      doseConsumptionHistory: {},
    };
    rerender({ medications: [restored], resumeTick: 0 });
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) =>
          c[0] === medId &&
          c[5]?.doseId === doseId &&
          c[6]?.skipToday !== true
      )
    );

    const rearmCalls = mocks.schedule.mock.calls.filter(
      (c) =>
        c[0] === medId &&
        c[5]?.doseId === doseId &&
        c[6]?.skipToday !== true
    );
    expect(rearmCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of rearmCalls) {
      expect(c[2]).toBe(doseTime);
      expect(c[5]?.doseId).toBe(doseId);
      expect(c[6]?.skipToday).toBeUndefined();
      // Restore re-arm resolves to the SAME logical notification id as suppress.
      expect(doseReminderAlarmIdForDose(c[0], c[5].doseId)).toBe(logicalNotifId);
    }

    // Every cancel for this med in the lifecycle targets doseId d2 (same id).
    for (const c of mocks.cancel.mock.calls) {
      if (c[0] === medId) {
        expect(c[1]).toBe(doseId);
        expect(doseReminderAlarmIdForDose(c[0], c[1])).toBe(logicalNotifId);
      }
    }

    // No schedule ever used a different doseId for this med in this test.
    expect(
      mocks.schedule.mock.calls.some(
        (c) => c[0] === medId && c[5]?.doseId != null && c[5].doseId !== doseId
      )
    ).toBe(false);

    const schedulesAfterRestore = mocks.schedule.mock.calls.length;
    const cancelsAfterRestore = mocks.cancel.mock.calls.length;

    // 3) Second real reconciliation via resumeTick
    rerender({ medications: [restored], resumeTick: 1 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));

    const postSecondSchedules = mocks.schedule.mock.calls.slice(schedulesAfterRestore);
    const postSecondCancels = mocks.cancel.mock.calls.slice(cancelsAfterRestore);

    // No skipToday regression after second reconciliation.
    expect(
      postSecondSchedules.some(
        (c) =>
          c[0] === medId &&
          c[5]?.doseId === doseId &&
          c[6]?.skipToday === true
      )
    ).toBe(false);

    // Any further ops still use the same medId + doseId → same logical id.
    // (Extra cancel→schedule pairs would still be the same identity, not a
    // second notification id; we do not treat op count as notification count.)
    for (const c of postSecondSchedules) {
      if (c[0] === medId) {
        expect(c[5]?.doseId).toBe(doseId);
        expect(c[2]).toBe(doseTime);
        expect(c[6]?.skipToday).toBeUndefined();
        expect(doseReminderAlarmIdForDose(c[0], c[5].doseId)).toBe(logicalNotifId);
      }
    }
    for (const c of postSecondCancels) {
      if (c[0] === medId) {
        expect(c[1]).toBe(doseId);
        expect(doseReminderAlarmIdForDose(c[0], c[1])).toBe(logicalNotifId);
      }
    }

    // Final schedule for this dose: without skipToday, same identity.
    const lastD2 = [...mocks.schedule.mock.calls]
      .reverse()
      .find((c) => c[0] === medId && c[5]?.doseId === doseId);
    expect(lastD2).toBeDefined();
    expect(lastD2?.[6]?.skipToday).toBeUndefined();
    expect(lastD2?.[5]?.doseId).toBe(doseId);
    expect(lastD2?.[2]).toBe(doseTime);
    expect(doseReminderAlarmIdForDose(lastD2![0], lastD2![5].doseId)).toBe(
      logicalNotifId
    );
  });
});


describe('idempotent lifecycle reconciliation', () => {
  it('second effect run with same signature does not cancel+reschedule when pending', async () => {
    const med = makeMed({ reminderTime: '09:00' });
    const { rerender } = renderHook(
      (props: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({
            medications: [med],
            lifecycleTick: props.lifecycleTick,
          })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    const schedulesAfterFirst = mocks.schedule.mock.calls.length;
    expect(schedulesAfterFirst).toBeGreaterThanOrEqual(1);

    // Next lifecycle: pretend native still has the pending id.
    mocks.isPending.mockResolvedValue({ ok: true, pending: true });
    mocks.schedule.mockClear();
    mocks.cancel.mockClear();

    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('repairs missing pending without changing signature', async () => {
    const med = makeMed({ reminderTime: '09:00' });
    const { rerender } = renderHook(
      (props: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({
            medications: [med],
            lifecycleTick: props.lifecycleTick,
          })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    mocks.schedule.mockClear();
    mocks.cancel.mockClear();
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });

    rerender({ lifecycleTick: 2 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Repair schedules without cancel when signature unchanged and pending missing.
    expect(mocks.schedule).toHaveBeenCalled();
  });

});

describe('stale native pending cleanup', () => {
  it('cancels stale dose alarms from native pending on reconcile', async () => {
    // Use native platform so cancelStaleDoseReminderAlarms exercises the
    // real getPending + cancel path (not just a spy).
    vi.mocked(Capacitor.getPlatform).mockReturnValue('android');

    const med = makeMed({
      reminderTime: '09:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '09:00' }],
      dosesPerDay: 1,
    });

    const currentId = doseReminderAlarmIdForDose(med.id, 'd1');
    const staleDoseId = doseReminderAlarmIdForDose('med-stale', 'd-old');
    if (currentId === null || staleDoseId === null) {
      throw new Error('Expected valid notification ids for non-empty dose ids');
    }
    const nonDoseAlarmId = 999_999_999; // outside doseAlarm band

    // Mock getPending to contain current + stale dose-specific + non-doseAlarm IDs.
    // (title/body are required by PendingLocalNotificationSchema but unused by
    // the stale-cleanup logic which only inspects `id`.)
    vi.mocked(LocalNotifications.getPending).mockResolvedValue({
      notifications: [
        { id: currentId, title: '', body: '' },
        { id: staleDoseId, title: '', body: '' },
        { id: nonDoseAlarmId, title: '', body: '' },
      ],
    });

    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med] }))
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    // Verify actual IDs sent to cancel: stale cancelled,
    // current + non-doseAlarm NOT cancelled.
    expect(LocalNotifications.cancel).toHaveBeenCalled();
    const cancelledIds = vi.mocked(LocalNotifications.cancel).mock.calls.flatMap(
      (call: unknown[]) =>
        (call[0] as { notifications: { id: number }[] }).notifications.map(
          (n) => n.id
        )
    );
    expect(cancelledIds).toContain(staleDoseId);
    expect(cancelledIds).not.toContain(currentId);
    expect(cancelledIds).not.toContain(nonDoseAlarmId);
  });
});

describe('delivery/reconciliation race', () => {
  it('repairs when pending=false and no native re-arm evidence (case C)', async () => {
    // Truly missing alarm: neither getPending nor shared ExactAlarmRuntime.
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    const med = makeMed({
      reminderTime: '23:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '23:00' }],
    });

    const { rerender } = renderHook(
      (props: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({
            medications: [med],
            lifecycleTick: props.lifecycleTick,
          })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).toHaveBeenCalled();
    const firstCalls = mocks.schedule.mock.calls.length;
    mocks.schedule.mockClear();

    // Still missing — repair again on lifecycle (same signature path).
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(firstCalls).toBeGreaterThanOrEqual(1);
  });


  it('post-delivery, no-open/no-action state (observable equivalent of shade dismiss): pending=false + D+1 evidence → zero schedule for D', async () => {
    // State transition (not a literal shade swipe):
    //   D delivered by DoseReminderAlarmReceiver.onReceive
    //   → native arms exactly one successor D+1 for same medicationId+doseId+reminderTime
    //   → localNotificationActionPerformed / Take / Snooze / open never ran
    //   → tray entry may leave getPending(); pending becomes false for "current" view
    //   → shared ExactAlarmRuntime still reports valid re-arm for this occurrence identity
    // Reconciliation must not scheduleDoseReminder for same-day D.
    const medicationId = 'med-1';
    const doseId = 'd1';
    const reminderTime = '09:00';
    // Occurrence identity used by isNativeDoseReminderReArmed (must match slot).
    const successorEvidence = {
      medicationId,
      doseId,
      reminderTime,
      // D+1 future successor — not same calendar day as delivered D.
      nextOccurrenceKind: 'D+1' as const,
    };

    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockImplementation(
      async (medId: string, dId: string, time?: string) => {
        // Only valid when identity matches the delivered dose's successor evidence.
        return (
          medId === successorEvidence.medicationId &&
          dId === successorEvidence.doseId &&
          time === successorEvidence.reminderTime &&
          successorEvidence.nextOccurrenceKind === 'D+1'
        );
      }
    );

    const med = makeMed({
      id: medicationId,
      reminderTime,
      doseSchedule: [{ id: doseId, amount: 1, time: reminderTime }],
    });

    const { rerender } = renderHook(
      (props: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({
            medications: [med],
            lifecycleTick: props.lifecycleTick,
          })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    mocks.schedule.mockClear();
    mocks.cancel.mockClear();
    mocks.isPending.mockClear();
    mocks.isNativeReArmed.mockClear();

    // Post-delivery reconciliation: signature unchanged, pending false, D+1 evidence valid.
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.isPending).toHaveBeenCalledWith(medicationId, doseId);
    expect(mocks.isNativeReArmed).toHaveBeenCalledWith(
      medicationId,
      doseId,
      reminderTime
    );
    // Zero new schedule for occurrence D (and no cancel of D+1 successor).
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('no-op when pending=false but native re-arm state is valid (case B — real delivery race)', async () => {
    // Delivery transition: getPending may still report false while
    // DoseReminderAlarmReceiver has already written shared ExactAlarmRuntime
    // after successful AlarmManager next-day arm. JS must not schedule a second path.
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    const med = makeMed({
      reminderTime: '23:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '23:00' }],
    });

    const { rerender } = renderHook(
      (props: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({
            medications: [med],
            lifecycleTick: props.lifecycleTick,
          })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).toHaveBeenCalled();
    mocks.schedule.mockClear();

    // pending still false, but native re-arm evidence present → no-op.
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: true });
    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('no-op when pending=true (case A)', async () => {
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    const med = makeMed({
      reminderTime: '23:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '23:00' }],
    });

    const { rerender } = renderHook(
      (props: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({
            medications: [med],
            lifecycleTick: props.lifecycleTick,
          })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    mocks.schedule.mockClear();

    mocks.isPending.mockResolvedValue({ ok: true, pending: true });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('repairs when native re-arm state is expired/invalid (case D)', async () => {
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    const med = makeMed({
      reminderTime: '23:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '23:00' }],
    });

    const { rerender } = renderHook(
      (props: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({
            medications: [med],
            lifecycleTick: props.lifecycleTick,
          })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    mocks.schedule.mockClear();

    // isNativeDoseReminderReArmed already encodes validity (expired/config mismatch → false).
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('repairs when evidence is stale for a different schedule identity (config mismatch)', async () => {
    // Store may still hold a future nextOccurrenceMs from an old reminderTime;
    // isNativeDoseReminderReArmed(med, dose, currentTime) must return false.
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    const med = makeMed({
      reminderTime: '10:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '10:00' }],
    });

    const { rerender } = renderHook(
      (props: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({
            medications: [med],
            lifecycleTick: props.lifecycleTick,
          })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    mocks.schedule.mockClear();
    mocks.cancel.mockClear();

    // Signature unchanged but native evidence invalid for current config → repair.
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule.mock.calls.length).toBeGreaterThanOrEqual(1);
    // isNativeDoseReminderReArmed must be consulted with current slot time.
    expect(mocks.isNativeReArmed).toHaveBeenCalledWith('med-1', 'd1', '10:00');
  });

  it('time/signature change cancels (clears re-arm evidence) then schedules replacement', async () => {
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    const med1 = makeMed({
      reminderTime: '09:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '09:00' }],
    });

    const { rerender } = renderHook(
      (props: { med: ReturnType<typeof makeMed>; lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({
            medications: [props.med],
            lifecycleTick: props.lifecycleTick,
          })
        ),
      { initialProps: { med: med1, lifecycleTick: 0 } }
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).toHaveBeenCalled();
    mocks.schedule.mockClear();
    mocks.cancel.mockClear();

    const med2 = makeMed({
      reminderTime: '11:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '11:00' }],
    });
    // Signature change path: cancel first (clears native evidence) then one schedule.
    rerender({ med: med2, lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.cancel).toHaveBeenCalledWith('med-1', 'd1');
    expect(mocks.schedule).toHaveBeenCalled();
  });
});

describe('useDoseReminderScheduler — per-dose instruction', () => {
  it('passes the dose-specific instruction to scheduling and reschedules when it changes', async () => {
    const med = makeMed({
      id: 'med-description',
      reminderTime: '20:00',
      doseSchedule: [
        {
          id: 'd1',
          amount: 1,
          time: '20:00',
          description: 'بعد الإفطار',
        },
      ],
    });

    const { rerender } = renderHook(
      ({ medication }: { medication: Medication }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [medication] })
        ),
      { initialProps: { medication: med } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule.mock.calls[0][6]?.doseDescription).toBe('بعد الإفطار');

    mocks.schedule.mockClear();
    mocks.cancel.mockClear();

    const updated = {
      ...med,
      doseSchedule: [
        {
          ...med.doseSchedule![0],
          description: 'قبل النوم',
        },
      ],
    };
    rerender({ medication: updated });

    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    const last = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
    expect(last[6]?.doseDescription).toBe('قبل النوم');
  });

  it('does not add an instruction option when the per-dose description is empty', async () => {
    const med = makeMed({
      id: 'med-empty-description',
      doseSchedule: [
        {
          id: 'd1',
          amount: 1,
          time: '20:00',
          description: '   ',
        },
      ],
    });

    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    expect(mocks.schedule.mock.calls[0][6]?.doseDescription).toBeUndefined();
  });
});

describe('useDoseReminderScheduler — manual Take capability', () => {
  it('allowManualTakeAction=false schedules without a manual Take action', async () => {
    const med = makeMed({ id: 'med-no-manual', reminderTime: '20:00' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({
      medications: [med],
      allowManualTakeActionByMedicationId: new Map([['med-no-manual', false]]),
    })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule.mock.calls.some(
      (c) => c[5]?.allowManualTakeAction === false
    )).toBe(true);
  });

  it('allowManualTakeAction=true schedules a manually actionable reminder', async () => {
    const med = makeMed({ id: 'med-manual', reminderTime: '20:00' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({
      medications: [med],
      allowManualTakeActionByMedicationId: new Map([['med-manual', true]]),
    })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule.mock.calls.some(
      (c) => c[5]?.allowManualTakeAction === true
    )).toBe(true);
  });

  it('changing the neutral capability cancels and reschedules with the new capability', async () => {
    const med = makeMed({ id: 'med-flip', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ allowManualTakeAction }: { allowManualTakeAction: boolean }) =>
        useDoseReminderScheduler(defaultOpts({
          medications: [med],
          allowManualTakeActionByMedicationId: new Map([[med.id, allowManualTakeAction]]),
        })),
      { initialProps: { allowManualTakeAction: false } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    mocks.schedule.mockClear();
    mocks.cancel.mockClear();
    rerender({ allowManualTakeAction: true });
    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.cancel).toHaveBeenCalledWith('med-flip', 'd1');
    expect(mocks.schedule.mock.calls.some(
      (c) => c[5]?.allowManualTakeAction === true
    )).toBe(true);
  });
});
