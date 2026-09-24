import { formatReminderTime12h } from '../time';
import {
  scheduleDoseSnoozeNative,
  cancelDoseSnoozeNative,
} from '../doseReminderNative';
import { cancelNotification, scheduleNotification } from '../notificationRuntime';
import { getNativePlatform, isNativePlatform } from './notificationPlatform';
import { scheduleWebNotification } from './webNotifications';

export const DOSE_REMINDER_CHANNEL_ID = 'dose-reminder-v3';
export const DOSE_REMINDER_FOREGROUND_CHANNEL_ID = 'dose-reminder-foreground-v1';
export const DOSE_REMINDER_TAKE_ACTION = {
  id: 'take_dose',
  title: 'تم أخذ الجرعة',
  foreground: true,
} as const;

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
    namespace: 'test',
    identity: 'test',
    title: 'إشعار تجريبي: متابع الأدوية',
    body: 'الإشعارات والتنبيهات تعمل بشكل سليم على جهازك!',
    channelId: getDoseReminderChannelId(),
    channelName: getDoseReminderChannelId(),
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
  try {
    const cancelled = await cancelNotification(
      'dose-reminder-snooze',
      `${medId}::${doseId}`
    );
    if (!cancelled) {
      throw new Error('dose_reminder_snooze_cancel_failed');
    }
  } catch (err) {
    throw err instanceof Error
      ? err
      : new Error('dose_reminder_snooze_cancel_failed');
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
  allowManualTakeAction: boolean = true,
  doseDescription?: string,
): Promise<void> {
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) return;

  const timeHint = reminderTime
    ? ` (موعد الجرعة الأصلي ${formatReminderTime12h(reminderTime)})`
    : '';
  const title = `تذكير مجدد: ${medName}`;
  const description = doseDescription?.trim();
  const body = `غفوة ${minutes} دقيقة انتهت${timeHint}. جرعتك المقررة: ${doseAmount} ${unit}${description ? `. طريقة تناول الجرعة: ${description}` : ''}.`;

  if (getNativePlatform() === 'android') {
    await scheduleDoseSnoozeNative(
      medId,
      medName,
      doseAmount,
      unit,
      reminderTime,
      minutes,
      id,
      allowManualTakeAction === true,
      description
    );
    return;
  }

  if (getNativePlatform() === 'ios') {
    const fireAt = new Date(Date.now() + minutes * 60_000);
    const scheduled = await scheduleNotification({
      namespace: 'dose-reminder-snooze',
      identity: `${medId}::${id}`,
      title,
      body,
      channelId: getDoseReminderChannelId(),
      channelName: getDoseReminderChannelId(),
      channelImportance: appInForeground ? 2 : 4,
      smallIcon: 'ic_launcher',
      autoCancel: true,
      ongoing: false,
      action: allowManualTakeAction ? DOSE_REMINDER_TAKE_ACTION : undefined,
      at: fireAt,
      extra: { medicationId: medId, doseId: id },
      fallbackToWeb: false,
    });
    if (!scheduled) {
      throw new Error('Notification scheduling failed');
    }
    return;
  }
  await scheduleWebNotification(title, body, {
    namespace: 'dose-reminder-snooze',
    identity: `${medId}::${id}`,
    at: new Date(Date.now() + minutes * 60_000),
  });
}
