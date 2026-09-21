import { LocalNotifications } from '@capacitor/local-notifications';
import { scheduleCriticalAlarmNative, cancelCriticalAlarmNative, verifyCriticalAlarmPendingNative } from './criticalAlarmNative';
import { iosCriticalAlarmId } from './notifications/notificationIds';
import { getNativePlatform, isNativePlatform } from './notifications/notificationPlatform';
import { scheduleWebNotification } from './notifications/webNotifications';

export async function cancelCriticalAlarm(medId: string): Promise<void> {
  if (getNativePlatform() === 'android') {
    await cancelCriticalAlarmNative(medId);
    return;
  }
  if (!isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({
      notifications: [{ id: iosCriticalAlarmId(medId) }],
    });
  } catch (err) {
    console.warn('[notifications] cancelCriticalAlarm failed:', err);
  }
}

function pendingAtMatchesAlarmTime(at: unknown, alarmTimeMs: number): boolean {
  if (typeof at === 'number') return at === alarmTimeMs;
  if (typeof at === 'string') {
    const parsed = new Date(at).getTime();
    return !Number.isNaN(parsed) && Math.abs(parsed - alarmTimeMs) <= 2000;
  }
  return false;
}

export async function verifyCriticalAlarmPending(
  medId: string,
  alarmTimeMs: number
): Promise<boolean> {
  if (!isNativePlatform()) return false;

  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') return false;

    if (getNativePlatform() === 'android') {
      return verifyCriticalAlarmPendingNative(medId, alarmTimeMs);
    }

    const pending = await LocalNotifications.getPending();
    const id = iosCriticalAlarmId(medId);
    return pending.notifications.some(
      (n) =>
        n.id === id &&
        pendingAtMatchesAlarmTime(
          (n.schedule as { at?: unknown } | undefined)?.at,
          alarmTimeMs
        )
    );
  } catch (err) {
    console.warn('[notifications] verifyCriticalAlarmPending failed:', err);
    return false;
  }
}

export async function scheduleCriticalAlarm(
  medId: string,
  medName: string,
  criticalDateMs: number,
  unit: string = 'قرص'
): Promise<boolean> {
  const fireAt = new Date(criticalDateMs);
  const title = `🚨 ${medName}: اقترب النفاد الحرج`;
  const body = `مخزون "${medName}" دخل مرحلة النفاد الحرج (${unit}). يرجى التعبئة فوراً!`;

  if (getNativePlatform() === 'android') {
    const permission = await LocalNotifications.checkPermissions();
    if (permission.display !== 'granted') return false;
    return scheduleCriticalAlarmNative(
      medId,
      medName,
      criticalDateMs,
      unit,
      title,
      body
    );
  }

  if (getNativePlatform() !== 'ios') {
    scheduleWebNotification(title, body);
    return false;
  }

  try {
    const permission = await LocalNotifications.checkPermissions();
    if (permission.display !== 'granted') return false;
    const result = await LocalNotifications.schedule({
      notifications: [
        {
          id: iosCriticalAlarmId(medId),
          title,
          body,
          schedule: { at: fireAt, allowWhileIdle: true },
          channelId: 'low-stock',
          smallIcon: 'ic_launcher',
          ongoing: false,
          autoCancel: true,
          extra: { medicationId: medId },
        },
      ],
    });
    return result.notifications.some(
      (n) => n.id === iosCriticalAlarmId(medId)
    );
  } catch (err) {
    console.warn('[notifications] iOS scheduleCriticalAlarm failed:', err);
    return false;
  }
}
