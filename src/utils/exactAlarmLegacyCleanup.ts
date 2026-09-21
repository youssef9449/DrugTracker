import { LocalNotifications } from '@capacitor/local-notifications';
import { getNativePlatform } from './notifications/notificationPlatform';
import { ID_RANGE_SIZE, NOTIFICATION_ID_BASE } from './notifications/notificationIds';

// Legacy Android Critical alarm IDs from the pre-native-runtime scheduler.
// This constant is migration cleanup only; new Android Critical alarms never use it.
const LEGACY_CRITICAL_ALARM_ID_BASE = 5_000_000;

export async function clearLegacyScheduledAlarmNotifications(): Promise<void> {
  if (getNativePlatform() !== 'android') return;
  try {
    const pending = await LocalNotifications.getPending();
    const legacyBases = [
      LEGACY_CRITICAL_ALARM_ID_BASE,
      NOTIFICATION_ID_BASE.doseAlarm,
      NOTIFICATION_ID_BASE.doseSnooze,
    ];
    const legacyIds = pending.notifications
      .map((notification) => notification.id)
      .filter(
        (id): id is number =>
          typeof id === 'number' &&
          legacyBases.some(
            (base) => id >= base && id < base + ID_RANGE_SIZE
          )
      );
    if (legacyIds.length === 0) return;
    await LocalNotifications.cancel({
      notifications: legacyIds.map((id) => ({ id })),
    });
  } catch (err) {
    console.warn('[notifications] legacy alarm cleanup failed:', err);
  }
}
