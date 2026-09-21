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

// ─────────────────────────────────────────────────────────────────────
// One-shot critical-stock alarm (AlarmManager-backed).
//
// Replaces the previous "fire a critical alert when the alert effect
// sees the status worsen" pattern, which only ran while the app was
// open. The new pattern: schedule a SINGLE future notification at the
// calendar date the medication is projected to cross the critical
// threshold. If the user never opens the app, the alarm still fires
// via Android's AlarmManager (or iOS's UNUserNotificationCenter), and
// the user sees the critical alert in their notification drawer.
//
// Boot persistence: on Android, the @capacitor/local-notifications
// plugin persists scheduled notifications to SharedPreferences and
// re-arms them via its LocalNotificationRestoreReceiver on
// BOOT_COMPLETED (also LOCKED_BOOT_COMPLETED + QUICKBOOT_POWERON).
// Past-due notifications are rescheduled to fire ~15 seconds after
// boot. So scheduled one-shot critical alarms survive device reboots
// without the user opening the app — no BootReceiver code in our
// codebase needed.
//
// Rescheduling: the caller (useCriticalAlarmScheduler) cancels the
// existing alarm for a med and schedules a new one whenever any of
// the fields that affect the critical date change:
//   - currentPills (snapshot)
//   - dailyDose
//   - warningThresholdDays (IS the user-configured critical threshold)
//   - autoDeductEnabled
//   - medication id (med deleted/created)
//
// Race protection: useCriticalAlarmScheduler serializes every native
// cancel/schedule per medication on a shared operation queue and guards
// each operation with an in-memory generation counter, so an older
// async operation can neither recreate a stale alarm after a newer
// medication state nor clobber newer persistent claim state.
//
// Edge cases (handled by getCriticalAlarmDate, which returns null to
// signal "do not schedule"):
//   - dailyDose <= 0 → no consumption rate → no critical date.
//   - currentPills / daysLeftFromCurrentStock already at or below critical threshold →
//     the med is ALREADY critical. The one-shot alarm is only for
//     FUTURE crossings; the existing alert effect (which runs when
//     the app is open and tracks already-alerted statuses via
//     lastAlertedStatusRef) handles the immediate notification.
//     Returning null here prevents repeated immediate alerts on
//     every app launch.
//   - autoDeductEnabled === false AND not already critical → the
//     balance is frozen, won't cross the threshold without a refill.
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the unique notification id for a medication's critical alarm.
 * Stable across calls so cancel + reschedule work.
 */
/**
 * Critical Stock future-alarm bridge.
 *
 * Android: ExactAlarmRuntime owns the timer and CriticalStockAlarmReceiver
 * invokes NotificationRuntime at delivery. iOS keeps the existing
 * LocalNotifications fallback.
 */
