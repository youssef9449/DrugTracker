import { LocalNotifications } from '@capacitor/local-notifications';
import { formatReminderTime12h } from '../time';
import {
  scheduleDoseSnoozeNative,
  cancelDoseSnoozeNative,
} from '../doseReminderNative';
import { scheduleNotification } from './notificationRuntime';
import { notificationId } from './notificationIds';
import { getNativePlatform, isNativePlatform } from './notificationPlatform';
import { scheduleWebNotification } from './webNotifications';

export const DOSE_REMINDER_CHANNEL_ID = 'dose-reminder-v3';
export const DOSE_REMINDER_FOREGROUND_CHANNEL_ID = 'dose-reminder-foreground-v1';

let appInForeground = true;

export function setAppInForeground(value: boolean): void {
  appInForeground = value;
}

export function isAppInForeground(): boolean {
  return appInForeground;
}

export function getDoseReminderChannelId(): string {
  return appInForeground
    ? DOSE_REMINDER_FOREGROUND_CHANNEL_ID
    : DOSE_REMINDER_CHANNEL_ID;
}

export async function sendTestAlertNotification(): Promise<void> {
  await scheduleNotification({
    id: notificationId('test'),
    namespace: 'test',
    identity: 'test',
    title: '🔔 إشعار تجريبي: متابع الأدوية',
    body: 'الإشعارات والتنبيهات تعمل بشكل سليم على جهازك!',
    channelId: getDoseReminderChannelId(),
    smallIcon: 'ic_launcher',
    channelImportance: appInForeground ? 2 : 4,
  });
}

export async function cancelSnoozedDoseReminder(
  medId: string,
  doseId: string
): Promise<void> {
  if (getNativePlatform() === 'android') {
    await cancelDoseSnoozeNative(medId, doseId);
    return;
  }
  if (!isNativePlatform()) return;
  const id = notificationId('doseSnooze', `${medId}::${doseId}`);
  try {
    await LocalNotifications.cancel({ notifications: [{ id }] });
  } catch (err) {
    console.warn('[notifications] cancelSnoozedDoseReminder failed:', err);
  }
}

export async function scheduleSnoozedDoseReminder(
  medId: string,
  medName: string,
  doseAmount: number,
  unit: string,
  reminderTime: string | undefined,
  minutes: number,
  doseId: string,
  autoDeductEnabled?: boolean,
): Promise<void> {
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) return;

  const timeHint = reminderTime
    ? ` (موعد الجرعة الأصلي ${formatReminderTime12h(reminderTime)})`
    : '';
  const title = `⏰ تذكير مجدد: ${medName}`;
  const body = `غفوة ${minutes} دقيقة انتهت${timeHint}. جرعتك المقررة: ${doseAmount} ${unit}.`;

  if (getNativePlatform() === 'android') {
    await scheduleDoseSnoozeNative(
      medId,
      medName,
      doseAmount,
      unit,
      reminderTime,
      minutes,
      id,
      autoDeductEnabled === true
    );
    return;
  }

  if (getNativePlatform() === 'ios') {
    const notifId = notificationId('doseSnooze', `${medId}::${id}`);
    const fireAt = new Date(Date.now() + minutes * 60_000);
    const permission = await LocalNotifications.checkPermissions();
    if (permission.display !== 'granted') {
      throw new Error('Notification permission is required for snoozed dose reminders');
    }
    await LocalNotifications.schedule({
      notifications: [
        {
          id: notifId,
          title,
          body,
          schedule: { at: fireAt, allowWhileIdle: true },
          smallIcon: 'ic_launcher',
          channelId: getDoseReminderChannelId(),
          actionTypeId: autoDeductEnabled ? undefined : 'dose-reminder',
          ongoing: false,
          autoCancel: true,
          extra: { medicationId: medId, doseId: id },
        },
      ],
    });
    return;
  }

  await scheduleWebNotification(title, body);
}
