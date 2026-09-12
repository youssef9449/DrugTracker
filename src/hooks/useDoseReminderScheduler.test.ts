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
  cancelSnoozed: vi.fn(),
}));

vi.mock('../utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('../utils/notifications')>(
    '../utils/notifications'
  );
  return {
    ...actual,
    scheduleDoseReminder: mocks.schedule,
    cancelDoseReminder: mocks.cancel,
    cancelSnoozedDoseReminder: mocks.cancelSnoozed,
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
  mocks.cancel.mockResolvedValue(undefined);
  mocks.cancelSnoozed.mockResolvedValue(undefined);
  mocks.schedule.mockResolvedValue(undefined);
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

    expect(mocks.cancel).toHaveBeenCalledWith('med-x', 'legacy');
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

    expect(mocks.cancel).toHaveBeenCalledWith('med-disable', 'legacy');
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

    expect(mocks.cancel).toHaveBeenCalledWith('med-exact-off', 'legacy');
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

    expect(mocks.cancel).toHaveBeenCalledWith('med-del', 'legacy');
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

    expect(mocks.cancel).toHaveBeenCalledWith('med-off1', 'legacy');
    expect(mocks.cancel).toHaveBeenCalledWith('med-off2', 'legacy');
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

describe('useDoseReminderScheduler — consumption suppression (today\u2019s dose taken)', () => {
  const SNOOZE_KEY = 'android_med_tracker_snooze_v1';

  it('Test 1 — consumed today BEFORE the reminder time: cold start suppresses today\u2019s reminder and re-arms from tomorrow', async () => {
    // reminder 20:00, now 12:00, dose already consumed today.
    const med = makeMed({
      id: 'med-consumed',
      reminderTime: '20:00',
      lastConsumedDate: getTodayDateString(),
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() =>
      mocks.schedule.mock.calls.some((c) => c[0] === 'med-consumed')
    );

    // The recurring alarm was cancelled (today's occurrence suppressed)…
    expect(mocks.cancel).toHaveBeenCalledWith('med-consumed', 'legacy');
    // …and re-armed as the SAME recurring daily schedule starting
    // TOMORROW (skipToday) — tomorrow's reminder remains scheduled.
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-consumed',
      'Test Med',
      '20:00',
      1,
      '\u0642\u0631\u0635',
      { skipToday: true }
    );
    // Any pending snoozed one-shot for the taken dose was cancelled.
    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-consumed', 'legacy');
  });

  it('Test 1b — live manual consumption while the app is running: suppression fires on the consumedSignature change', async () => {
    // Dose NOT taken at mount — normal schedule.
    const med = makeMed({ id: 'med-live', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule.mock.calls[0][0]).toBe('med-live');
    expect(mocks.schedule.mock.calls[0]).toHaveLength(5); // no skipToday
    const schedulesBefore = mocks.schedule.mock.calls.length;

    // User manually takes the dose at 12:00 (before the 20:00 reminder):
    // consumeDose sets lastConsumedDate = today → state re-render.
    const medConsumed = { ...med, lastConsumedDate: getTodayDateString() };
    rerender({ medications: [medConsumed] });

    await flushUntil(() =>
      mocks.schedule.mock.calls.length > schedulesBefore ||
      mocks.cancel.mock.calls.some((c) => c[0] === 'med-live')
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.length > schedulesBefore
    );

    // Today's pending recurring occurrence was cancelled…
    expect(mocks.cancel).toHaveBeenCalledWith('med-live', 'legacy');
    // …and the recurring alarm re-armed from tomorrow (skipToday).
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-live',
      'Test Med',
      '20:00',
      1,
      '\u0642\u0631\u0635',
      { skipToday: true }
    );
    // Pending snoozed reminder for the taken dose cancelled too.
    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-live', 'legacy');
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
      lastConsumedDate: getTodayDateString(),
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-tomorrow' && c[5]?.skipToday === true
      )
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-tomorrow', 'Test Med', '20:00', 1, '\u0642\u0631\u0635', { skipToday: true }
    );
  });

  it('Test 3 — consumed today AFTER the reminder already fired: no undo of the fired notification, snooze cleanup only', async () => {
    // now = 21:00, reminder 20:00 already fired, dose consumed at 21:00.
    vi.setSystemTime(new Date('2024-09-10T21:00:00Z'));
    const med = makeMed({
      id: 'med-after',
      reminderTime: '20:00',
      lastConsumedDate: getTodayDateString(),
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
      'med-after', 'Test Med', '20:00', 1, '\u0642\u0631\u0635', { skipToday: true }
    );
    // A pending snoozed one-shot (e.g. a 90-min snooze from the 20:00
    // fire) is still cancelled — a snoozed reminder for a taken dose
    // must never fire.
    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-after', 'legacy');
  });

  it('Test 4/5 — app resume after a manual dose re-applies the suppression (reconciliation)', async () => {
    const med = makeMed({
      id: 'med-resume',
      reminderTime: '20:00',
      lastConsumedDate: getTodayDateString(),
    });
    const { rerender } = renderHook(
      ({ resumeTick }) =>
        useDoseReminderScheduler(defaultOpts({ medications: [med], resumeTick })),
      { initialProps: { resumeTick: 0 } }
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-resume' && c[5]?.skipToday === true
      )
    );
    const cancelsBefore = mocks.cancel.mock.calls.filter((c) => c[0] === 'med-resume').length;
    const schedulesBefore = mocks.schedule.mock.calls.length;

    // Resume (appStateChange) → resumeTick bump → suppression effect
    // re-runs and re-applies (idempotent): cancel + skipToday re-arm.
    rerender({ resumeTick: 1 });
    await flushUntil(() => mocks.schedule.mock.calls.length > schedulesBefore);

    expect(mocks.cancel).toHaveBeenCalledWith('med-resume', 'legacy');
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-resume', 'Test Med', '20:00', 1, '\u0642\u0631\u0635', { skipToday: true }
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
    rerender({ medications: [{ ...med, lastConsumedDate: getTodayDateString() }] });
    await flushUntil(() => mocks.cancelSnoozed.mock.calls.length >= 1);

    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-snooze-consumed', 'legacy');
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
      lastConsumedDate: '2024-09-09', // yesterday (today = 2024-09-10)
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

  it('Test 10 — a pure stock change (currentPills/lastSyncDate) without consumption does NOT suppress or reschedule', async () => {
    const med = makeMed({ id: 'med-stock2', reminderTime: '09:00', currentPills: 30 });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    const schedulesBefore = mocks.schedule.mock.calls.length;

    rerender({ medications: [{ ...med, currentPills: 29, lastSyncDate: '2024-09-10' }] });
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
    rerender({ medications: [{ ...med, name: 'Renamed Med', lastConsumedDate: getTodayDateString() }] });

    // Release the gate; let everything settle.
    gateHolder.release();
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-race' && c[5]?.skipToday === true
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
    expect(postRerenderSchedules[0][5]).toEqual({ skipToday: true });
  });

  it('Test 11b — reminder-config change AFTER a consumption cannot resurrect today\u2019s reminder (skipToday baked into every reschedule)', async () => {
    // Consumed at 12:00 → suppressed. At 14:00 the user renames the med
    // → the main effect re-runs → its schedule MUST still skip today.
    const med = makeMed({
      id: 'med-rename',
      reminderTime: '20:00',
      lastConsumedDate: getTodayDateString(),
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-rename' && c[5]?.skipToday === true
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
      'med-rename', 'Renamed', '20:00', 1, '\u0642\u0631\u0635', { skipToday: true }
    );
  });

  it('suppression is gated when notifications are disabled (the main cancel-all owns that path)', () => {
    const med = makeMed({
      id: 'med-gated',
      reminderTime: '20:00',
      lastConsumedDate: getTodayDateString(),
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

  it('legacy med without doseSchedule still schedules exactly one notification', async () => {
    const med = makeMed({
      id: 'med-legacy',
      reminderEnabled: true,
      reminderTime: '20:00',
      dailyDose: 2,
      doseSchedule: undefined,
      dosesPerDay: undefined,
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-legacy', 'Test Med', '20:00', 2, 'قرص'
    );
  });

  it('legacy med with reminders disabled schedules zero notifications', async () => {
    const med = makeMed({
      id: 'med-legacy-off',
      reminderEnabled: false,
      reminderTime: '20:00',
      doseSchedule: undefined,
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

    expect(mocks.cancel).toHaveBeenCalledWith('med-rm', 'b');
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


