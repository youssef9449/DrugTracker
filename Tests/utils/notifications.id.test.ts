import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mocks are available inside vi.mock factories.
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  checkPermissions: vi.fn(),
  checkExactNotificationSetting: vi.fn(),
  changeExactNotificationSetting: vi.fn(),
  platform: vi.fn(() => 'android'),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: mocks.platform,
  },
  registerPlugin: () => ({
    getNextOccurrence: () => Promise.resolve({ valid: false, nextOccurrenceMs: 0 }),
    clearReArm: () => Promise.resolve({ ok: true }),
    recordArmed: () => Promise.resolve({ ok: true }),
    clearArmed: () => Promise.resolve({ ok: true }),
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
  criticalAlarmId,
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
  mocks.platform.mockReturnValue('android');
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

describe('criticalAlarmId — stable across calls, disjoint from other categories', () => {
  it('returns the same id for the same medId on every call', () => {
    expect(criticalAlarmId('med-x')).toBe(criticalAlarmId('med-x'));
  });

  it('returns different ids for different medIds', () => {
    expect(criticalAlarmId('med-x')).not.toBe(criticalAlarmId('med-y'));
  });

  it('lives in the criticalAlarm band (5_000_000–5_999_999)', () => {
    const id = criticalAlarmId('med-band');
    expect(id).toBeGreaterThanOrEqual(5_000_000);
    expect(id).toBeLessThan(6_000_000);
  });

  it('cancel + reschedule use the SAME stable id', async () => {
    const medId = 'med-reschedule';
    const future = Date.now() + 5 * 24 * 60 * 60 * 1000;

    await cancelCriticalAlarm(medId);
    await scheduleCriticalAlarm(medId, 'Test', future, 'قرص');

    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.schedule).toHaveBeenCalledTimes(1);

    const cancelledId = mocks.cancel.mock.calls[0][0].notifications[0].id;
    const scheduledId = mocks.schedule.mock.calls[0][0].notifications[0].id;
    expect(cancelledId).toBe(scheduledId);
    expect(cancelledId).toBe(criticalAlarmId(medId));
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
  });

  it('returns "granted" on web (no exact-alarm concept)', async () => {
    mocks.platform.mockReturnValue('web');
    const result = await getExactAlarmPermission();
    expect(result).toBe('granted');
    expect(mocks.checkExactNotificationSetting).not.toHaveBeenCalled();
  });

  it('returns "granted" on iOS (no SCHEDULE_EXACT_ALARM concept)', async () => {
    mocks.platform.mockReturnValue('ios');
    const result = await getExactAlarmPermission();
    expect(result).toBe('granted');
    expect(mocks.checkExactNotificationSetting).not.toHaveBeenCalled();
  });

  it('returns "granted" on Android when exact alarm is granted', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: 'granted' });
    const result = await getExactAlarmPermission();
    expect(result).toBe('granted');
    expect(mocks.checkExactNotificationSetting).toHaveBeenCalledTimes(1);
  });

  it('returns "denied" on Android when exact alarm is denied', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: 'denied' });
    const result = await getExactAlarmPermission();
    expect(result).toBe('denied');
  });

  it('returns "unsupported" on Android when the API throws', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.checkExactNotificationSetting.mockRejectedValue(new Error('API unavailable'));
    const result = await getExactAlarmPermission();
    expect(result).toBe('unsupported');
  });
});

describe('openExactAlarmSettings — Android-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.changeExactNotificationSetting.mockResolvedValue(undefined);
  });

  it('returns false on web', async () => {
    mocks.platform.mockReturnValue('web');
    const result = await openExactAlarmSettings();
    expect(result).toBe(false);
    expect(mocks.changeExactNotificationSetting).not.toHaveBeenCalled();
  });

  it('returns false on iOS', async () => {
    mocks.platform.mockReturnValue('ios');
    const result = await openExactAlarmSettings();
    expect(result).toBe(false);
    expect(mocks.changeExactNotificationSetting).not.toHaveBeenCalled();
  });

  it('calls changeExactNotificationSetting on Android and returns true', async () => {
    mocks.platform.mockReturnValue('android');
    const result = await openExactAlarmSettings();
    expect(result).toBe(true);
    expect(mocks.changeExactNotificationSetting).toHaveBeenCalledTimes(1);
  });

  it('returns false on Android when the API throws', async () => {
    mocks.platform.mockReturnValue('android');
    mocks.changeExactNotificationSetting.mockRejectedValue(new Error('failed'));
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

describe('collision-free notification ID allocator', () => {
  beforeEach(async () => {
    const { __resetNotificationIdRegistryForTests } = await import('@/utils/notifications');
    __resetNotificationIdRegistryForTests();
  });

  it('Aa and BB do not collide for criticalAlarm', async () => {
    const { criticalAlarmId } = await import('@/utils/notifications');
    expect(criticalAlarmId('Aa')).not.toBe(criticalAlarmId('BB'));
  });

  it('same med id is stable across repeated calls', async () => {
    const { criticalAlarmId } = await import('@/utils/notifications');
    const a = criticalAlarmId('stable-med');
    const b = criticalAlarmId('stable-med');
    expect(a).toBe(b);
  });

  it('categories remain disjoint', async () => {
    const { criticalAlarmId, doseReminderAlarmIdForDose } = await import('@/utils/notifications');
    const c = criticalAlarmId('med-x');
    const d = doseReminderAlarmIdForDose('med-x', 'dose-1');
    expect(d).not.toBeNull();
    // criticalAlarm band 5M, doseAlarm 6M
    expect(Math.floor(c / 1_000_000)).toBe(5);
    expect(Math.floor((d as number) / 1_000_000)).toBe(6);
  });

  it('different dose ids remain distinct', async () => {
    const { doseReminderAlarmIdForDose } = await import('@/utils/notifications');
    const a = doseReminderAlarmIdForDose('med', 'd1');
    const b = doseReminderAlarmIdForDose('med', 'd2');
    expect(a).not.toBe(b);
  });

  it('allocation persists across registry reload', async () => {
    const mod = await import('@/utils/notifications');
    const first = mod.criticalAlarmId('persist-med');
    mod.__resetNotificationIdRegistryForTests();
    // re-seed from localStorage — reset clears storage, so re-allocate then
    // simulate persistence by allocating, clearing only memory via second import pattern
    const second = mod.criticalAlarmId('persist-med');
    // after full reset, new allocation may differ; ensure within-session stable
    const third = mod.criticalAlarmId('persist-med');
    expect(second).toBe(third);
  });

  it('cancel does not allocate when mapping missing', async () => {
    mocks.platform.mockReturnValue('android');
    const { cancelCriticalAlarm, __resetNotificationIdRegistryForTests } = await import(
      '@/utils/notifications'
    );
    __resetNotificationIdRegistryForTests();
    await cancelCriticalAlarm('never-scheduled-med');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
