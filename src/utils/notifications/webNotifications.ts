import { SW_READY_TIMEOUT_MS } from '../time';
import { isWebNotificationSupported } from './notificationPlatform';

async function scheduleWebNotification(title: string, body: string): Promise<boolean> {
  if (!isWebNotificationSupported() || Notification.permission !== 'granted') {
    return false;
  }
  const options: NotificationOptions = {
    body,
    icon: '/assets/icons/icon.svg',
  };

  // Try the service-worker path first.
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      // Race against a 2s timeout so dev mode (where no SW is registered)
      // doesn't hang indefinitely.
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<ServiceWorkerRegistration | null>((resolve) =>
          setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS)
        ),
      ]);
      if (reg) {
        await reg.showNotification(title, options);
        return true;
      }
      // reg === null → timed out (dev mode, no SW). Fall through to legacy.
    } catch {
      // SW not available — fall through to legacy new Notification().
    }
  }

  // Legacy fallback.
  try {
    new Notification(title, options);
    return true;
  } catch {
    // Silent fail if the browser blocks the notification (e.g.,
    // service worker context).
    return false;
  }
}

/**
 * Notification ID scheme (audit issues #65 / #66).
 *
 * Capacitor LocalNotifications uses a numeric `id` to identify each
 * scheduled notification. Two notifications with the same id collide
 * (the later one overwrites the earlier). The previous scheme hashed a
 * category-prefixed string into a single 31-bit space. Five distinct
 * categories sharing one hash space meant cross-category collisions were
 * possible (e.g. hashCode('critical-alarm-medA') could equal
 * hashCode('med-medB')), silently overwriting/conflicting unrelated
 * notifications.
 *
 * The fix: reserve disjoint numeric ranges per category. Each category
 * gets a 1,000,000-wide band; within the band the id is derived from a
 * stable hash of medId so the same med always maps to the same id
 * (enabling cancel + reschedule). Cross-category collisions are now
 * structurally impossible because the bands do not overlap.
 *
 *   low-stock alert         1_000_000 + hash(medId) % 1_000_000
 *   critical-stock alert    2_000_000 + hash(medId) % 1_000_000
 *   dose reminder            3_000_000 + hash(medId) % 1_000_000
 *   test notification        4_000_000  (fixed constant, single test notif)
 *   critical one-shot alarm  5_000_000 + hash(medId) % 1_000_000
 *   dose recurring alarm     6_000_000 + hash(medId) % 1_000_000
 *
 * #66: the dose-reminder id previously included Date.now(), producing a
 * NEW id on every call. That broke the snooze-and-re-fire path: instead
 * of replacing the existing drawer entry, each snooze created a new one.
 * The id is now stable per med (the FIRED_KEY check in useDoseReminders
 * handles same-day dedup), restoring the original JSDoc intent.
 */
const ID_RANGE_SIZE = 1_000_000;

/** Numeric base for each notification category's id range. */
const NOTIFICATION_ID_BASE = {
  lowStock: 1_000_000,
  critical: 2_000_000,
  dose: 3_000_000,
  test: 4_000_000,
  criticalAlarm: 5_000_000,
  doseAlarm: 6_000_000,
  doseSnooze: 7_000_000,
} as const;

type NotificationCategory = keyof typeof NOTIFICATION_ID_BASE;

/**
 * Stable string hash mapped into [0, ID_RANGE_SIZE). Used to derive a
 * per-medication slot within a category's id range so the same med
 * always maps to the same notification id.
 */


function openBrowserNotificationSettings(): void {
  // #105: try opening the Chromium chrome://settings URL unconditionally
  // (it only works in Chromium-based browsers anyway). On failure or null
  // return (non-Chromium / sandboxed), fall through to the alert. This
  // replaces the previous UA-sniff branch decision.
  if (typeof window !== 'undefined') {
    try {
      const win = window.open('chrome://settings/content/notifications', '_blank');
      // window.open returns null when the browser blocks the navigation
      // (e.g. non-Chromium, iframe sandbox). In that case fall through.
      if (win) return;
    } catch {
      // chrome:// URLs may be blocked by the sandbox in some
      // contexts (iframe). Fall through to the alert.
    }
  }

  // Keep the UA-derived browser hint for the alert text (UX only — the
  // branch decision above is now feature-detected, not UA-sniffed).
  const browserHint = (() => {
    if (typeof navigator === 'undefined') return 'متصفحك';
    const ua = navigator.userAgent;
    if (/Firefox/i.test(ua)) return 'Firefox';
    if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
    return 'متصفحك';
  })();

  window.alert(
    `لتفعيل الإشعارات على ${browserHint}:\n\n` +
      `1. افتح إعدادات ${browserHint}\n` +
      `2. ابحث عن "إشعارات" أو "Notifications"\n` +
      `3. ابحث عن اسم هذا الموقع في القائمة\n` +
      `4. فعّل "السماح" وأعد تحميل الصفحة`
  );
}
