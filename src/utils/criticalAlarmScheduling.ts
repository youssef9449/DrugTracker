import { scheduleCriticalAlarmNative, cancelCriticalAlarmNative, verifyCriticalAlarmPendingNative } from './criticalAlarmNative';
import { getNativePlatform, isNativePlatform } from './notifications/notificationPlatform';
import { areNotificationsEnabled, cancelNotification, getPendingNotification, scheduleNotification } from './notificationRuntime';
import { scheduleWebNotification } from './notifications/webNotifications';

export async function cancelCriticalAlarm(medId: string): Promise<void> {
  if (getNativePlatform() === 'android') {
    await cancelCriticalAlarmNative(medId);
    return;
  }
  if (!isNativePlatform()) return;
  try {
    await cancelNotification('critical-stock', medId);
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
    if (!(await areNotificationsEnabled())) return false;

    if (getNativePlatform() === 'android') {
      return verifyCriticalAlarmPendingNative(medId, alarmTimeMs);
    }

    const pending = await getPendingNotification('critical-stock', medId);
    return !!pending && pendingAtMatchesAlarmTime(
      pending.schedule?.at,
      alarmTimeMs
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
    if (!(await areNotificationsEnabled())) return false;
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
    return await scheduleNotification({
      namespace: 'critical-stock',
      identity: medId,
      title,
      body,
      channelId: 'low-stock',
      channelName: 'تنبيهات النفاذ',
      channelImportance: 4,
      channelVisibility: 1,
      smallIcon: 'ic_launcher',
      autoCancel: true,
      ongoing: false,
      at: fireAt,
      fallbackToWeb: false,
    });
  } catch (err) {
    console.warn('[notifications] iOS scheduleCriticalAlarm failed:', err);
    return false;
  }
}
