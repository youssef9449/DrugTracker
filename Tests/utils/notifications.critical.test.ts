import { requireDefined } from '../helpers/requireDefined';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mock fns are accessible inside vi.mock factories
// (vi.mock is hoisted to the top of the file).
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  checkPermissions: vi.fn(),
  checkExactNotificationSetting: vi.fn(),
  getPending: vi.fn(),
  criticalSchedule: vi.fn(),
  criticalCancel: vi.fn(),
  criticalVerify: vi.fn(),
  criticalList: vi.fn(),
  platform: vi.fn(() => 'web'),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: mocks.platform,
  },
  registerPlugin: (name: string) => {
    if (name === 'CriticalStock') {
      return {
        schedule: mocks.criticalSchedule,
        cancel: mocks.criticalCancel,
        verify: mocks.criticalVerify,
        listScheduled: mocks.criticalList,
      };
    }
    return {
      getNextOccurrence: () => Promise.resolve({ valid: false, nextOccurrenceMs: 0 }),
      clearReArm: () => Promise.resolve({ ok: true }),
    };
  },
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: mocks.schedule,
    cancel: mocks.cancel,
    checkPermissions: mocks.checkPermissions,
    checkExactNotificationSetting: mocks.checkExactNotificationSetting,
    getPending: mocks.getPending,
  },
}));

import {
  cancelCriticalAlarm,
  scheduleCriticalAlarm,
  verifyCriticalAlarmPending } from './notificationTestFacade';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.mockReturnValue('web');
  mocks.checkPermissions.mockResolvedValue({ display: 'granted' });
  mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: 'granted' });
  mocks.getPending.mockResolvedValue({ notifications: [] });
  mocks.schedule.mockResolvedValue({ notifications: [] });
});


async function scheduleIOSNotificationAndGetPlatformId(
  medId: string,
  at: number
): Promise<number> {
  await scheduleCriticalAlarm(medId, 'Test Med', at, 'قرص');
  const call = requireDefined(
    mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1],
    'schedule call'
  );
  const request = requireDefined(call[0], 'schedule request');
  return requireDefined(request.notifications[0], 'notification').id;
}

describe('cancelCriticalAlarm (web path)', () => {
  it('is a no-op on web (no persistent alarm to cancel)', async () => {
    await cancelCriticalAlarm('med-1');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});

describe('scheduleCriticalAlarm (web path)', () => {
  beforeEach(() => {
    const WebNotification = class {
      static permission = 'granted';
      constructor() {}
    };
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: WebNotification,
    });
  });

  it('persists a future web schedule at the exact crossing time', async () => {
    const future = Date.now() + 60_000;
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص')
    ).resolves.toMatchObject({ ok: true });

    const stored = JSON.parse(
      localStorage.getItem('drugtracker_web_scheduled_notifications_v1') || '{}'
    );
    expect(stored['critical-stock::med-1']).toMatchObject({
      namespace: 'critical-stock',
      identity: 'med-1',
      fireAt: future,
    });
  });

  it('reports Web claim persistence failure instead of consuming the notification opportunity', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    const future = Date.now() + 60_000;
    await expect(
      scheduleCriticalAlarm('med-claim-failure', 'Test Med', future, 'قرص')
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'platform_failure',
    });

    expect(
      JSON.parse(
        localStorage.getItem('drugtracker_web_scheduled_notifications_v1') || '{}'
      )['critical-stock::med-claim-failure']
    ).toBeUndefined();

    setItemSpy.mockRestore();
  });

  it('reports Web scheduling failure when durable storage rejects the schedule', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    const future = Date.now() + 60_000;
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص')
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'platform_failure',
    });

    setItemSpy.mockRestore();
  });
});

describe('scheduleCriticalAlarm — native path (android)', () => {
  beforeEach(() => {
    // Switch the platform mock to 'android' just for this describe block.
    mocks.platform.mockReturnValue('android');
    mocks.checkPermissions.mockResolvedValue({ display: 'granted' });
    // The plugin resolves with the descriptors it actually registered.
    mocks.criticalSchedule.mockResolvedValue({ ok: true });
    mocks.criticalCancel.mockResolvedValue({ ok: true, status: 'SUCCESS' });
    mocks.criticalVerify.mockResolvedValue({ ok: true });
  });

  it('schedules a one-shot notification at the given future time', async () => {
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days out
    await scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص');

    expect(mocks.criticalSchedule).toHaveBeenCalledTimes(1);
    const arg = requireDefined(mocks.criticalSchedule.mock.calls[0], 'mocks.criticalSchedule.mock.calls[0]')[0];
    expect(arg.medicationId).toBe('med-1');
    expect(arg.medicationName).toBe('Test Med');
    expect(arg.triggerAtEpochMs).toBe(future);
    expect(arg.notificationTitle).toContain('Test Med');
    expect(arg.notificationBody).toContain('Test Med');
    expect(arg.unit).toBe('قرص');
  });

  it('passes the alarm time to the platform exactly as given (no rewriting)', async () => {
    // The scheduler only ever passes future timestamps; the persisted
    // claim's alarmTime must match the actually-armed alarm, so no
    // past-date fallback rewriting happens here.
    const future = Date.now() + 3 * 24 * 60 * 60 * 1000;
    await scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص');

    const request = requireDefined(mocks.criticalSchedule.mock.calls[0], 'mocks.criticalSchedule.mock.calls[0]')[0];
    expect(request.triggerAtEpochMs).toBe(future);
  });

  it('BLOCKER: returns true ONLY when the ScheduleResult actually lists the notification', async () => {
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص')
    ).resolves.toMatchObject({ ok: true });
  });

  it('BLOCKER: a resolve that omits our id is NOT native scheduling success', async () => {
    // The plugin resolved, but the result does not list our notification
    // id — nothing was actually registered. This must NOT be reported
    // as success (an armed claim without an alarm would suppress the
    // foreground fallback).
    mocks.criticalSchedule.mockResolvedValueOnce({ ok: false, error: 'not_scheduled' });
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص')
    ).resolves.toMatchObject({ ok: false, errorCode: 'platform_failure' });
    expect(mocks.criticalSchedule).toHaveBeenCalledTimes(1);
  });

  it('BLOCKER: a resolve listing a DIFFERENT id is not success either', async () => {
    mocks.criticalSchedule.mockResolvedValueOnce({ ok: false, error: 'wrong_identity' });
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص')
    ).resolves.toMatchObject({ ok: false, errorCode: 'platform_failure' });
  });

  it('BLOCKER: a native schedule rejection returns false — the web fallback must not rescue it', async () => {
    // Native LocalNotifications.schedule() throws (bridge failure /
    // notifications disabled natively). The browser/web notification
    // path must NEVER turn this into `true`.
    mocks.criticalSchedule.mockRejectedValueOnce(new Error('Notifications not enabled on this device'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص')
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'permission_denied',
    });
    warnSpy.mockRestore();
  });

  it('skips scheduling when permission is not granted and reports failure', async () => {
    mocks.checkPermissions.mockResolvedValue({ display: 'denied' });
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', Date.now() + 1000)
    ).resolves.toMatchObject({ ok: false, errorCode: 'permission_denied' });
    expect(mocks.criticalSchedule).not.toHaveBeenCalled();
  });

  it('cancelCriticalAlarm uses the native Critical identity on Android', async () => {
    await cancelCriticalAlarm('med-1');
    expect(mocks.criticalCancel).toHaveBeenCalledTimes(1);
    expect(requireDefined(mocks.criticalCancel.mock.calls[0], 'mocks.criticalCancel.mock.calls[0]')[0]).toEqual({ medicationId: 'med-1' });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('alarm rescheduling keeps the same medication identity across cancel + schedule', async () => {
    const future = Date.now() + 5 * 24 * 60 * 60 * 1000;
    await cancelCriticalAlarm('med-reschedule');
    await scheduleCriticalAlarm('med-reschedule', 'Test', future, 'قرص');

    expect(mocks.criticalCancel).toHaveBeenCalledTimes(1);
    expect(requireDefined(mocks.criticalCancel.mock.calls[0], 'mocks.criticalCancel.mock.calls[0]')[0]).toEqual({
      medicationId: 'med-reschedule',
    });
    expect(mocks.criticalSchedule).toHaveBeenCalledTimes(1);
    expect(requireDefined(mocks.criticalSchedule.mock.calls[0], 'mocks.criticalSchedule.mock.calls[0]')[0].medicationId).toBe(
      'med-reschedule'
    );
  });
});

describe('verifyCriticalAlarmPending — the claim is not proof the alarm exists', () => {
  it('on web there is nothing to verify: false, no plugin calls', async () => {
    await expect(verifyCriticalAlarmPending('med-1', Date.now() + 5000)).resolves.toMatchObject({
      ok: false,
      errorCode: 'platform_failure',
    });
    expect(mocks.checkPermissions).not.toHaveBeenCalled();
    expect(mocks.getPending).not.toHaveBeenCalled();
  });

  it('android: native identity verifies the exact medication alarm', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.criticalVerify.mockResolvedValue({ ok: true });
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toMatchObject({
      ok: true,
      pending: true,
    });
    expect(mocks.criticalVerify).toHaveBeenCalledWith({
      medicationId: 'med-1',
      alarmTimeMs: t,
    });
    expect(mocks.getPending).not.toHaveBeenCalled();
  });

  it('android: native verification failure means the alarm is not verified', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.criticalVerify.mockResolvedValue({ ok: false });
    await expect(
      verifyCriticalAlarmPending('med-1', Date.now() + 7 * 24 * 60 * 60 * 1000)
    ).resolves.toMatchObject({ ok: true, pending: false });
  });


  it('iOS-style ISO-string schedule.at is recognized (sub-second round-trip tolerance)', async () => {
    mocks.platform.mockReturnValue('ios');
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    // iOS serializes schedule.at as an ISO-8601 string that drops
    // sub-second precision.
    const scheduledId = await scheduleIOSNotificationAndGetPlatformId('med-1', t);
    mocks.getPending.mockResolvedValue({
      notifications: [{ id: scheduledId, schedule: { at: new Date(t).toISOString() } }],
    });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toMatchObject({
      ok: true,
      pending: true,
    });
  });

  it('display permission lost → NOT verified (an alarm that cannot display must not stay armed)', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.checkPermissions.mockResolvedValue({ display: 'denied' });
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    mocks.criticalVerify.mockResolvedValue({ ok: true });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toMatchObject({
      ok: true,
      pending: false,
    });
    expect(mocks.criticalVerify).not.toHaveBeenCalled();
  });

  it('BLOCKER: exact-alarm setting denied on Android 12+ → NOT verified (the OS cancels exact alarms; the pending record may still list them)', async () => {
    mocks.platform.mockReturnValue('android');
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    mocks.criticalVerify.mockResolvedValue({ ok: false });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toMatchObject({
      ok: true,
      pending: false,
    });
    expect(mocks.criticalVerify).toHaveBeenCalledWith({
      medicationId: 'med-1',
      alarmTimeMs: t,
    });
  });

  it('android: successful native verification is accepted regardless of notification pending-list IDs', async () => {
    mocks.platform.mockReturnValue('android');
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    mocks.criticalVerify.mockResolvedValue({ ok: true });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toMatchObject({
      ok: true,
      pending: true,
    });
  });

  it('exact-alarm check is skipped on iOS (Android-only concept)', async () => {
    mocks.platform.mockReturnValue('ios');
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const scheduledId = await scheduleIOSNotificationAndGetPlatformId('med-1', t);
    mocks.getPending.mockResolvedValue({
      notifications: [{ id: scheduledId, schedule: { at: new Date(t).toISOString() } }],
    });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toMatchObject({
      ok: true,
      pending: true,
    });
    expect(mocks.checkExactNotificationSetting).not.toHaveBeenCalled();
  });

  it('bridge failure (native verify rejects) → NOT verified: an unverifiable alarm must not be trusted', async () => {
    mocks.platform.mockReturnValue('android');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.criticalVerify.mockRejectedValue(new Error('bridge down'));
    await expect(
      verifyCriticalAlarmPending('med-1', Date.now() + 7 * 24 * 60 * 60 * 1000)
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'platform_failure',
    });
    warnSpy.mockRestore();
  });
});
