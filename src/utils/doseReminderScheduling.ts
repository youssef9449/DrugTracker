import { formatReminderTime12h } from './time';
import { getTodayDateString, tomorrowDateString, localEpochMs } from './dateCalculations';
import {
  scheduleDoseReminderNative,
  cancelDoseReminderNative,
  isDoseReminderScheduledNative,
  cancelStaleDoseReminderAlarmsNative,
  type CancelStaleDoseReminderResult,
} from './doseReminderNative';
import { getNativePlatform, isNativePlatform } from './notifications/notificationPlatform';
import { cancelNotification, getPendingNotificationResult, scheduleNotification } from './notificationRuntime';
import { classifyNativeError, type NativeBoundaryFailure } from './nativeErrors';
import { scheduleWebNotification } from './notifications/webNotifications';
import {
  getDoseReminderChannelId,
  DOSE_REMINDER_TAKE_ACTION,
} from './notifications/doseReminderNotifications';
export type DoseReminderPendingResult =
  | { ok: true; pending: boolean }
  | NativeBoundaryFailure;

export async function isDoseReminderPending(
  medId: string,
  doseId: string
): Promise<DoseReminderPendingResult> {
  if (getNativePlatform() === 'android') {
    const result = await isDoseReminderScheduledNative(medId, doseId);
    return result.ok
      ? { ok: true, pending: result.scheduled }
      : result;
  }
  if (!isNativePlatform()) return { ok: true, pending: false };
  try {
    const pendingResult = await getPendingNotificationResult(
      'dose-reminder',
      `${medId}::${doseId}`
    );
    if (!pendingResult.ok) return pendingResult;
    const entry = pendingResult.pending;
    if (!entry) return { ok: true, pending: false };
    const at = (entry.schedule as { at?: unknown } | undefined)?.at;
    if (at == null) return { ok: true, pending: true };
    const atMs =
      typeof at === 'number'
        ? at
        : at instanceof Date
          ? at.getTime()
          : Date.parse(String(at));
    if (Number.isNaN(atMs)) return { ok: true, pending: true };
    return { ok: true, pending: atMs > Date.now() - 60_000 };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'dose_pending_lookup_failed';
    return {
      ok: false,
      error: message,
      errorCode: classifyNativeError(message),
    };
  }
}
/**
 * Reconciliation helper for the Dose Reminder scheduler.
 * Android queries the ExactAlarmRuntime pending state directly.
 */
export async function isNativeDoseReminderReArmed(
  medId: string,
  doseId: string,
  _reminderTime?: string
): Promise<
  | { ok: true; scheduled: boolean }
  | NativeBoundaryFailure
> {
  if (getNativePlatform() !== 'android') return { ok: true, scheduled: false };
  const result = await isDoseReminderScheduledNative(medId, doseId);
  return result.ok
    ? { ok: true, scheduled: result.scheduled }
    : result;
}
/**
 * Check the native scheduler's current one-shot state for this dose.
 * The scheduler uses this as its repair/reconciliation evidence.
 */
export async function cancelDoseReminder(
  medId: string,
  doseId: string
): Promise<void> {
  if (getNativePlatform() === 'android') {
    await cancelDoseReminderNative(medId, doseId);
    const notificationCancelled = await cancelNotification(
      'dose-reminder',
      `${medId}::${doseId}`
    );
    if (!notificationCancelled) {
      throw new Error('dose_reminder_notification_cancel_failed');
    }
    return;
  }
  if (!isNativePlatform()) return;
  try {
    const cancelled = await cancelNotification(
      'dose-reminder',
      `${medId}::${doseId}`
    );
    if (!cancelled) {
      throw new Error('dose_reminder_cancel_failed');
    }
  } catch (err) {
    throw err instanceof Error
      ? err
      : new Error('dose_reminder_cancel_failed');
  }
}
/**
 * Cancel pending one-shot snooze for an explicit dose row.
 */
export async function cancelStaleDoseReminderAlarms(
  keepKeys: ReadonlySet<string>
): Promise<CancelStaleDoseReminderResult> {
  if (getNativePlatform() === 'android') {
    return cancelStaleDoseReminderAlarmsNative(keepKeys);
  }
  return { ok: true };
}
/**
 * One-shot snooze notification id for an explicit dose row.
 * Requires non-empty doseId. Returns null when missing.
 */
export function isDoseReminderTimeStillAhead(
  reminderTime: string,
  now: Date = new Date()
): boolean {
  const today = getTodayDateString(now);
  const todayEpoch = localEpochMs(today, reminderTime);
  return todayEpoch != null && todayEpoch > now.getTime();
}
/**
 * Schedule the next one-shot dose-reminder alarm at the given HH:MM.
 * Next fire: today at HH:MM if still ahead, else tomorrow (or forced
 * tomorrow when options.skipToday). Uses a stable id
 * (medicationId + doseId) so reschedule replaces, not duplicates.
 * Recurrence: NOT via Capacitor repeats/every. The native Dose Reminder
 * receiver asks the shared exact-alarm runtime to arm the next calendar day.
 * `allowWhileIdle: true` lets the alarm fire in Doze mode.
 * Channel: dose-reminder-v3 / foreground silent variant at delivery.
 */
export interface ScheduleDoseReminderOptions {
  /**
   * Start the recurring schedule from TOMORROW even when today's HH:MM
   * is still in the future.
   * Used when today's occurrence for this dose slot has already been
   * consumed (per-dose markers: doseConsumptionHistory).
   * The pending alarm is cancelled and re-armed from tomorrow so the
   * already-taken occurrence cannot produce today's reminder. Tomorrow
   * and later days fire normally at the schedule-row time.
   * Medication-level lastConsumedDate is not the source of truth for
   * this suppression.
   */
  skipToday?: boolean;
  /** Optional per-dose user instruction from MedicationDose.description. */
  doseDescription?: string;
  /** Inclusive YYYY-MM-DD end date for a temporary treatment course. */
  treatmentEndDate?: string;
  /**
   * Whether the reminder may expose the manual "تم أخذ الجرعة" action.
   * The business layer supplies this neutral capability; Dose Reminder does
   * not know why the value is enabled or disabled.
   */
  allowManualTakeAction?: boolean;
}
/**
 * Whether today's occurrence of the given HH:MM reminder time is still
 * in the future. Uses the SAME boundary as {@link scheduleDoseReminder}
 * (HH:MM:00.000 strictly after `now`), so "still ahead" means exactly
 * "today's one-shot would still fire today".
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
      options?.allowManualTakeAction !== false,
      options?.doseDescription,
      options?.treatmentEndDate
    );
    return;
  }
  const now = new Date();
  const today = getTodayDateString();
  const todayEpoch = localEpochMs(today, reminderTime);
  const fireDate =
    options?.skipToday === true || todayEpoch == null || todayEpoch <= now.getTime()
      ? tomorrowDateString(today)
      : today;
  const fireEpoch = localEpochMs(fireDate, reminderTime);
  if (fireEpoch == null) return;
  const fireToday = new Date(fireEpoch);
  if (options?.treatmentEndDate && fireDate > options.treatmentEndDate) {
    return;
  }
  const title = `حان موعد دواء: ${medName}`;
  const description = options?.doseDescription?.trim();
  const body = `موعد الجرعة الساعة ${formatReminderTime12h(reminderTime)}. جرعتك المقررة: ${doseAmount} ${unit}${description ? `. طريقة تناول الجرعة: ${description}` : ''}.`;
  if (getNativePlatform() === 'ios') {
    const scheduled = await scheduleNotification({
      namespace: 'dose-reminder',
      identity: `${medId}::${id}`,
      title,
      body,
      channelId: getDoseReminderChannelId(),
      channelName: getDoseReminderChannelId(),
      channelImportance: getDoseReminderChannelId() === 'dose-reminder-foreground-v1' ? 2 : 4,
      smallIcon: 'ic_launcher',
      action:
        options?.allowManualTakeAction === false
          ? undefined
          : DOSE_REMINDER_TAKE_ACTION,
      at: fireToday,
      extra: {
        medicationId: medId,
        doseId: id,
        reminderTime,
        doseRecurring: true,
      },
      fallbackToWeb: false,
      autoCancel: true,
      ongoing: false,
    });
    if (!scheduled) {
      throw new Error('Notification scheduling failed');
    }
    return;
  }
  await scheduleWebNotification(title, body, {
    namespace: 'dose-reminder',
    identity: `${medId}::${id}`,
    at: fireToday,
  });
}
/**
 * Open the OS / browser notification settings page where the user
 * can toggle notification permissions per-app.
 * - **Capacitor native (Android/iOS)**: dynamically imports ../native
 *   and calls openAppSettings() which uses @capacitor/app's
 *   App.openAppSettings() to open the OS app info page.
 * - **Web (Chrome / Edge)**: opens chrome://settings/content/notifications
 *   in a new tab.
 * - **Firefox / Safari**: shows an Arabic alert with steps.
 */