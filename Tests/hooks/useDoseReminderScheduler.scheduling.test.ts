/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushUntil } from '../helpers/asyncTestUtils';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '@/types';
import { getTodayDateString } from '@/utils/dateCalculations';
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
    // Chronic meds are always treatment-active; temporary meds would need
    // explicit treatmentStartDate/durationDays to schedule at all.
    isChronic: true,
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




describe('useDoseReminderScheduler — basic scheduling', () => {
  it('schedules a recurring dose reminder for each med with reminderEnabled + reminderTime', async () => {
    const med1 = makeMed({ id: 'med-a', name: 'A', reminderTime: '08:00' });
    const med2 = makeMed({ id: 'med-b', name: 'B', reminderTime: '14:00' });

    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med1, med2] })));

    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);

    expect(mocks.schedule).toHaveBeenCalledTimes(2);
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-a', 'A', '08:00', 1, 'قرص', 'd1', { allowManualTakeAction: false }
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-b', 'B', '14:00', 1, 'قرص', 'd1', { allowManualTakeAction: false }
    );
  });

  it('cancels then reschedules (stable id) on mount', async () => {
    const med = makeMed({ id: 'med-x', reminderTime: '09:00' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    expect(mocks.cancel).toHaveBeenCalledWith('med-x', 'd1');
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-x', 'Test Med', '09:00', 1, 'قرص', 'd1', { allowManualTakeAction: false }
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
      'med-exact-on', 'Test Med', '09:00', 1, 'قرص', 'd1', { allowManualTakeAction: false }
    );
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
      allowManualTakeAction: false,
      treatmentEndDate: '2024-09-14',
    });

    const shortened = {
      ...med,
      durationDays: 2,
    };
    rerender({ medications: [shortened] });

    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    expect(mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1][6]).toEqual({
      allowManualTakeAction: false,
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
      'med-multi', 'Drug A', '08:00', 2, 'قرص', 'd1', { allowManualTakeAction: false }
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-multi', 'Drug A', '14:00', 1, 'قرص', 'd2', { allowManualTakeAction: false }
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-multi', 'Drug A', '21:00', 1, 'قرص', 'd3', { allowManualTakeAction: false }
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
    await flushUntil(() => mocks.schedule.mock.calls.some((c) => c[5] === 'b'));

    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-add', 'AddMed', '14:00', 1, 'قرص', 'b', { allowManualTakeAction: false }
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
      mocks.schedule.mock.calls.some((c) => c[5] === 'a')
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.some((c) => c[5] === 'c')
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
    expect(mocks.schedule.mock.calls.some((c) => c[5] === 'a')).toBe(true);
    expect(mocks.schedule.mock.calls.some((c) => c[5] === 'c')).toBe(true);
    expect(mocks.schedule.mock.calls.some((c) => c[5] === 'b')).toBe(false);
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
      mocks.schedule.mock.calls.some((c) => c[2] === '15:00' && c[5] === 'x')
    );

    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-time', 'TimeMed', '15:00', 1, 'قرص', 'x', { allowManualTakeAction: false }
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
      mocks.schedule.mock.calls.some((c) => c[3] === 2 && c[5] === 'x')
    );

    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-amt', 'AmtMed', '10:00', 2, 'قرص', 'x', { allowManualTakeAction: false }
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
    const doseIds = mocks.schedule.mock.calls.map((c) => c[5]).sort();
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
      'med-on-multi', 'OnMed', '08:00', 1, 'قرص', 'a', { allowManualTakeAction: false }
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-on-multi', 'OnMed', '20:00', 1, 'قرص', 'b', { allowManualTakeAction: false }
    );
  });
});
