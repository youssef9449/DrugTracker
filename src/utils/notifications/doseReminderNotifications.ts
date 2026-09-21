import { LocalNotifications } from '@capacitor/local-notifications';
import { formatReminderTime12h } from '../time';
import {
  scheduleDoseSnoozeNative,
  cancelDoseSnoozeNative,
} from '../doseReminderNative';
import { scheduleNotification } from './notificationRuntime';
import { notificationId } from './notificationIds';
import {
  getNativePlatform,
  isNativePlatform,
} from './notificationPlatform';
import { scheduleWebNotification } from './webNotifications';

export const DOSE_REMINDER_CHANNEL_ID = 'dose-reminder-v3';
export const DOSE_REMINDER_FOREGROUND_CHANNEL_ID = 'dose-reminder-foreground-v1';


let appInForeground = true;

export function setAppInForeground(value: boolean): void {
  appInForeground = value;
}

/**
 * Returns true if the app is currently in the foreground.
 */

export function isAppInForeground(): boolean {
  return appInForeground;
}

/**
 * The channel ID to use for dose reminders based on the current app state.
 * - Foreground: silent channel (no Android sound; in-app chime handles audio)
 * - Background/Killed: system-default-sound channel (dose-reminder-v3)
 */

export function getDoseReminderChannelId(): string {
  return appInForeground
    ? DOSE_REMINDER_FOREGROUND_CHANNEL_ID
    : DOSE_REMINDER_CHANNEL_ID;
}

/**
 * Returns 'android' when running on Android, 'ios' when on iOS, or
 * null for web/browser. Used to gate Android-only APIs like exact-alarm.
 */


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

/**
 * Web fallback: show a notification via the service worker when available,
 * falling back to the legacy `new Notification()` API (#104).
 *
 * The service-worker path (`registration.showNotification`) is preferred
 * because it works even when the tab is in the background, and it's the
 * only path that works once the browser deprecates `new Notification()`
 * (already the case in Chromium ≥ 88 for service-worker-controlled
 * pages). The SW is registered only in production (see src/main.tsx),
 * so in dev mode we fall back to `new Notification()` after a short
 * timeout guard (navigator.serviceWorker.ready would hang otherwise).
 */


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

/**
 * Schedule a ONE-SHOT dose-reminder notification `minutes` in the future.
 *
 * Called by useDoseReminders.snoozeAlarm when the user hits "غفوة" on the
 * DoseAlarmModal. Uses the doseSnooze id band so the snoozed notification
 * replaces (not duplicates) any pending snooze for the same med/dose.
 * When it fires (foreground or background):
 *   - Background: shown in the system tray with the channel's default
 *     sound.
 *   - Foreground: the localNotificationReceived listener calls
 *     openAlarm → re-opens the DoseAlarmModal (with doseId in extra).
 *
 * This replaces the old polling-based snooze, which only re-opened the
 * modal while the app was in the foreground. Now the snoozed reminder
 * fires via AlarmManager even if the user backgrounded the app.
 *
 * NOTE: the snoozed notification does NOT repeat — it fires once. The
 * recurring daily reminder (scheduleDoseReminder, doseAlarm band) is
 * unaffected and will still fire on later days at the slot time.
 *
 * Phase 3B: optional `doseId` scopes the notification id and payload so
 * snoozing one multi-dose slot does not cancel or replace another.
 */

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

  scheduleWebNotification(title, body);
}

/**
 * Optional behavior flags for {@link scheduleDoseReminder}.
 */
export interface ScheduleDoseReminderOptions {
  /**
   * Start the recurring schedule from TOMORROW even when today's HH:MM
   * is still in the future.
   *
   * Used when today's occurrence for this dose slot has already been
   * consumed (per-dose markers: doseConsumptionHistory).
   * The pending alarm is cancelled and re-armed from tomorrow so the
   * already-taken occurrence cannot produce today's reminder. Tomorrow
   * and later days fire normally at the schedule-row time.
   *
   * Medication-level lastConsumedDate is not the source of truth for
   * this suppression.
   */
  skipToday?: boolean;
  /**
   * When true, auto-deduction is active for this dose. The push notification
   * will NOT show the "تم أخذ الجرعة" action button.
   */
  autoDeductEnabled?: boolean;
}

/**
 * Whether today's occurrence of the given HH:MM reminder time is still
 * in the future. Uses the SAME boundary as {@link scheduleDoseReminder}
 * (HH:MM:00.000 strictly after `now`), so "still ahead" means exactly
 * "today's one-shot would still fire today".
 *
 * Used by useDoseReminderScheduler when suppressing a consumed dose:
 *   - still ahead → cancel + schedule next with skipToday.
 *   - already past → do not retract a delivered notification; the native
 *     delivery receiver may already have armed the next calendar-day occurrence.
 */
