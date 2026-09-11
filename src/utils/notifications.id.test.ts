import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mocks are available inside vi.mock factories.
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  checkPermissions: vi.fn(),
  checkExactNotificationSetting: vi.fn(),
  platform: vi.fn(() => 'android'),
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
  },
}));

import {
  criticalAlarmId,
  doseReminderAlarmId,
  sendMedicineAlert,
  sendCriticalStockAlert,
  sendMedicationDoseReminder,
  sendTestAlertNotification,
  cancelCriticalAlarm,
  scheduleCriticalAlarm,
  scheduleDoseReminder,
  snoozeDoseReminderId,
  cancelDoseReminder,
} from './notifications';

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

    await sendMedicationDoseReminder(medId, 'Test', 1, 'قرص', 30, '09:00'); // dose
    const doseId = lastScheduledId();

    await sendTestAlertNotification(null); // test
    const testId = lastScheduledId();

    await scheduleCriticalAlarm(medId, 'Test', Date.now() + 86_400_000, 'قرص'); // criticalAlarm
    const alarmId = lastScheduledId();

    await scheduleDoseReminder(medId, 'Test', '09:00', 1, 'قرص', 30, null); // doseAlarm
    const doseAlarmId = lastScheduledId();

    // Each category must fall in its own disjoint 1M band.
    expect(lowStockId).toBeGreaterThanOrEqual(1_000_000);
    expect(lowStockId).toBeLessThan(2_000_000);

    expect(criticalId).toBeGreaterThanOrEqual(2_000_000);
    expect(criticalId).toBeLessThan(3_000_000);

    expect(doseId).toBeGreaterThanOrEqual(3_000_000);
    expect(doseId).toBeLessThan(4_000_000);

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
      await sendMedicationDoseReminder(medId, 'T', 1, 'قرص', 30, '09:00');
      await scheduleCriticalAlarm(medId, 'T', Date.now() + 86_400_000, 'قرص');
      await scheduleDoseReminder(medId, 'T', '09:00', 1, 'قرص', 30, null);
    }

    // Collect all scheduled ids across all categories + medIds.
    for (const call of mocks.schedule.mock.calls) {
      for (const n of call[0].notifications) {
        ids.add(n.id);
      }
    }

    // 5 categories * 7 medIds = 35 distinct ids (test notif not included here).
    expect(ids.size).toBe(35);
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
    await sendMedicationDoseReminder(medId, 'Test', 1, 'قرص', 30, '09:00');
    const firstId = lastScheduledId();

    // Simulate a snooze-and-refire: call again for the same med.
    await sendMedicationDoseReminder(medId, 'Test', 1, 'قرص', 30, '09:00');
    const secondId = lastScheduledId();

    // The id must be stable so the new notification replaces (not
    // duplicates) the drawer entry — this is the original JSDoc intent
    // that Date.now() broke.
    expect(secondId).toBe(firstId);
  });

  it('produces DIFFERENT ids for different meds', async () => {
    await sendMedicationDoseReminder('med-alpha', 'A', 1, 'قرص', 30, '09:00');
    const idA = lastScheduledId();

    await sendMedicationDoseReminder('med-beta', 'B', 1, 'قرص', 30, '09:00');
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

describe('doseReminderAlarmId — stable across calls, disjoint from other categories', () => {
  it('returns the same id for the same medId on every call', () => {
    expect(doseReminderAlarmId('med-x')).toBe(doseReminderAlarmId('med-x'));
  });

  it('returns different ids for different medIds', () => {
    expect(doseReminderAlarmId('med-x')).not.toBe(doseReminderAlarmId('med-y'));
  });

  it('lives in the doseAlarm band (6_000_000–6_999_999)', () => {
    const id = doseReminderAlarmId('med-band');
    expect(id).toBeGreaterThanOrEqual(6_000_000);
    expect(id).toBeLessThan(7_000_000);
  });

  it('cancel + reschedule use the SAME stable id', async () => {
    const medId = 'med-dose-reschedule';

    await cancelDoseReminder(medId);
    await scheduleDoseReminder(medId, 'Test', '09:00', 1, 'قرص', 30, null);

    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.schedule).toHaveBeenCalledTimes(1);

    const cancelledId = mocks.cancel.mock.calls[0][0].notifications[0].id;
    const scheduledId = mocks.schedule.mock.calls[0][0].notifications[0].id;
    expect(cancelledId).toBe(scheduledId);
    expect(cancelledId).toBe(doseReminderAlarmId(medId));
  });
});

describe('snoozeDoseReminderId — distinct from daily dose alarms', () => {
  it('is stable and does not collide with the recurring dose alarm', () => {
    expect(snoozeDoseReminderId('med-x')).toBe(snoozeDoseReminderId('med-x'));
    expect(snoozeDoseReminderId('med-x')).not.toBe(doseReminderAlarmId('med-x'));
    expect(snoozeDoseReminderId('med-x')).toBeGreaterThanOrEqual(7_000_000);
    expect(snoozeDoseReminderId('med-x')).toBeLessThan(8_000_000);
  });
});

describe('test notification id is a fixed constant', () => {
  it('always uses exactly 4_000_000 regardless of how many times it fires', async () => {
    await sendTestAlertNotification(null);
    await sendTestAlertNotification(null);
    await sendTestAlertNotification(null);

    expect(mocks.schedule).toHaveBeenCalledTimes(3);
    for (const call of mocks.schedule.mock.calls) {
      expect(call[0].notifications[0].id).toBe(4_000_000);
    }
  });
});
