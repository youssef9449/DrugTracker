/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import { useDoseReminderScheduler } from './useDoseReminderScheduler';

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web' },
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: vi.fn(),
    cancel: vi.fn(),
    checkPermissions: vi.fn(),
    checkExactNotificationSetting: vi.fn(),
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
    ...overrides,
  };
}

function defaultOpts(overrides: Record<string, unknown> = {}) {
  return {
    medications: [] as Medication[],
    notificationsEnabled: true,
    hydrated: true,
    isFirstRun: false,
    exactAlarmEnabled: true as boolean | null,
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
      'med-a', 'A', '08:00', 1, 'قرص'
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-b', 'B', '14:00', 1, 'قرص'
    );
  });

  it('cancels then reschedules (stable id) on mount', async () => {
    const med = makeMed({ id: 'med-x', reminderTime: '09:00' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    expect(mocks.cancel).toHaveBeenCalledWith('med-x');
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

  it('does NOT schedule when exactAlarmEnabled is null', () => {
    const med = makeMed({ id: 'med-null', reminderTime: '09:00' });
    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med], exactAlarmEnabled: null }))
    );
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('does NOT schedule when exactAlarmEnabled is false', () => {
    const med = makeMed({ id: 'med-false', reminderTime: '09:00' });
    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med], exactAlarmEnabled: false }))
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

    expect(mocks.cancel).toHaveBeenCalledWith('med-disable');
  });

  it('does NOT schedule for a med with no reminderTime', () => {
    const med = makeMed({ id: 'med-notime', reminderEnabled: true, reminderTime: '' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

describe('useDoseReminderScheduler — exact-alarm gating', () => {
  it('cancels previously-scheduled alarms when exactAlarmEnabled turns false', async () => {
    const med = makeMed({ id: 'med-exact-off', reminderTime: '09:00' });
    const { rerender } = renderHook(
      ({ exactAlarmEnabled }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med], exactAlarmEnabled })
        ),
      { initialProps: { exactAlarmEnabled: true } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    rerender({ exactAlarmEnabled: false });
    await flushUntil(() => mocks.cancel.mock.calls.some((c) => c[0] === 'med-exact-off'));

    expect(mocks.cancel).toHaveBeenCalledWith('med-exact-off');
  });

  it('reschedules when exactAlarmEnabled turns from false to true', async () => {
    const med = makeMed({ id: 'med-exact-on', reminderTime: '09:00' });
    const { rerender } = renderHook(
      ({ exactAlarmEnabled }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med], exactAlarmEnabled })
        ),
      { initialProps: { exactAlarmEnabled: false } }
    );

    expect(mocks.schedule).not.toHaveBeenCalled();

    rerender({ exactAlarmEnabled: true });
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

    rerender({ notificationsEnabled: false });
    await flushUntil(() => mocks.cancel.mock.calls.length >= 2);

    expect(mocks.cancel).toHaveBeenCalledWith('med-off1');
    expect(mocks.cancel).toHaveBeenCalledWith('med-off2');
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

  it('does NOT reschedule when lastSyncDate changes', async () => {
    const med = makeMed({ id: 'med-sync', reminderTime: '09:00', lastSyncDate: '2024-09-09' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    const callsAfterFirst = mocks.schedule.mock.calls.length;

    const medUpdated = { ...med, lastSyncDate: '2024-09-10' };
    rerender({ medications: [medUpdated] });

    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.schedule.mock.calls.length).toBe(callsAfterFirst);
  });

  it('DOES reschedule when reminderTime changes', async () => {
    const med = makeMed({ id: 'med-time', reminderTime: '08:00' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    const medUpdated = { ...med, reminderTime: '09:00' };
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

  it('DOES reschedule when dailyDose changes (affects body)', async () => {
    const med = makeMed({ id: 'med-dose', dailyDose: 1, reminderTime: '09:00' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    const medUpdated = { ...med, dailyDose: 2 };
    rerender({ medications: [medUpdated] });

    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    const lastCall = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
    expect(lastCall[3]).toBe(2);
  });
});
