import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mock fns are accessible inside vi.mock factories
// (vi.mock is hoisted to the top of the file).
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  checkPermissions: vi.fn(),
  checkExactNotificationSetting: vi.fn(),
  getPending: vi.fn(),
  platform: vi.fn(() => 'web'),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: mocks.platform,
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
  criticalAlarmId,
  cancelCriticalAlarm,
  scheduleCriticalAlarm,
  verifyCriticalAlarmPending,
} from './notifications';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.mockReturnValue('web');
  mocks.checkPermissions.mockResolvedValue({ display: 'granted' });
  mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: 'granted' });
  mocks.getPending.mockResolvedValue({ notifications: [] });
});

describe('criticalAlarmId', () => {
  it('returns a stable numeric id for the same medId', () => {
    const a = criticalAlarmId('med-1');
    const b = criticalAlarmId('med-1');
    expect(a).toBe(b);
    expect(typeof a).toBe('number');
  });

  it('returns different ids for different medIds', () => {
    expect(criticalAlarmId('med-1')).not.toBe(criticalAlarmId('med-2'));
  });
});

describe('cancelCriticalAlarm (web path)', () => {
  it('is a no-op on web (no persistent alarm to cancel)', async () => {
    await cancelCriticalAlarm('med-1');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});

describe('scheduleCriticalAlarm (web path)', () => {
  it('fires the web fallback immediately (no persistent scheduling on web)', async () => {
    await scheduleCriticalAlarm('med-1', 'Test Med', Date.now() + 1000);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('BLOCKER: the web fallback can never make scheduleCriticalAlarm return true', async () => {
    // Even if the browser notification "succeeds", a web notification is
    // not a native future alarm — the return value must stay false so no
    // armed claim is persisted without a native alarm behind it.
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', Date.now() + 1000)
    ).resolves.toBe(false);
  });
});

describe('scheduleCriticalAlarm — native path (android)', () => {
  beforeEach(() => {
    // Switch the platform mock to 'android' just for this describe block.
    mocks.platform.mockReturnValue('android');
    mocks.checkPermissions.mockResolvedValue({ display: 'granted' });
    // The plugin resolves with the descriptors it actually registered.
    mocks.schedule.mockImplementation(async (opts: { notifications: { id: number }[] }) => ({
      notifications: opts.notifications.map((n) => ({ id: n.id })),
    }));
  });

  it('schedules a one-shot notification at the given future time', async () => {
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days out
    await scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص');

    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const arg = mocks.schedule.mock.calls[0][0];
    expect(arg.notifications).toHaveLength(1);
    const notif = arg.notifications[0];
    expect(notif.id).toBe(criticalAlarmId('med-1'));
    expect(notif.title).toContain('Test Med');
    expect(notif.schedule.at.getTime()).toBeGreaterThan(Date.now());
    expect(notif.schedule.allowWhileIdle).toBe(true);
    expect(notif.channelId).toBe('low-stock');
  });

  it('passes the alarm time to the platform exactly as given (no rewriting)', async () => {
    // The scheduler only ever passes future timestamps; the persisted
    // claim's alarmTime must match the actually-armed alarm, so no
    // past-date fallback rewriting happens here.
    const future = Date.now() + 3 * 24 * 60 * 60 * 1000;
    await scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص');

    const notif = mocks.schedule.mock.calls[0][0].notifications[0];
    expect(notif.schedule.at.getTime()).toBe(future);
  });

  it('BLOCKER: returns true ONLY when the ScheduleResult actually lists the notification', async () => {
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص')
    ).resolves.toBe(true);
  });

  it('BLOCKER: a resolve that omits our id is NOT native scheduling success', async () => {
    // The plugin resolved, but the result does not list our notification
    // id — nothing was actually registered. This must NOT be reported
    // as success (an armed claim without an alarm would suppress the
    // foreground fallback).
    mocks.schedule.mockResolvedValueOnce({ notifications: [] });
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص')
    ).resolves.toBe(false);
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
  });

  it('BLOCKER: a resolve listing a DIFFERENT id is not success either', async () => {
    mocks.schedule.mockResolvedValueOnce({
      notifications: [{ id: criticalAlarmId('some-other-med') }],
    });
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص')
    ).resolves.toBe(false);
  });

  it('BLOCKER: a native schedule rejection returns false — the web fallback must not rescue it', async () => {
    // Native LocalNotifications.schedule() throws (bridge failure /
    // notifications disabled natively). The browser/web notification
    // path must NEVER turn this into `true`.
    mocks.schedule.mockRejectedValueOnce(new Error('Notifications not enabled on this device'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص')
    ).resolves.toBe(false);
    warnSpy.mockRestore();
  });

  it('skips scheduling when permission is not granted and reports failure', async () => {
    mocks.checkPermissions.mockResolvedValue({ display: 'denied' });
    await expect(
      scheduleCriticalAlarm('med-1', 'Test Med', Date.now() + 1000)
    ).resolves.toBe(false);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('cancelCriticalAlarm calls Capacitor.cancel with the stable id', async () => {
    await cancelCriticalAlarm('med-1');
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    const arg = mocks.cancel.mock.calls[0][0];
    expect(arg.notifications).toHaveLength(1);
    expect(arg.notifications[0].id).toBe(criticalAlarmId('med-1'));
  });

  it('alarm rescheduling: cancel + schedule use the SAME stable id', async () => {
    const id = criticalAlarmId('med-reschedule');
    const future = Date.now() + 5 * 24 * 60 * 60 * 1000;
    await cancelCriticalAlarm('med-reschedule');
    await scheduleCriticalAlarm('med-reschedule', 'Test', future, 'قرص');

    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    const cancelledId = mocks.cancel.mock.calls[0][0].notifications[0].id;
    const scheduledId = mocks.schedule.mock.calls[0][0].notifications[0].id;
    expect(cancelledId).toBe(id);
    expect(scheduledId).toBe(id);
  });
});

describe('verifyCriticalAlarmPending — the claim is not proof the alarm exists', () => {
  it('on web there is nothing to verify: false, no plugin calls', async () => {
    await expect(verifyCriticalAlarmPending('med-1', Date.now() + 5000)).resolves.toBe(false);
    expect(mocks.checkPermissions).not.toHaveBeenCalled();
    expect(mocks.getPending).not.toHaveBeenCalled();
  });

  it('android: pending alarm present at exactly alarmTime → verified (keep, no re-arm)', async () => {
    mocks.platform.mockReturnValue('android');
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    mocks.getPending.mockResolvedValue({
      notifications: [
        { id: criticalAlarmId('med-1'), schedule: { at: t } }, // Android: number
        { id: 999999, schedule: { at: t } }, // some dose-reminder alarm
      ],
    });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toBe(true);
  });

  it('android: pending alarm exists but at a DIFFERENT time → NOT verified', async () => {
    mocks.platform.mockReturnValue('android');
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    mocks.getPending.mockResolvedValue({
      notifications: [{ id: criticalAlarmId('med-1'), schedule: { at: t + 60_000 } }],
    });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toBe(false);
  });

  it('android: pending list missing our id → NOT verified', async () => {
    mocks.platform.mockReturnValue('android');
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    mocks.getPending.mockResolvedValue({
      notifications: [{ id: criticalAlarmId('med-2'), schedule: { at: t } }],
    });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toBe(false);
  });

  it('android: pending list empty (alarm was removed) → NOT verified', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.getPending.mockResolvedValue({ notifications: [] });
    await expect(
      verifyCriticalAlarmPending('med-1', Date.now() + 7 * 24 * 60 * 60 * 1000)
    ).resolves.toBe(false);
  });

  it('iOS-style ISO-string schedule.at is recognized (sub-second round-trip tolerance)', async () => {
    mocks.platform.mockReturnValue('ios');
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    // iOS serializes schedule.at as an ISO-8601 string that drops
    // sub-second precision.
    mocks.getPending.mockResolvedValue({
      notifications: [{ id: criticalAlarmId('med-1'), schedule: { at: new Date(t).toISOString() } }],
    });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toBe(true);
  });

  it('display permission lost → NOT verified (an alarm that cannot display must not stay armed)', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.checkPermissions.mockResolvedValue({ display: 'denied' });
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    mocks.getPending.mockResolvedValue({
      notifications: [{ id: criticalAlarmId('med-1'), schedule: { at: t } }],
    });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toBe(false);
    // Short-circuits before touching the pending list.
    expect(mocks.getPending).not.toHaveBeenCalled();
  });

  it('BLOCKER: exact-alarm setting denied on Android 12+ → NOT verified (the OS cancels exact alarms; the pending record may still list them)', async () => {
    mocks.platform.mockReturnValue('android');
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    // The plugin's pending record STILL lists the alarm — but with the
    // exact setting revoked the OS has dropped the actual alarm, so the
    // claim must not be treated as armed.
    mocks.getPending.mockResolvedValue({
      notifications: [{ id: criticalAlarmId('med-1'), schedule: { at: t } }],
    });
    mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: 'denied' });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toBe(false);
  });

  it("'prompt' exact-alarm setting does not by itself break verification", async () => {
    mocks.platform.mockReturnValue('android');
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    mocks.getPending.mockResolvedValue({
      notifications: [{ id: criticalAlarmId('med-1'), schedule: { at: t } }],
    });
    mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: 'prompt' });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toBe(true);
  });

  it('exact-alarm check is skipped on iOS (Android-only concept)', async () => {
    mocks.platform.mockReturnValue('ios');
    const t = Date.now() + 7 * 24 * 60 * 60 * 1000;
    mocks.getPending.mockResolvedValue({
      notifications: [{ id: criticalAlarmId('med-1'), schedule: { at: new Date(t).toISOString() } }],
    });
    await expect(verifyCriticalAlarmPending('med-1', t)).resolves.toBe(true);
    expect(mocks.checkExactNotificationSetting).not.toHaveBeenCalled();
  });

  it('bridge failure (getPending rejects) → NOT verified: an unverifiable alarm must not be trusted', async () => {
    mocks.platform.mockReturnValue('android');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.getPending.mockRejectedValue(new Error('bridge down'));
    await expect(
      verifyCriticalAlarmPending('med-1', Date.now() + 7 * 24 * 60 * 60 * 1000)
    ).resolves.toBe(false);
    warnSpy.mockRestore();
  });
});
