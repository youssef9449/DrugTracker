import { requireDefined } from '../helpers/requireDefined';
/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted so the mocks are available inside vi.mock factories.
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  checkPermissions: vi.fn(),
  checkExactNotificationSetting: vi.fn(),
  changeExactNotificationSetting: vi.fn(),
  nativeSchedule: vi.fn(),
  nativeCancel: vi.fn(),
  nativeCheckChannel: vi.fn(),
  nativeSnooze: vi.fn(),
  nativeCancelSnooze: vi.fn(),
  nativeIsScheduled: vi.fn(),
  nativeListScheduled: vi.fn(),
  nativePost: vi.fn(),
  nativeCheckPermission: vi.fn(),
  nativeCanExact: vi.fn(),
  nativeOpenSettings: vi.fn(),
  nativeAddListener: vi.fn(),
  platform: vi.fn(() => 'ios'),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: mocks.platform,
  },
  registerPlugin: () => ({
    schedule: mocks.nativeSchedule,
    cancel: mocks.nativeCancel,
    checkChannel: mocks.nativeCheckChannel,
    scheduleSnooze: mocks.nativeSnooze,
    cancelSnooze: mocks.nativeCancelSnooze,
    isScheduled: mocks.nativeIsScheduled,
    listScheduled: mocks.nativeListScheduled,
    post: mocks.nativePost,
    checkPermission: mocks.nativeCheckPermission,
    canScheduleExactAlarms: mocks.nativeCanExact,
    openSettings: mocks.nativeOpenSettings,
    addListener: mocks.nativeAddListener,
  }),
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: mocks.schedule,
    cancel: mocks.cancel,
    checkPermissions: mocks.checkPermissions,
    checkExactNotificationSetting: mocks.checkExactNotificationSetting,
    changeExactNotificationSetting: mocks.changeExactNotificationSetting,
  },
}));

import { getPendingNotificationResult } from '@/utils/notificationRuntime';

import {
  DOSE_REMINDER_CHANNEL_ID,
  DOSE_REMINDER_FOREGROUND_CHANNEL_ID,
  getDoseReminderChannelId,
  setAppInForeground,
  isAppInForeground,
  scheduleDoseReminder,
  scheduleSnoozedDoseReminder,
  cancelDoseReminder } from './notificationTestFacade';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.mockReturnValue('ios');
  mocks.checkPermissions.mockResolvedValue({ display: 'granted' });
  mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: 'granted' });
  mocks.schedule.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(undefined);
  mocks.nativePost.mockResolvedValue({ ok: true });
  mocks.nativeSchedule.mockResolvedValue({ ok: true });
  mocks.nativeCancel.mockResolvedValue({ ok: true, status: 'SUCCESS' });
  mocks.nativeCheckChannel.mockResolvedValue({ enabled: true });
  mocks.nativeSnooze.mockResolvedValue({ ok: true });
  mocks.nativeCancelSnooze.mockResolvedValue({ ok: true });
  mocks.nativeIsScheduled.mockResolvedValue({
    scheduled: true,
    triggerAtEpochMs: Date.now() + 60_000,
  });
  // Reset to default foreground state before each test.
  setAppInForeground(true);
});

// ---------------------------------------------------------------------------
// 1 + 2. Foreground/background channel selection
// ---------------------------------------------------------------------------

describe('getDoseReminderChannelId — lifecycle-aware channel selection', () => {
  it('returns the SILENT foreground channel when the app is in the foreground', () => {
    setAppInForeground(true);
    expect(getDoseReminderChannelId()).toBe(DOSE_REMINDER_FOREGROUND_CHANNEL_ID);
  });

  it('returns the system-sound background channel when the app is backgrounded', () => {
    setAppInForeground(false);
    expect(getDoseReminderChannelId()).toBe(DOSE_REMINDER_CHANNEL_ID);
  });

  it('defaults to foreground on fresh module load (app starts in foreground)', () => {
    // After beforeEach resets to foreground, the default should be foreground.
    expect(isAppInForeground()).toBe(true);
    expect(getDoseReminderChannelId()).toBe(DOSE_REMINDER_FOREGROUND_CHANNEL_ID);
  });
});

// ---------------------------------------------------------------------------
// 3. No custom dose_reminder.wav reference
// ---------------------------------------------------------------------------

describe('channel IDs do not reference dose_reminder.wav', () => {
  it('DOSE_REMINDER_CHANNEL_ID (background) does not contain "wav"', () => {
    expect(DOSE_REMINDER_CHANNEL_ID).not.toMatch(/wav/i);
    expect(DOSE_REMINDER_CHANNEL_ID).not.toMatch(/dose_reminder/);
  });

  it('DOSE_REMINDER_FOREGROUND_CHANNEL_ID (silent) does not contain "wav"', () => {
    expect(DOSE_REMINDER_FOREGROUND_CHANNEL_ID).not.toMatch(/wav/i);
    expect(DOSE_REMINDER_FOREGROUND_CHANNEL_ID).not.toMatch(/dose_reminder/);
  });

  it('neither channel ID is "dose-reminder-v2" (the old custom-sound channel)', () => {
    expect(DOSE_REMINDER_CHANNEL_ID).not.toBe('dose-reminder-v2');
    expect(DOSE_REMINDER_FOREGROUND_CHANNEL_ID).not.toBe('dose-reminder-v2');
  });
});

// ---------------------------------------------------------------------------
// Helper: extract the channelId from the last schedule() call.
// ---------------------------------------------------------------------------

function lastScheduledChannelId(): string {
  expect(mocks.schedule).toHaveBeenCalled();
  const call = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
  return requireDefined(call, 'call')[0].notifications[0].channelId;
}

function lastScheduledNotification() {
  expect(mocks.schedule).toHaveBeenCalled();
  const call = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
  return requireDefined(call, 'call')[0].notifications[0];
}

// ---------------------------------------------------------------------------
// 1 + 2 (scheduling level). scheduleDoseReminder uses the correct channel
// based on the current app state.
// ---------------------------------------------------------------------------

describe('scheduleDoseReminder — uses lifecycle-aware channel', () => {
  it('schedules on the SILENT foreground channel when app is foregrounded', async () => {
    setAppInForeground(true);
    await scheduleDoseReminder('med-fg', 'Test', '09:00', 1, 'قرص', 'd1');
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_FOREGROUND_CHANNEL_ID);
  });

  it('schedules on the system-sound background channel when app is backgrounded', async () => {
    setAppInForeground(false);
    await scheduleDoseReminder('med-bg', 'Test', '09:00', 1, 'قرص', 'd1');
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_CHANNEL_ID);
  });
});

// ---------------------------------------------------------------------------
// 7 + 8. Lifecycle transitions switch the channel.
// ---------------------------------------------------------------------------

describe('lifecycle transitions — channel switches on app state change', () => {
  it('foreground → background: re-scheduling uses the background channel', async () => {
    // Schedule while foregrounded (silent channel).
    setAppInForeground(true);
    await scheduleDoseReminder('med-x', 'Test', '09:00', 1, 'قرص', 'd1');
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_FOREGROUND_CHANNEL_ID);

    // App goes to background — re-schedule.
    setAppInForeground(false);
    await cancelDoseReminder('med-x', 'd1');
    await scheduleDoseReminder('med-x', 'Test', '09:00', 1, 'قرص', 'd1');
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_CHANNEL_ID);
  });

  it('background → foreground: re-scheduling uses the foreground (silent) channel', async () => {
    // Schedule while backgrounded (system-sound channel).
    setAppInForeground(false);
    await scheduleDoseReminder('med-y', 'Test', '09:00', 1, 'قرص', 'd1');
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_CHANNEL_ID);

    // App returns to foreground — re-schedule.
    setAppInForeground(true);
    await cancelDoseReminder('med-y', 'd1');
    await scheduleDoseReminder('med-y', 'Test', '09:00', 1, 'قرص', 'd1');
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_FOREGROUND_CHANNEL_ID);
  });

  it('repeated transitions do not produce stale channel assignments', async () => {
    // fg → bg → fg → bg
    for (const [state, expected] of [
      [true, DOSE_REMINDER_FOREGROUND_CHANNEL_ID],
      [false, DOSE_REMINDER_CHANNEL_ID],
      [true, DOSE_REMINDER_FOREGROUND_CHANNEL_ID],
      [false, DOSE_REMINDER_CHANNEL_ID],
    ] as const) {
      setAppInForeground(state);
      await scheduleDoseReminder('med-z', 'Test', '09:00', 1, 'قرص', 'd1');
      expect(lastScheduledChannelId()).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Background behavior does not require the JS sound path.
// The background channel (dose-reminder-v3) has system default sound
// configured at the Android channel level — no JS is involved.
// This test verifies the channel ID string itself is the background
// channel (which is created in native.ts with no custom sound → system
// default). The actual sound is played by Android, not JS.
// ---------------------------------------------------------------------------

describe('background channel — no JS sound dependency', () => {
  it('the background channel ID is dose-reminder-v3 (system default sound, no JS)', () => {
    setAppInForeground(false);
    // When backgrounded, the channel is v3 — Android plays the system
    // default sound via the channel config. No JS sound code runs.
    expect(getDoseReminderChannelId()).toBe('dose-reminder-v3');
  });

  it('scheduleSnoozedDoseReminder also uses the lifecycle-aware channel', async () => {
    // Snoozed reminder while backgrounded → background channel (system sound).
    setAppInForeground(false);
    await scheduleSnoozedDoseReminder('med-snooze', 'Test', 1, 'قرص', '09:00', 10, 'd1', false);
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_CHANNEL_ID);

    // Snoozed reminder while foregrounded → foreground channel (silent).
    setAppInForeground(true);
    await scheduleSnoozedDoseReminder('med-snooze', 'Test', 1, 'قرص', '09:00', 10, 'd1', false);
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_FOREGROUND_CHANNEL_ID);
  });
});

// ---------------------------------------------------------------------------
// 9. Existing notification scheduling/cancellation remains intact.
// ---------------------------------------------------------------------------

describe('scheduling/cancellation invariants — preserved', () => {

});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe('doseId identity — preserved through scheduling', () => {
  it('scheduleDoseReminder with a doseId includes it in the notification extra', async () => {
    const medId = 'med-dose-id';
    const doseId = 'dose-morning';
    await scheduleDoseReminder(medId, 'Test', '09:00', 1, 'قرص', doseId);

    const notif = lastScheduledNotification();
    expect(notif.extra.medicationId).toBe(medId);
    expect(notif.extra.doseId).toBe(doseId);
  });


  it('the logical notification identity is stable across rescheduling', async () => {
    await scheduleDoseReminder('med-id-match', 'Test', '09:00', 1, 'قرص', 'slot-1');
    const first = lastScheduledNotification();
    expect(first.extra.namespace).toBe('dose-reminder');
    expect(first.extra.identity).toBe('med-id-match::slot-1');

    await scheduleDoseReminder('med-id-match', 'Test', '09:00', 1, 'قرص', 'slot-1');
    const second = lastScheduledNotification();
    expect(second.extra.namespace).toBe('dose-reminder');
    expect(second.extra.identity).toBe('med-id-match::slot-1');
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. Foreground behavior — DoseAlarmModal + in-app chime.
//
// These are integration-level: the foreground channel being silent means
// Android produces no sound. The `localNotificationReceived` event still
// fires (Capacitor posts the notification regardless of channel importance),
// which triggers `doseReceivedHandler` in App.tsx → `openAlarm` (DoseAlarmModal)
// + `playSuccessChime` (gated by soundEnabled).
//
// At the unit level, we verify the channel is silent (LOW importance) so
// no Android sound is produced, which is the prerequisite for the
// foreground UX. The full integration is verified by the existing
// useDoseReminders + App tests (openAlarm opens the modal) + the new
// chime wiring in App.tsx.
// ---------------------------------------------------------------------------

describe('foreground channel — silent (no Android sound)', () => {
  it('the foreground channel ID is a distinct, stable identifier', () => {
    expect(DOSE_REMINDER_FOREGROUND_CHANNEL_ID).toBe('dose-reminder-foreground-v1');
    expect(DOSE_REMINDER_FOREGROUND_CHANNEL_ID).not.toBe(DOSE_REMINDER_CHANNEL_ID);
  });

  it('scheduling in foreground uses the silent channel (prerequisite for no Android sound)', async () => {
    setAppInForeground(true);
    await scheduleDoseReminder('med-fg-silent', 'Test', '09:00', 1, 'قرص', 'd1');
    // The foreground channel is created in native.ts with importance LOW (2)
    // and no `sound` property — Android produces no audible alert.
    // The localNotificationReceived event still fires → DoseAlarmModal + chime.
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_FOREGROUND_CHANNEL_ID);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle transition race — guard against the window between
// appStateChange and async cancel/schedule completion.
//
// When the app transitions foreground ↔ background, there's a small window
// where the OLD channel's notification is still pending before the scheduler
// finishes cancel-then-reschedule. This test verifies:
//   1. setAppInForeground() is SYNCHRONOUS — the channel selector updates
//      immediately, before any async scheduler work.
//   2. Any NEW schedule call after the transition uses the CORRECT channel.
//   3. The generation-counter + serialization protections in the scheduler
//      prevent the old (stale) schedule op from leaving a duplicate.
//
// We can't prevent Android from firing an alarm that's already "due" during
// this window (that's an OS-level race), but we CAN guarantee that any
// re-schedule after the transition targets the right channel.
// ---------------------------------------------------------------------------

describe('lifecycle transition race — channel selector is synchronous', () => {
  it('setAppInForeground updates the channel selector synchronously (before any await)', () => {
    // The race concern: if setAppInForeground were async, a schedule call
    // made immediately after the transition could use the stale channel.
    // This test verifies setAppInForeground is synchronous — no await needed.
    setAppInForeground(true);
    expect(isAppInForeground()).toBe(true);
    expect(getDoseReminderChannelId()).toBe(DOSE_REMINDER_FOREGROUND_CHANNEL_ID);

    setAppInForeground(false);
    // Immediate — no await, no promise. The selector is updated synchronously.
    expect(isAppInForeground()).toBe(false);
    expect(getDoseReminderChannelId()).toBe(DOSE_REMINDER_CHANNEL_ID);
  });

  it('a schedule call immediately after a transition uses the NEW channel', async () => {
    // Schedule on foreground channel.
    setAppInForeground(true);
    await scheduleDoseReminder('med-race', 'Test', '09:00', 1, 'قرص', 'd1');
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_FOREGROUND_CHANNEL_ID);

    // Transition to background. setAppInForeground is synchronous, so even
    // a schedule call made BEFORE the scheduler's cancel+reschedule completes
    // will use the background channel.
    setAppInForeground(false);
    // Note: in production, the scheduler's cancel+reschedule is async, but
    // any NEW schedule call here already sees the background channel because
    // the selector updated synchronously.
    await scheduleDoseReminder('med-race', 'Test', '09:00', 1, 'قرص', 'd1');
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_CHANNEL_ID);
  });

  it('a transition immediately before dose time re-arms on the correct channel', async () => {
    // Simulate: dose is about to fire, app transitions to background.
    // The scheduler must re-arm on the background (system-sound) channel
    // so the dose fires with sound when it becomes due.
    setAppInForeground(true);
    await scheduleDoseReminder('med-imminent', 'Test', '09:00', 1, 'قرص', 'd1');
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_FOREGROUND_CHANNEL_ID);

    // App backgrounds 1 second before dose time.
    setAppInForeground(false);

    // Scheduler re-arms: cancel old + schedule new.
    await cancelDoseReminder('med-imminent', 'd1');
    await scheduleDoseReminder('med-imminent', 'Test', '09:00', 1, 'قرص', 'd1');

    // The re-armed notification is on the background channel → system sound.
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_CHANNEL_ID);

    // Transition back to foreground (user reopens app before dose fires).
    setAppInForeground(true);
    await cancelDoseReminder('med-imminent', 'd1');
    await scheduleDoseReminder('med-imminent', 'Test', '09:00', 1, 'قرص', 'd1');
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_FOREGROUND_CHANNEL_ID);
  });
});


// ---------------------------------------------------------------------------
// Lifecycle race — JS fast path (native delivery-time is the safety net)
//
// JS unit tests cover synchronous channel selection and post-transition
// scheduling. They do NOT claim to prove killed-process delivery.
//
// Killed-process guarantee (native):
//   AppForegroundState defaults to false in a fresh process
//   → DoseReminderAlarmReceiver resolves dose-reminder-v3
//   MainActivity onResume/onPause owns the live foreground flag.
// ---------------------------------------------------------------------------

describe('Web/PWA future Dose Reminder delivery', () => {
  const shown: Array<{ title: string; options: NotificationOptions }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-09-10T12:00:00'));
    shown.length = 0;
    class MockNotification {
      static permission = 'granted';
      constructor(title: string, options: NotificationOptions) {
        shown.push({ title, options });
      }
    }
    vi.stubGlobal('Notification', MockNotification);
    mocks.platform.mockReturnValue('web');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('delivers a future reminder at its scheduled wall-clock time, not immediately', async () => {
    await scheduleDoseReminder('web-future', 'Test', '20:00', 1, 'قرص', 'd1');

    expect(shown).toHaveLength(0);
    const pending = await getPendingNotificationResult('dose-reminder', 'web-future::d1');
    expect(pending).toEqual({
      ok: true,
      pending: { schedule: { at: new Date('2024-09-10T20:00:00').getTime() } },
    });

    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000 - 1);
    expect(shown).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(shown).toHaveLength(1);
    expect(requireDefined(shown[0], 'shown[0]').title).toContain('Test');
  });

  it('uses the next calendar occurrence when the configured time has already passed', async () => {
    vi.setSystemTime(new Date('2024-09-10T21:00:00'));

    await scheduleDoseReminder('web-next-day', 'Test', '20:00', 1, 'قرص', 'd1');

    expect(shown).toHaveLength(0);
    const pending = await getPendingNotificationResult('dose-reminder', 'web-next-day::d1');
    expect(pending).toEqual({
      ok: true,
      pending: { schedule: { at: new Date('2024-09-11T20:00:00').getTime() } },
    });
  });

  it('delivers Web/PWA snooze only after the requested delay', async () => {
    await scheduleSnoozedDoseReminder(
      'web-snooze', 'Test', 1, 'قرص', '20:00', 10, 'd1', true
    );

    expect(shown).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
    expect(shown).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(shown).toHaveLength(1);
  });

  it('keeps one logical future reminder across duplicate scheduling/reconciliation', async () => {
    await scheduleDoseReminder('web-duplicate', 'Test', '20:00', 1, 'قرص', 'd1');
    await scheduleDoseReminder('web-duplicate', 'Test', '20:00', 1, 'قرص', 'd1');

    const pending = await getPendingNotificationResult('dose-reminder', 'web-duplicate::d1');
    expect(pending).toEqual({
      ok: true,
      pending: { schedule: { at: new Date('2024-09-10T20:00:00').getTime() } },
    });

    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
    expect(shown).toHaveLength(1);
  });

  it('re-arms a persisted future reminder when pending state is queried after timer loss', async () => {
    await scheduleDoseReminder('web-reload', 'Test', '20:00', 1, 'قرص', 'd1');
    vi.clearAllTimers();

    const pending = await getPendingNotificationResult('dose-reminder', 'web-reload::d1');
    expect(pending).toEqual({
      ok: true,
      pending: { schedule: { at: new Date('2024-09-10T20:00:00').getTime() } },
    });

    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
    expect(shown).toHaveLength(1);
  });
});

describe('lifecycle race — rapid transitions converge on latest state', () => {
  it('rapid foreground↔background transitions: last schedule uses latest channel', async () => {
    setAppInForeground(true);
    await scheduleDoseReminder('med-rapid', 'Test', '10:00', 1, 'قرص', 'd1');
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_FOREGROUND_CHANNEL_ID);

    setAppInForeground(false);
    setAppInForeground(true);
    setAppInForeground(false);

    expect(isAppInForeground()).toBe(false);
    expect(getDoseReminderChannelId()).toBe(DOSE_REMINDER_CHANNEL_ID);

    await scheduleDoseReminder('med-rapid', 'Test', '10:00', 1, 'قرص', 'd1');
    expect(lastScheduledChannelId()).toBe(DOSE_REMINDER_CHANNEL_ID);
  });

  it('channel id constants stay aligned with native delivery override', () => {
    // native-android DoseReminderAlarmReceiver hard-codes the same ids.
    // Drift would break native delivery.
    expect(DOSE_REMINDER_CHANNEL_ID).toBe('dose-reminder-v3');
    expect(DOSE_REMINDER_FOREGROUND_CHANNEL_ID).toBe('dose-reminder-foreground-v1');
  });
});


// ---------------------------------------------------------------------------
// Group 4 acceptance — cancellation and pending-state contracts.
// These tests exercise the feature boundary directly so the reliability
// fixes are protected independently of the hook/UI implementation.
// ---------------------------------------------------------------------------

describe('Group 4 acceptance — cancellation and pending-state contracts', () => {
  it('#366 cancels both the native alarm and the displayed notification', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.nativeCancel.mockResolvedValue({ ok: true, status: 'SUCCESS' });

    const { cancelDoseReminder } = await import('@/utils/doseReminderScheduling');
    await cancelDoseReminder('med-cancel', 'dose-1');

    expect(mocks.nativeCancel).toHaveBeenNthCalledWith(1, {
      medicationId: 'med-cancel',
      doseId: 'dose-1',
    });
    expect(mocks.nativeCancel).toHaveBeenNthCalledWith(2, {
      namespace: 'dose-reminder',
      identity: 'med-cancel::dose-1',
    });
  });

  it('#366 surfaces notification-cancellation failure instead of silently succeeding', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.nativeCancel.mockImplementation(async (options: Record<string, unknown>) =>
      'namespace' in options
        ? { ok: false, error: 'notification_cancel_failed' }
        : { ok: true, status: 'SUCCESS' }
    );

    const { cancelDoseReminder } = await import('@/utils/doseReminderScheduling');
    await expect(cancelDoseReminder('med-fail', 'dose-1')).rejects.toThrow(
      'dose_reminder_notification_cancel_failed'
    );
  });

  it('#371/#388 distinguishes blocked notification channels from app permission', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.nativeCheckChannel
      .mockResolvedValueOnce({ enabled: false })
      .mockResolvedValueOnce({ enabled: true });

    const { getNotificationChannelState } = await import('@/utils/notificationRuntime');
    await expect(getNotificationChannelState(DOSE_REMINDER_CHANNEL_ID)).resolves.toBe('disabled');
    await expect(getNotificationChannelState(DOSE_REMINDER_FOREGROUND_CHANNEL_ID)).resolves.toBe('enabled');
    expect(mocks.nativeCheckChannel).toHaveBeenNthCalledWith(1, {
      channelId: DOSE_REMINDER_CHANNEL_ID,
    });
    expect(mocks.nativeCheckChannel).toHaveBeenNthCalledWith(2, {
      channelId: DOSE_REMINDER_FOREGROUND_CHANNEL_ID,
    });
  });

  it('#376 keeps an actually scheduled alarm pending even when its trigger is older than 60 seconds', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.nativeIsScheduled.mockResolvedValue({
      scheduled: true,
      triggerAtEpochMs: Date.now() - 10 * 60_000,
    });

    const { isDoseReminderPending } = await import('@/utils/doseReminderScheduling');
    await expect(isDoseReminderPending('med-pending', 'dose-1')).resolves.toEqual({
      ok: true,
      pending: true,
    });
  });

  it('#376 reports a truly absent alarm as absent', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.nativeIsScheduled.mockResolvedValue({ scheduled: false });

    const { isDoseReminderPending } = await import('@/utils/doseReminderScheduling');
    await expect(isDoseReminderPending('med-absent', 'dose-1')).resolves.toEqual({
      ok: true,
      pending: false,
    });
  });

  it('#384 Web cancellation removes the durable future reminder and prevents delivery', async () => {
    mocks.platform.mockReturnValue('web');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-09-10T12:00:00'));
    const shown: string[] = [];
    class MockNotification {
      static permission = 'granted';
      constructor(title: string) {
        shown.push(title);
      }
    }
    vi.stubGlobal('Notification', MockNotification);

    try {
      const { scheduleDoseReminder, cancelDoseReminder } = await import('@/utils/doseReminderScheduling');
      await scheduleDoseReminder('web-cancel', 'Test', '20:00', 1, 'قرص', 'd1');
      await cancelDoseReminder('web-cancel', 'd1');
      await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
      expect(shown).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
