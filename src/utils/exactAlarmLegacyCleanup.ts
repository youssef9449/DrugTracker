import { LocalNotifications } from '@capacitor/local-notifications';
import { getNativePlatform } from './notifications/notificationPlatform';
import { ID_RANGE_SIZE, NOTIFICATION_ID_BASE } from './notifications/notificationIds';

export async function clearLegacyScheduledAlarmNotifications(): Promise<void> {
  if (getNativePlatform() !== 'android') return;
  try {
    const pending = await LocalNotifications.getPending();
    const legacyBases = [
      NOTIFICATION_ID_BASE.criticalAlarm,
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
