import { LocalNotifications } from '@capacitor/local-notifications';
import { formatReminderTime12h } from './time';
import {
  scheduleDoseReminderNative,
  cancelDoseReminderNative,
  isDoseReminderScheduledNative,
  cancelStaleDoseReminderAlarmsNative,
} from './doseReminderNative';
import { notificationId } from './notifications/notificationIds';
import { getNativePlatform, isNativePlatform } from './notifications/notificationPlatform';
import { scheduleWebNotification } from './notifications/webNotifications';
import { getDoseReminderChannelId } from './notifications/doseReminderNotifications';

export async function isDoseReminderPending(
  medId: string,
  doseId: string
): Promise<boolean> {
  if (getNativePlatform() === 'android') {
    return isDoseReminderScheduledNative(medId, doseId);
  }
  if (!isNativePlatform()) return false;
  try {
    const pending = await LocalNotifications.getPending();
    const id = notificationId('doseAlarm', `${medId}::${doseId}`);
    const entry = pending.notifications.find((n) => n.id === id);
    if (!entry) return false;
    const at = (entry.schedule as { at?: unknown } | undefined)?.at;
    if (at == null) return true;
    const atMs =
      typeof at === 'number'
        ? at
        : at instanceof Date
          ? at.getTime()
          : Date.parse(String(at));
    if (Number.isNaN(atMs)) return true;
    return atMs > Date.now() - 60_000;
  } catch (err) {
    console.warn('[notifications] isDoseReminderPending failed:', err);
    return false;
  }
}

/**
 * Compatibility reconciliation helper for the Dose Reminder scheduler.
 * Android now queries the ExactAlarmRuntime pending state directly.
 */

export async function isNativeDoseReminderReArmed(
  medId: string,
  doseId: string,
  _reminderTime?: string
): Promise<boolean> {
  if (getNativePlatform() !== 'android') return false;
  return isDoseReminderScheduledNative(medId, doseId);
}

/**
 * Legacy compatibility no-op retained for the existing scheduler API.
 * Delivery evidence is no longer stored in a separate notification plugin store.
 */

export async function cancelDoseReminder(
  medId: string,
  doseId: string
): Promise<void> {
  if (getNativePlatform() === 'android') {
    await cancelDoseReminderNative(medId, doseId);
    return;
  }
  if (!isNativePlatform()) return;
  const id = notificationId('doseAlarm', `${medId}::${doseId}`);
  try {
    await LocalNotifications.cancel({ notifications: [{ id }] });
  } catch (err) {
    console.warn('[notifications] cancelDoseReminder failed:', err);
  }
}

/**
 * Cancel pending one-shot snooze for an explicit dose row (Issue #268).
 */

export async function cancelStaleDoseReminderAlarms(
  keepKeys: ReadonlySet<string>
): Promise<void> {
  if (getNativePlatform() === 'android') {
    await cancelStaleDoseReminderAlarmsNative(keepKeys);
    return;
  }
}

/**
 * One-shot snooze notification id for an explicit dose row (Issue #268).
 * Requires non-empty doseId. Returns null when missing.
 */

export function isDoseReminderTimeStillAhead(
  reminderTime: string,
  now: Date = new Date()
): boolean {
  const parts = reminderTime.split(':').map((n) => parseInt(n, 10));
  const [hour, minute] = parts;
  if (parts.length < 2 || Number.isNaN(hour) || Number.isNaN(minute)) return false;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
  const todayAt = new Date(now);
  todayAt.setHours(hour, minute, 0, 0);
  return todayAt.getTime() > now.getTime();
}

/**
 * Schedule the next one-shot dose-reminder alarm at the given HH:MM.
 *
 * Next fire: today at HH:MM if still ahead, else tomorrow (or forced
 * tomorrow when options.skipToday). Uses a stable id
 * (medicationId + doseId) so reschedule replaces, not duplicates.
 *
 * Recurrence: NOT via Capacitor repeats/every. The native Dose Reminder
 * receiver asks the shared exact-alarm runtime to arm the next calendar day.
 *
 * `allowWhileIdle: true` lets the alarm fire in Doze mode.
 * Channel: dose-reminder-v3 / foreground silent variant at delivery.
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

export async function scheduleDoseReminder(
  medId: string,
  medName: string,
  reminderTime: string,
  doseAmount: number,
  unit: string,
  doseId: string,
  options?: ScheduleDoseReminderOptions,
): Promise<void> {
  const parts = reminderTime.split(':').map((n) => parseInt(n, 10));
  const [hour, minute] = parts;
  if (parts.length < 2 || Number.isNaN(hour) || Number.isNaN(minute)) return;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return;

  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id || !(Number(doseAmount) > 0)) return;

  if (getNativePlatform() === 'android') {
    await scheduleDoseReminderNative(
      medId,
      medName,
      reminderTime,
      Number(doseAmount),
      unit,
      id,
      options?.skipToday === true,
      options?.autoDeductEnabled === true
    );
    return;
  }

  const now = new Date();
  const fireToday = new Date();
  fireToday.setHours(hour, minute, 0, 0);
  if (fireToday.getTime() <= now.getTime() || options?.skipToday === true) {
    fireToday.setDate(fireToday.getDate() + 1);
  }

  const title = `⏰ حان موعد دواء: ${medName}`;
  const body = `موعد الجرعة الساعة ${formatReminderTime12h(reminderTime)}. جرعتك المقررة: ${doseAmount} ${unit}.`;

  if (getNativePlatform() === 'ios') {
    const notifId = notificationId('doseAlarm', `${medId}::${id}`);
    const permission = await LocalNotifications.checkPermissions();
    if (permission.display !== 'granted') {
      throw new Error('Notification permission is required for dose reminders');
    }
    await LocalNotifications.schedule({
      notifications: [
        {
          id: notifId,
          title,
          body,
          schedule: { at: fireToday, allowWhileIdle: true },
          smallIcon: 'ic_launcher',
          channelId: getDoseReminderChannelId(),
          actionTypeId:
            options?.autoDeductEnabled ? undefined : 'dose-reminder',
          ongoing: false,
          autoCancel: true,
          extra: {
            medicationId: medId,
            doseId: id,
            reminderTime,
            doseRecurring: true,
          },
        },
      ],
    });
    return;
  }

  if (options?.skipToday !== true) {
    scheduleWebNotification(title, body);
  }
}

/**
 * Open the OS / browser notification settings page where the user
 * can toggle notification permissions per-app.
 *
 * - **Capacitor native (Android/iOS)**: dynamically imports ../native
 *   and calls openAppSettings() which uses @capacitor/app's
 *   App.openAppSettings() to open the OS app info page.
 * - **Web (Chrome / Edge)**: opens chrome://settings/content/notifications
 *   in a new tab.
 * - **Firefox / Safari**: shows an Arabic alert with steps.
 */
