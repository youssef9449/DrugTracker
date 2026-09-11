/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication, CustomSoundFile } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import { useDoseReminderScheduler } from './useDoseReminderScheduler';

// Mock @capacitor/core so isNativePlatform() returns false (web path),
// which makes cancelDoseReminder a no-op and scheduleDoseReminder
// fall through to the web fallback (also a no-op in tests). The mocks
// for the notification functions let us assert on call counts.
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web' },
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: vi.fn(),
    cancel: vi.fn(),
    checkPermissions: vi.fn(),
  },
}));

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('../utils/notifications')>(
    '../utils/notifications'
  );
  return {
    ...actual,
    scheduleDoseReminder: mocks.schedule,
    cancelDoseReminder: mocks.cancel,
  };
});

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: getTodayDateString(),
    reminderEnabled: true,
    reminderTime: '09:00',
    notificationSound: 'classic_chime',
    ...overrides,
  };
}

function defaultOpts(overrides: Record<string, unknown> = {}) {
  return {
    medications: [] as Medication[],
    notificationsEnabled: true,
    hydrated: true,
    isFirstRun: false,
    exactAlarmEnabled: true,
    appInForeground: true,
    globalCustomSound: null as CustomSoundFile | null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  mocks.schedule.mockReset();
  mocks.cancel.mockReset();
  mocks.cancel.mockResolvedValue(undefined);
  mocks.schedule.mockResolvedValue(undefined);
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
      'med-a', 'A', '08:00', 1, 'قرص', 30, null, 'classic_chime', 'dose-reminder-foreground-v1'
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-b', 'B', '14:00', 1, 'قرص', 30, null, 'classic_chime', 'dose-reminder-foreground-v1'
    );
  });

  it('cancels then reschedules (stable id) on mount', async () => {
    const med = makeMed({ id: 'med-x', reminderTime: '09:00' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    expect(mocks.cancel).toHaveBeenCalledWith('med-x');
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-x', 'Test Med', '09:00', 1, 'قرص', 30, null, 'classic_chime', 'dose-reminder-foreground-v1'
    );
  });
});

describe('useDoseReminderScheduler — gating', () => {
  it('does NOT schedule before hydration (avoids phantom alarms for seed data)', () => {
    const med = makeMed({ id: 'med-seed', reminderTime: '09:00' });
    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med], hydrated: false }))
    );
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('does NOT schedule on first run (no real saved meds)', () => {
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

  it('does NOT schedule for a med with reminderEnabled false', () => {
    // A med that starts with reminder disabled has no previously-scheduled
    // alarm to cancel, so neither cancel nor schedule should be called.
    const med = makeMed({ id: 'med-noreminder', reminderEnabled: false, reminderTime: '09:00' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('cancels the alarm when reminderEnabled is turned off on an already-scheduled med', async () => {
    const med = makeMed({ id: 'med-disable', reminderEnabled: true, reminderTime: '09:00' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    // First render: alarm scheduled.
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    // Turn off reminderEnabled → cancel the previously-scheduled alarm.
    const medDisabled = { ...med, reminderEnabled: false };
    rerender({ medications: [medDisabled] });
    await flushUntil(() => mocks.cancel.mock.calls.some((c) => c[0] === 'med-disable'));

    expect(mocks.cancel).toHaveBeenCalledWith('med-disable');
  });

  it('does NOT schedule for a med with no reminderTime', () => {
    const med = makeMed({ id: 'med-notime', reminderEnabled: true, reminderTime: '' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));
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

    // Remove the med → the scheduler must cancel its alarm.
    rerender({ medications: [] });
    await flushUntil(() => mocks.cancel.mock.calls.some((c) => c[0] === 'med-del'));

    expect(mocks.cancel).toHaveBeenCalledWith('med-del');
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

    // Turn off notifications → both alarms cancelled.
    rerender({ notificationsEnabled: false });
    await flushUntil(() => mocks.cancel.mock.calls.length >= 2);

    expect(mocks.cancel).toHaveBeenCalledWith('med-off1');
    expect(mocks.cancel).toHaveBeenCalledWith('med-off2');
  });
});

describe('useDoseReminderScheduler — exact-alarm gating', () => {
  it('does NOT schedule when exactAlarmEnabled is false (inexact alarms unacceptable)', () => {
    const med = makeMed({ id: 'med-noexact', reminderTime: '09:00' });
    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med], exactAlarmEnabled: false }))
    );
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('does NOT schedule while exact-alarm permission is still unknown', () => {
    const med = makeMed({ id: 'med-unknown', reminderTime: '09:00' });
    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med], exactAlarmEnabled: null }))
    );
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('cancels previously-scheduled alarms when exactAlarmEnabled turns false', async () => {
    const med = makeMed({ id: 'med-exact-off', reminderTime: '09:00' });
    const { rerender } = renderHook(
      ({ exactAlarmEnabled }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med], exactAlarmEnabled })
        ),
      { initialProps: { exactAlarmEnabled: true } }
    );

    // First render: alarm scheduled.
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    // Exact-alarm permission revoked → cancel the alarm, don't reschedule.
    rerender({ exactAlarmEnabled: false });
    await flushUntil(() => mocks.cancel.mock.calls.some((c) => c[0] === 'med-exact-off'));

    expect(mocks.cancel).toHaveBeenCalledWith('med-exact-off');
  });

  it('reschedules when exactAlarmEnabled turns from false to true (user granted permission)', async () => {
    const med = makeMed({ id: 'med-exact-on', reminderTime: '09:00' });
    const { rerender } = renderHook(
      ({ exactAlarmEnabled }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med], exactAlarmEnabled })
        ),
      { initialProps: { exactAlarmEnabled: false } }
    );

    // First render: exact-alarm disabled → no schedule.
    expect(mocks.schedule).not.toHaveBeenCalled();

    // User grants exact-alarm → reschedule.
    rerender({ exactAlarmEnabled: true });
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-exact-on', 'Test Med', '09:00', 1, 'قرص', 30, null, 'classic_chime', 'dose-reminder-foreground-v1'
    );
  });
});

describe('useDoseReminderScheduler — custom sound', () => {
  it('passes the global custom sound to scheduleDoseReminder', async () => {
    const med = makeMed({ id: 'med-snd', reminderTime: '09:00' });
    const customSound = {
      fileName: 'bell.mp3',
      mimeType: 'audio/mpeg',
      dataUrl: 'data:audio/mpeg;base64,AAAA',
    };
    renderHook(() =>
      useDoseReminderScheduler(
        defaultOpts({ medications: [med], globalCustomSound: customSound })
      )
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-snd',
      'Test Med',
      '09:00',
      1,
      'قرص',
      30,
      customSound,
      'classic_chime',
      'dose-reminder-foreground-v1'
    );
  });

  it('re-schedules when the custom sound changes', async () => {
    const med = makeMed({ id: 'med-chsnd', reminderTime: '09:00' });
    const sound1 = { fileName: 'a.mp3', mimeType: 'audio/mpeg', dataUrl: 'data:audio/mpeg;base64,AAAA' };
    const sound2 = { fileName: 'b.mp3', mimeType: 'audio/mpeg', dataUrl: 'data:audio/mpeg;base64,BBBB' };
    const { rerender } = renderHook(
      ({ globalCustomSound }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med], globalCustomSound })
        ),
      { initialProps: { globalCustomSound: sound1 } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    const callsAfterFirst = mocks.schedule.mock.calls.length;

    // Change the custom sound → re-schedule.
    rerender({ globalCustomSound: sound2 });
    await flushUntil(() => mocks.schedule.mock.calls.length > callsAfterFirst);

    // The latest schedule call must carry the NEW sound.
    const lastCall = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
    expect(lastCall[6]).toEqual(sound2);
  });
});

describe('useDoseReminderScheduler — channel policy', () => {
  it('moves the stable daily reminder to the audible channel when backgrounded', async () => {
    const med = makeMed({ id: 'med-background' });
    const { rerender } = renderHook(
      ({ appInForeground }) =>
        useDoseReminderScheduler(defaultOpts({ medications: [med], appInForeground })),
      { initialProps: { appInForeground: true } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    rerender({ appInForeground: false });
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);

    const lastCall = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
    expect(lastCall[lastCall.length - 1]).toBe('dose-reminder-v2');
  });
});
