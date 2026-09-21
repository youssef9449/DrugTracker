import { LocalNotifications } from '@capacitor/local-notifications';
import { scheduleCriticalAlarmNative, cancelCriticalAlarmNative, verifyCriticalAlarmPendingNative } from './criticalAlarmNative';
import { notificationId } from './notifications/notificationIds';
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
      notifications: [{ id: notificationId('criticalAlarm', medId) }],
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
    const id = notificationId('criticalAlarm', medId);
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
      unit
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
          id: notificationId('criticalAlarm', medId),
          title,
          body,
          schedule: {
            at: fireAt,
            allowWhileIdle: true,
          },
          channelId: 'low-stock',
          smallIcon: 'ic_launcher',
          ongoing: false,
          autoCancel: true,
          extra: {
            medicationId: medId,
          },
        },
      ],
    });
    return result.notifications.some(
      (n) => n.id === notificationId('criticalAlarm', medId)
    );
  } catch (err) {
    console.warn('[notifications] iOS scheduleCriticalAlarm failed:', err);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Daily dose-reminder alarm (AlarmManager-backed).
//
// Android architecture:
// - JavaScript chooses the next desired occurrence and calls DoseReminder's
//   exact-alarm adapter.
// - ExactAlarmRuntime owns AlarmManager timing and durable schedule identity.
// - DoseReminderAlarmReceiver posts through NotificationRuntime at delivery
//   and asks ExactAlarmRuntime to arm the next calendar-day occurrence.
// - useDoseReminderScheduler reconciles against the native exact-alarm state.
// iOS keeps its existing LocalNotifications fallback path.

// Sentinel lives in a leaf module so pure-logic modules (dateCalculations)
// can reference it without importing the notification stack.
// Re-exported here for convenient access from existing importers.

/**
 * Recurring dose-alarm id for an explicit doseSchedule row (Issue #268).
 * Identity = medicationId + doseId. Requires non-empty doseId.
 * Returns null when doseId is missing — callers must not schedule/cancel.
 *
 * This helper is retained for the iOS LocalNotifications fallback only.
 * Android future-alarm identity is the full logical medId::doseId inside
 * ExactAlarmRuntime.
 */
