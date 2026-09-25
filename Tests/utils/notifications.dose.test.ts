import { requireDefined } from '../helpers/requireDefined';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted so the mocks are available inside vi.mock factories.
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  checkPermissions: vi.fn(),
  checkExactNotificationSetting: vi.fn(),
  nativeSchedule: vi.fn(),
  nativeCancel: vi.fn(),
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
  },
}));

import {
  scheduleDoseReminder,
  scheduleSnoozedDoseReminder,
  isDoseReminderTimeStillAhead,
} from './notificationTestFacade';

/**
 * Extract the scheduled payload (id + schedule) of the LAST
 * LocalNotifications.schedule() call for the recurring dose alarm.
 */
function lastDoseSchedulePayload(): {
  at: Date;
  repeats: boolean | undefined;
  every: string | undefined;
  allowWhileIdle: boolean | undefined;
  namespace: string | undefined;
  identity: string | undefined;
} {
  expect(mocks.schedule).toHaveBeenCalled();
  const call = requireDefined(
    mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1],
    'schedule call'
  );
  const request = requireDefined(call[0], 'schedule request');
  const n = requireDefined(request.notifications[0], 'notification');
  return {
    at: n.schedule.at as Date,
    // Phase 2: dose reminders are ONE-SHOT (no Capacitor repeats/every —
    // those use setRepeating with a wrong interval for daily wall-clock
    // times). Recurrence is owned by the native re-arm path
    // (DoseReminderAlarmReceiver / next-day re-arm), not by this payload.
    repeats: n.schedule.repeats as boolean | undefined,
    every: n.schedule.every as string | undefined,
    allowWhileIdle: n.schedule.allowWhileIdle as boolean | undefined,
    // Notification Runtime forwards only the LOGICAL identity as extra:
    // feature payload fields (medicationId/doseId/reminderTime/…) stay in
    // the runtime options and never reach the platform payload.
    namespace: (n.extra as { namespace?: string } | undefined)?.namespace,
    identity: (n.extra as { identity?: string } | undefined)?.identity,
  };
}

/** Local-time Y/M/D of a Date, zero-padded — for assertions. */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2024, 8, 10, 12, 0, 0)); // 2024-09-10 12:00 local
  mocks.platform.mockReturnValue('ios');
  mocks.checkPermissions.mockResolvedValue({ display: 'granted' });
  mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: 'granted' });
  mocks.schedule.mockResolvedValue({ notifications: [] });
  mocks.nativeSchedule.mockResolvedValue({ ok: true });
  mocks.nativeCancel.mockResolvedValue({ ok: true, status: 'SUCCESS' });
  mocks.nativeSnooze.mockResolvedValue({ ok: true });
  mocks.nativeCancelSnooze.mockResolvedValue({ ok: true });
  mocks.nativeIsScheduled.mockResolvedValue({
    scheduled: true,
    triggerAtEpochMs: Date.now() + 60_000,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Android Phase 6 scheduling boundary', () => {
  it('uses the Dose Reminder exact-alarm bridge and does not call LocalNotifications.schedule', async () => {
    mocks.platform.mockReturnValue('android');
    await scheduleDoseReminder('med-android', 'Test', '20:00', 2, 'قرص', 'd1');

    expect(mocks.nativeSchedule).toHaveBeenCalledTimes(1);
    expect(mocks.schedule).not.toHaveBeenCalled();

    const options = requireDefined(mocks.nativeSchedule.mock.calls[0], 'mocks.nativeSchedule.mock.calls[0]')[0];
    expect(options.medicationId).toBe('med-android');
    expect(options.doseId).toBe('d1');
    expect(options.reminderTime).toBe('20:00');
    expect(options.amount).toBe(2);
    expect(options.triggerAtEpochMs).toBeGreaterThan(Date.now());
  });

  it('passes the per-dose instruction to the native reminder payload', async () => {
    mocks.platform.mockReturnValue('android');
    await scheduleDoseReminder('med-android-description', 'Test', '20:00', 2, 'قرص', 'd1', {
      doseDescription: 'بعد الإفطار',
    });

    const options = requireDefined(mocks.nativeSchedule.mock.calls[0], 'mocks.nativeSchedule.mock.calls[0]')[0];
    expect(options.doseDescription).toBe('بعد الإفطار');
  });

});

describe('scheduleDoseReminder — skipToday (consumed-day suppression)', () => {
  it('baseline: without options, a still-future reminder time fires TODAY', async () => {
    // now = 12:00, reminder 20:00 → today at 20:00.
    await scheduleDoseReminder('med-1', 'Test', '20:00', 1, 'قرص', 'd1');

    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const payload = lastDoseSchedulePayload();
    expect(payload.at.getFullYear()).toBe(2024);
    expect(payload.at.getMonth()).toBe(8);
    expect(payload.at.getDate()).toBe(10);
    expect(payload.at.getHours()).toBe(20);
    expect(payload.at.getMinutes()).toBe(0);
    // Phase 2 contract: one-shot schedule (no Capacitor repeats/every).
    // Recurrence is owned by the native re-arm path; the payload carries
    // the logical namespace + identity used for replace/cancel.
    expect(payload.repeats).toBeUndefined();
    expect(payload.every).toBeUndefined();
    expect(payload.namespace).toBe('dose-reminder');
    expect(payload.identity).toBe('med-1::d1');
    expect(payload.allowWhileIdle).toBe(true);
  });

  it('skipToday: an already-consumed day re-arms the recurring alarm from TOMORROW (same HH:MM, still repeats daily)', async () => {
    // now = 12:00, reminder 20:00 still ahead — but today's dose was
    // consumed, so the first occurrence must be tomorrow 20:00.
    await scheduleDoseReminder('med-1', 'Test', '20:00', 1, 'قرص', 'd1', { skipToday: true });

    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const payload = lastDoseSchedulePayload();
    expect(ymd(payload.at)).toBe('2024-09-11'); // tomorrow
    expect(payload.at.getHours()).toBe(20);
    expect(payload.at.getMinutes()).toBe(0);
    // Phase 2 contract: one-shot schedule (no Capacitor repeats/every).
    // Recurrence is owned by the native re-arm path; the payload carries
    // the logical namespace + identity used for replace/cancel.
    expect(payload.repeats).toBeUndefined();
    expect(payload.every).toBeUndefined();
    expect(payload.namespace).toBe('dose-reminder');
    expect(payload.identity).toBe('med-1::d1');
  });

  it('skipToday after the reminder time already passed: exactly ONE day increment (tomorrow, never the day after)', async () => {
    // now = 21:00, reminder 20:00 already passed → normal logic gives
    // tomorrow; skipToday must NOT add a second increment.
    vi.setSystemTime(new Date(2024, 8, 10, 21, 0, 0));
    await scheduleDoseReminder('med-1', 'Test', '20:00', 1, 'قرص', 'd1', { skipToday: true });

    const payload = lastDoseSchedulePayload();
    expect(ymd(payload.at)).toBe('2024-09-11'); // tomorrow — not 2024-09-12
    expect(payload.at.getHours()).toBe(20);
  });

  it('without options after the reminder time passed: tomorrow as before (existing behavior unchanged)', async () => {
    vi.setSystemTime(new Date(2024, 8, 10, 21, 0, 0));
    await scheduleDoseReminder('med-1', 'Test', '20:00', 1, 'قرص', 'd1');

    const payload = lastDoseSchedulePayload();
    expect(ymd(payload.at)).toBe('2024-09-11');
  });

  it('skipToday on web: no immediate web fallback fires for a consumed day', async () => {
    mocks.platform.mockReturnValue('web');
    await scheduleDoseReminder('med-1', 'Test', '20:00', 1, 'قرص', 'd1', { skipToday: true });

    // Neither the native bridge nor the web immediate fallback fired —
    // the day's reminder is consumed.
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

});

describe('isDoseReminderTimeStillAhead — suppression boundary', () => {
  it('returns true when today\u2019s HH:MM is still in the future', () => {
    // now = 12:00, reminder 20:00.
    expect(isDoseReminderTimeStillAhead('20:00')).toBe(true);
  });

  it('returns false when today\u2019s HH:MM has already passed', () => {
    vi.setSystemTime(new Date(2024, 8, 10, 21, 0, 0));
    expect(isDoseReminderTimeStillAhead('20:00')).toBe(false);
  });

  it('returns false exactly AT the reminder time (same boundary as scheduleDoseReminder)', () => {
    // At exactly HH:MM:00.000 scheduleDoseReminder would push to
    // tomorrow (fireToday <= now) — "still ahead" must agree.
    vi.setSystemTime(new Date(2024, 8, 10, 20, 0, 0));
    expect(isDoseReminderTimeStillAhead('20:00')).toBe(false);
  });

  it('returns true one minute before the boundary', () => {
    vi.setSystemTime(new Date(2024, 8, 10, 19, 59, 0));
    expect(isDoseReminderTimeStillAhead('20:00')).toBe(true);
  });

  it('handles minutes and rejects invalid times', () => {
    vi.setSystemTime(new Date(2024, 8, 10, 12, 0, 0));
    expect(isDoseReminderTimeStillAhead('12:01')).toBe(true);
    expect(isDoseReminderTimeStillAhead('11:59')).toBe(false);
    expect(isDoseReminderTimeStillAhead('')).toBe(false);
    expect(isDoseReminderTimeStillAhead('99:99')).toBe(false);
    expect(isDoseReminderTimeStillAhead('ab:cd')).toBe(false);
  });
});

function lastScheduledNotification() {
  const call = requireDefined(
    mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1],
    'last schedule call'
  );
  const request = requireDefined(call[0], 'last schedule request');
  return requireDefined(request.notifications[0], 'last scheduled notification');
}

describe('Dose Reminder notification action and presentation', () => {
  it('includes the per-dose instruction in the iOS notification body when provided', async () => {
    await scheduleDoseReminder('med-description', 'Test', '20:00', 1, 'قرص', 'd1', {
      doseDescription: 'بعد الإفطار',
    });

    const notif = lastScheduledNotification();
    expect(notif.body).toContain('طريقة تناول الجرعة: بعد الإفطار');
  });

  it('does not include an instruction label when the per-dose description is empty', async () => {
    await scheduleDoseReminder('med-no-description', 'Test', '20:00', 1, 'قرص', 'd1', {
      doseDescription: '   ',
    });

    const notif = lastScheduledNotification();
    expect(notif.body).toBe('موعد الجرعة الساعة 08:00 م. جرعتك المقررة: 1 قرص.');
    expect(notif.body).not.toContain('طريقة تناول الجرعة:');
  });

  it('includes the Take action on iOS when manual Take is allowed', async () => {
    await scheduleDoseReminder('med-action', 'Test', '20:00', 1, 'قرص', 'd1', {
      allowManualTakeAction: true,
    });

    const notif = lastScheduledNotification();
    expect(notif.actionTypeId).toBe('take_dose');
    expect(notif.title).toBe('حان موعد دواء: Test');
    expect(notif.title).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('omits the Take action when manual Take is not allowed', async () => {
    await scheduleDoseReminder('med-action-disabled', 'Test', '20:00', 1, 'قرص', 'd1', {
      allowManualTakeAction: false,
    });

    const notif = lastScheduledNotification();
    expect(notif.actionTypeId).toBeUndefined();
  });

  it('includes the Take action on an iOS snooze notification when manual Take is allowed', async () => {
    await scheduleSnoozedDoseReminder(
      'med-snooze',
      'Test',
      1,
      'قرص',
      '20:00',
      10,
      'd1',
      true,
    );

    const notif = lastScheduledNotification();
    expect(notif.actionTypeId).toBe('take_dose');
    expect(notif.title).toBe('تذكير مجدد: Test');
    expect(notif.title).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('includes the per-dose instruction in the iOS snooze notification body when provided', async () => {
    await scheduleSnoozedDoseReminder(
      'med-snooze-description',
      'Test',
      1,
      'قرص',
      '20:00',
      10,
      'd1',
      true,
      'قبل النوم',
    );

    const notif = lastScheduledNotification();
    expect(notif.body).toContain('طريقة تناول الجرعة: قبل النوم');
  });

  it('does not add a Take action when manual Take is disabled for the snooze', async () => {
    await scheduleSnoozedDoseReminder(
      'med-snooze-disabled',
      'Test',
      1,
      'قرص',
      '20:00',
      10,
      'd1',
      false,
    );

    const notif = lastScheduledNotification();
    expect(notif.actionTypeId).toBeUndefined();
  });
});

describe('Phase 4 — doseId in notification extra', () => {
  it('scheduleDoseReminder encodes the medication + dose pair in extra.namespace/identity', async () => {
    await scheduleDoseReminder('med-x', 'Drug', '14:00', 1, 'قرص', 'd2');
    expect(mocks.schedule).toHaveBeenCalled();
    const notif = lastScheduledNotification();
    // Notification Runtime is the iOS boundary: the feature payload
    // (medicationId/doseId) is normalized into the logical identity
    // 'medId::doseId' carried alongside the namespace.
    expect(notif.extra.namespace).toBe('dose-reminder');
    expect(notif.extra.identity).toBe('med-x::d2');
  });

});

describe('scheduleDoseReminder — 12h display body, 24h schedule identity', () => {
  it.each([
    ['00:00', '12:00 ص'],
    ['09:30', '09:30 ص'],
    ['11:59', '11:59 ص'],
    ['12:00', '12:00 م'],
    ['13:00', '01:00 م'],
    ['22:00', '10:00 م'],
    ['23:59', '11:59 م'],
  ] as const)(
    'body shows %s as %s while extra identity and fire hour stay 24h',
    async (hhmm, display) => {
      // Pick a system time so every sample is still "ahead" today (before midnight).
      vi.setSystemTime(new Date(2024, 8, 10, 0, 0, 0));
      await scheduleDoseReminder('med-12h', 'Aspirin', hhmm, 1, 'قرص', 'd1');

      expect(mocks.schedule).toHaveBeenCalled();
      const notif = lastScheduledNotification();

      expect(notif.body).toContain(`الساعة ${display}`);
      // Scheduling identity unchanged: extra carries the raw logical
      // namespace + identity (no 12h decoration) and the wall-clock fire
      // time stays raw 24h HH:mm.
      expect(notif.extra.namespace).toBe('dose-reminder');
      expect(notif.extra.identity).toBe('med-12h::d1');
      expect(notif.extra.identity).not.toMatch(/[صم]/);
      const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
      expect(notif.schedule.at.getHours()).toBe(h);
      expect(notif.schedule.at.getMinutes()).toBe(m);
    },
  );
});
