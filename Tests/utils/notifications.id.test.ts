import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mocks are available inside vi.mock factories.
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  checkPermissions: vi.fn(),
  checkExactNotificationSetting: vi.fn(),
  changeExactNotificationSetting: vi.fn(),
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
    changeExactNotificationSetting: mocks.changeExactNotificationSetting,
  },
}));

import {
  doseReminderAlarmIdForDose,
  sendMedicineAlert,
  sendCriticalStockAlert,
  sendTestAlertNotification,
  cancelCriticalAlarm,
  scheduleCriticalAlarm,
  scheduleDoseReminder,
  snoozeDoseReminderId,
  getExactAlarmPermission,
  openExactAlarmSettings } from '@/utils/notifications';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.mockReturnValue('ios');
  mocks.checkPermissions.mockResolvedValue({ display: 'granted' });
  mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: 'granted' });
});

/**
 * Helper: extract the numeric notification id from the last
 * LocalNotifications.schedule() call.
 */
function lastScheduledId(): number {
  expect(mocks.schedule).toHaveBeenCalled();
  const call = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
  return call[0].notifications[0].id;
}

describe('notification ID scheme — disjoint ranges per category (#65)', () => {
  it('places each category in its own disjoint numeric band', async () => {
    const medId = 'med-band-test';

    await sendMedicineAlert(medId, 'Test', 5, 10); // lowStock
    const lowStockId = lastScheduledId();

    await sendCriticalStockAlert(medId, 'Test', 3, 5, 'قرص'); // critical
    const criticalId = lastScheduledId();

    await sendTestAlertNotification(); // test
    const testId = lastScheduledId();

    await scheduleCriticalAlarm(medId, 'Test', Date.now() + 86_400_000, 'قرص'); // criticalAlarm
    const alarmId = lastScheduledId();

    await scheduleDoseReminder(medId, 'Test', '09:00', 1, 'قرص', 'd1'); // doseAlarm
    const doseAlarmId = lastScheduledId();

    // Each category must fall in its own disjoint 1M band.
    expect(lowStockId).toBeGreaterThanOrEqual(1_000_000);
    expect(lowStockId).toBeLessThan(2_000_000);

    expect(criticalId).toBeGreaterThanOrEqual(2_000_000);
    expect(criticalId).toBeLessThan(3_000_000);

    // Test notification is a fixed constant: exactly 4_000_000.
    expect(testId).toBe(4_000_000);

    expect(alarmId).toBeGreaterThanOrEqual(5_000_000);
    expect(alarmId).toBeLessThan(6_000_000);

    expect(doseAlarmId).toBeGreaterThanOrEqual(6_000_000);
    expect(doseAlarmId).toBeLessThan(7_000_000);
  });

  it('never produces cross-category collisions even with adversarial medIds', async () => {
    // The old hashCode() scheme hashed 'med-<id>', 'critical-<id>',
    // 'dose-<id>', etc. into one 31-bit space, so a crafted medId could
    // make 'critical-alarm-X' collide with 'med-Y'. The new disjoint-
    // range scheme makes this structurally impossible: every category
    // id lives in a separate 1M band.
    const ids = new Set<number>();
    const medIds = ['a', 'b', 'c', 'medA', 'medB', 'critical-alarm-medA', 'med-test'];

    for (const medId of medIds) {
      await sendMedicineAlert(medId, 'T', 5, 10);
      await sendCriticalStockAlert(medId, 'T', 3, 5, 'قرص');
      await scheduleCriticalAlarm(medId, 'T', Date.now() + 86_400_000, 'قرص');
      await scheduleDoseReminder(medId, 'T', '09:00', 1, 'قرص', 'd1');
    }

    // Collect all scheduled ids across all categories + medIds.
    for (const call of mocks.schedule.mock.calls) {
      for (const n of call[0].notifications) {
        ids.add(n.id);
      }
    }

    // 4 categories * 7 medIds = 28 distinct ids (test notif not included here).
    expect(ids.size).toBe(28);
  });

  it('different medIds within the same category map to different ids (no intra-category collision across 100 meds)', async () => {
    const ids = new Set<number>();
    for (let i = 0; i < 100; i++) {
      await sendMedicineAlert(`med-${i}`, 'T', 5, 10);
    }
    for (const call of mocks.schedule.mock.calls) {
      ids.add(call[0].notifications[0].id);
    }
    // 100 meds should produce 100 distinct ids within the lowStock band.
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(1_000_000);
      expect(id).toBeLessThan(2_000_000);
    }
  });
});

describe('dose-reminder ID stability — no Date.now() (#66)', () => {
  it('produces the SAME id for the same med on repeated calls (snooze replaces, not duplicates)', async () => {
    const medId = 'med-dose-stable';
    await scheduleDoseReminder(medId, 'Test', '09:00', 1, 'قرص', 'd1');
    const firstId = lastScheduledId();

    // Simulate a snooze-and-refire: call again for the same med + dose.
    await scheduleDoseReminder(medId, 'Test', '09:00', 1, 'قرص', 'd1');
    const secondId = lastScheduledId();

    // The id must be stable so the new notification replaces (not
    // duplicates) the drawer entry — this is the original JSDoc intent
    // that Date.now() broke.
    expect(secondId).toBe(firstId);
  });

  it('produces DIFFERENT ids for different meds', async () => {
    await scheduleDoseReminder('med-alpha', 'A', '09:00', 1, 'قرص', 'd1');
    const idA = lastScheduledId();

    await scheduleDoseReminder('med-beta', 'B', '09:00', 1, 'قرص', 'd1');
    const idB = lastScheduledId();

    expect(idA).not.toBe(idB);
  });
});

describe('snoozeDoseReminderId — distinct from daily dose alarms', () => {
  it('is stable and does not collide with the recurring dose alarm', () => {
    const snoozeId = snoozeDoseReminderId('med-x', 'd1');
    const doseId = doseReminderAlarmIdForDose('med-x', 'd1');
    expect(snoozeId).toBe(snoozeDoseReminderId('med-x', 'd1'));
    expect(snoozeId).not.toBe(doseId);
    expect(snoozeId).toBeGreaterThanOrEqual(7_000_000);
    expect(snoozeId).toBeLessThan(8_000_000);
  });
});

describe('test notification id is a fixed constant', () => {
  it('always uses exactly 4_000_000 regardless of how many times it fires', async () => {
    await sendTestAlertNotification();
    await sendTestAlertNotification();
    await sendTestAlertNotification();

    expect(mocks.schedule).toHaveBeenCalledTimes(3);
    for (const call of mocks.schedule.mock.calls) {
      expect(call[0].notifications[0].id).toBe(4_000_000);
    }
  });
});

describe('getExactAlarmPermission — platform-aware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nativeCanExact.mockResolvedValue({ granted: true });
    mocks.nativeOpenSettings.mockResolvedValue({ opened: true });
  });

  it('returns "granted" on web (no exact-alarm concept)', async () => {
    mocks.platform.mockReturnValue('web');
    const result = await getExactAlarmPermission();
    expect(result).toBe('granted');
    expect(mocks.nativeCanExact).not.toHaveBeenCalled();
  });

  it('returns "granted" on iOS (no SCHEDULE_EXACT_ALARM concept)', async () => {
    mocks.platform.mockReturnValue('ios');
    const result = await getExactAlarmPermission();
    expect(result).toBe('granted');
    expect(mocks.checkExactNotificationSetting).not.toHaveBeenCalled();
  });

  it('returns "granted" on Android when exact alarm is granted', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.nativeCanExact.mockResolvedValue({ granted: true });
    const result = await getExactAlarmPermission();
    expect(result).toBe('granted');
    expect(mocks.nativeCanExact).toHaveBeenCalledTimes(1);
  });

  it('returns "denied" on Android when exact alarm is denied', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.nativeCanExact.mockResolvedValue({ granted: false });
    const result = await getExactAlarmPermission();
    expect(result).toBe('denied');
  });

  it('returns "unsupported" on Android when the API throws', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.nativeCanExact.mockRejectedValue(new Error('API unavailable'));
    const result = await getExactAlarmPermission();
    expect(result).toBe('unsupported');
  });
});

describe('openExactAlarmSettings — Android-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nativeOpenSettings.mockResolvedValue({ opened: true });
  });

  it('returns false on web', async () => {
    mocks.platform.mockReturnValue('web');
    const result = await openExactAlarmSettings();
    expect(result).toBe(false);
    expect(mocks.nativeOpenSettings).not.toHaveBeenCalled();
  });

  it('returns false on iOS', async () => {
    mocks.platform.mockReturnValue('ios');
    const result = await openExactAlarmSettings();
    expect(result).toBe(false);
    expect(mocks.changeExactNotificationSetting).not.toHaveBeenCalled();
  });

  it('calls the shared ExactAlarmRuntime settings bridge on Android and returns true', async () => {
    mocks.platform.mockReturnValue('android');
    const result = await openExactAlarmSettings();
    expect(result).toBe(true);
    expect(mocks.nativeOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('returns false on Android when the shared settings bridge throws', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.nativeOpenSettings.mockRejectedValue(new Error('failed'));
    const result = await openExactAlarmSettings();
    expect(result).toBe(false);
  });
});


describe('doseReminderAlarmIdForDose — multi-dose identity (Phase 2)', () => {
  it('distinct dose ids produce distinct notification ids for the same med', () => {
    const a = doseReminderAlarmIdForDose('med-x', 'dose-a');
    const b = doseReminderAlarmIdForDose('med-x', 'dose-b');
    expect(a).not.toBe(b);
  });

  it('same med+dose pair is stable across calls', () => {
    expect(doseReminderAlarmIdForDose('med-x', 'd1')).toBe(
      doseReminderAlarmIdForDose('med-x', 'd1')
    );
  });

  it('stays inside the doseAlarm band', () => {
    const id = doseReminderAlarmIdForDose('med-band', 'slot-1');
    expect(id).toBeGreaterThanOrEqual(6_000_000);
    expect(id).toBeLessThan(7_000_000);
  });
});

describe('Phase 3B snooze notification ids', () => {
  it('multi-dose snooze ids differ per dose', () => {
    const a = snoozeDoseReminderId('med-x', 'd1');
    const b = snoozeDoseReminderId('med-x', 'd2');
    expect(a).not.toBe(b);
  });
});
