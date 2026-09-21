import { LocalNotifications } from '@capacitor/local-notifications';
import {
  getNativePlatform,
  isNativePlatform,
  isWebNotificationSupported,
} from './notificationPlatform';
import { openBrowserNotificationSettings } from './webNotifications';

export async function getNotificationPermission(): Promise<
  'granted' | 'denied' | 'default' | 'unsupported'
> {
  if (isNativePlatform()) {
    try {
      const status = await LocalNotifications.checkPermissions();
      // Capacitor's permission state mapping:
      // 'prompt'      → user hasn't been asked (web 'default')
      // 'prompt-with-rationale' → user denied once, ask again with rationale
      // 'granted'     → allowed
      // 'denied'      → refused
      if (status.display === 'granted') return 'granted';
      if (status.display === 'denied') return 'denied';
      return 'default';
    } catch (err) {
      console.warn('[notifications] Capacitor checkPermissions failed:', err);
      return 'unsupported';
    }
  }

  if (!isWebNotificationSupported()) return 'unsupported';
  return Notification.permission;
}

/**
 * Request notification permission.
 *
 * - **Capacitor native**: calls LocalNotifications.requestPermissions(),
 *   which on Android 13+ shows the OS POST_NOTIFICATIONS permission
 *   dialog. On Android 12 and earlier, this is a no-op (notifications
 *   are allowed by default).
 * - **Web**: calls Notification.requestPermission(), showing the
 *   browser's permission prompt.
 *
 * Returns:
 *   - true  if permission is (or just got) granted
 *   - false if permission is denied OR the API is unsupported
 */

export async function requestNotificationPermission(): Promise<boolean> {
  // Native path — use Capacitor LocalNotifications.
  if (isNativePlatform()) {
    try {
      // First check the current state — if already granted, no need
      // to prompt again.
      const current = await LocalNotifications.checkPermissions();
      if (current.display === 'granted') return true;

      // If denied, the OS won't re-show the prompt — user must
      // change it via OS settings (the bell button handles this).
      if (current.display === 'denied') return false;

      // 'prompt' or 'prompt-with-rationale' — call requestPermissions
      // to trigger the OS dialog.
      const requested = await LocalNotifications.requestPermissions();
      return requested.display === 'granted';
    } catch (err) {
      console.warn('[notifications] Capacitor requestPermissions failed:', err);
      return false;
    }
  }

  // Web path — standard browser Notification API.
  if (!isWebNotificationSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const perm = await Notification.requestPermission();
    return perm === 'granted';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Exact-alarm capability (Android 12+ / API 31+)
//
// The shared Exact Alarm Runtime owns the Android exact-alarm capability check
// and settings action. Notification Runtime does not own or schedule alarms.
// ─────────────────────────────────────────────────────────────────────

/**
 * Check whether exact-alarm permission is granted on Android 12+.
 *
 * Exact-alarm permission is an Android-only concept (SCHEDULE_EXACT_ALARM).
 * On iOS and web, exact alarms don't require a separate permission —
 * the OS handles notification timing natively.
 *
 * Returns 'granted' when:
 *   - on web (no exact-alarm concept),
 *   - on iOS (no SCHEDULE_EXACT_ALARM equivalent — iOS handles it natively),
 *   - on Android < 12 (no permission needed — plugin returns 'granted'),
 *   - on Android 12+ with SCHEDULE_EXACT_ALARM granted.
 *
 * Returns 'denied' when the user has NOT granted SCHEDULE_EXACT_ALARM
 * on Android 12+. Returns 'unsupported' only if the API call itself
 * throws (should not happen with the installed plugin version).
 */
export { getExactAlarmPermission, openExactAlarmSettings } from './exactAlarm';

/**
 * Send a "low stock" notification when a medication is about to
 * run out. The notification fires immediately on the device.
 *
 * On Android: posts through the repository Notification Runtime.
 * On iOS: keeps the existing LocalNotifications fallback.
 *
 * On web: uses new Notification(title, body) directly.
 *
 * @param medId Stable medication id — used to derive a unique
 *   notification id so two medications that happen to share a name
 *   don't collide/overwrite each other in the notification drawer.
 * @param medicineName The medication name (displayed in the title)
 * @param daysLeft Days of supply remaining (in the body)
 * @param currentPills Current pill count (in the body)
 */

export function openNotificationSettings(): void {
  if (!isWebNotificationSupported() && !isNativePlatform()) {
    console.warn(
      '[notifications] This platform does not support notifications.'
    );
    return;
  }

  if (isNativePlatform()) {
    import('../../native')
      .then((m) => m.openAppSettings())
      .catch((err) => {
        console.warn('[notifications] Capacitor openAppSettings failed:', err);
        openBrowserNotificationSettings();
      });
    return;
  }

  openBrowserNotificationSettings();
}

/**
 * Browser-specific notification settings opener. Called as a
 * fallback when running outside Capacitor (e.g., on AI Studio's
 * preview, regular Chrome, Firefox, Safari).
 */
