/**
 * Browser notification utilities for الننغنغ (Drug Tracker).
 *
 * Notification permission flow
 * ----------------------------
 * 1. On first app open after install, App.tsx auto-requests
 *    permission via requestNotificationPermission() if the user
 *    hasn't been asked before (the browser default is 'default').
 * 2. If the user grants permission, notifications work normally.
 * 3. If the user **denies** permission once, the browser remembers
 *    that decision and `Notification.requestPermission()` becomes
 *    a no-op (returns 'denied' immediately without showing any
 *    prompt). At that point the only way to re-enable notifications
 *    is to open the browser/OS notification settings and toggle the
 *    permission back on manually.
 *
 *    The bell button in AppHeader calls openNotificationSettings()
 *    when it detects that permission is already denied, so the
 *    user is taken straight to the settings page where they can
 *    re-enable notifications.
 *
 * Permission states
 * -----------------
 * - 'default'  → user hasn't been asked yet; can call requestPermission()
 * - 'granted'   → notifications are allowed
 * - 'denied'    → user refused OR permission was revoked; browser won't
 *                show the prompt again until the user changes it in
 *                settings
 */

/**
 * Check whether the browser supports the Notification API at all.
 * On older Android WebViews the API may be missing entirely.
 */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Returns the current notification permission state.
 * - 'granted', 'denied', 'default', or 'unsupported' if the API
 *   is unavailable.
 */
export function getNotificationPermission():
  | 'granted'
  | 'denied'
  | 'default'
  | 'unsupported' {
  if (!isNotificationSupported()) return 'unsupported';
  return Notification.permission;
}

/**
 * Request notification permission from the user. Shows the browser
 * permission prompt if the permission state is 'default'.
 *
 * Returns:
 *   - true  if permission is (or just got) granted
 *   - false if permission is denied OR the API is unsupported
 *   - false if the user dismissed the prompt (browser returns 'default'
 *     after dismissal in some cases, treated as not-granted)
 *
 * NOTE: If permission was previously denied, this is a NO-OP and
 * returns false immediately — the browser will not re-show the
 * prompt. The caller should use openNotificationSettings() to send
 * the user to the settings page in that case.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!isNotificationSupported()) {
    return false;
  }
  if (Notification.permission === 'granted') {
    return true;
  }
  if (Notification.permission === 'denied') {
    // Browser won't re-prompt. User must change settings manually.
    return false;
  }
  // 'default' — show the browser prompt.
  try {
    const perm = await Notification.requestPermission();
    return perm === 'granted';
  } catch {
    return false;
  }
}

/**
 * Open the OS / browser notification settings page where the user
 * can toggle notification permissions per-site / per-app.
 *
 * Behavior depends on the platform:
 *
 * - **Capacitor (Android WebView / iOS)**: uses
 *   `App.openAppSettings()` from @capacitor/app to open the OS app
 *   settings page where the user can toggle notifications. The
 *   Capacitor runtime is detected via the global `capacitor` /
 *   `Capacitor` objects.
 *
 * - **Web (Chrome / Edge desktop)**: opens `chrome://settings/content/notifications`
 *   in a new tab. This URL only works in Chrome/Edge — on Firefox or
 *   Safari we fall back to an alert with instructions.
 *
 * - **iOS Safari**: there's no direct URL — we open an alert with
 *   instructions on how to enable notifications in iOS Settings.
 *
 * The function is intentionally side-effect-only (returns void) and
 * uses dynamic import for the Capacitor native bridge so a web-only
 * build doesn't pull in the Capacitor runtime if the user never
 * installs it.
 */
export function openNotificationSettings(): void {
  if (!isNotificationSupported()) {
    console.warn(
      '[notifications] This browser does not support the Notification API.'
    );
    return;
  }

  // Capacitor native (Android / iOS) — detect the Capacitor runtime
  // via the global `capacitor` / `Capacitor` objects. When detected,
  // dynamically import the native bridge and call openAppSettings().
  // Dynamic import is required because native.ts imports @capacitor/*
  // packages which only exist when the user has run `npm install`
  // in the project (which is always true for the APK build, but not
  // always true for AI Studio's web-only preview).
  if (
    typeof (window as any).capacitor !== 'undefined' ||
    typeof (window as any).Capacitor !== 'undefined'
  ) {
    import('../native')
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
function openBrowserNotificationSettings(): void {
  // Detect Chromium-based browsers via the vendor string.
  const isChromium =
    typeof navigator !== 'undefined' &&
    /Chrome|Chromium|Edg|OPR/i.test(navigator.userAgent);

  if (isChromium) {
    // chrome:// URLs only work in Chrome/Edge/Brave — they open the
    // site-specific notification permission UI where the user can
    // toggle this site's permission back to "Allow".
    try {
      window.open('chrome://settings/content/notifications', '_blank');
      return;
    } catch {
      // chrome:// URLs may be blocked by the browser's sandbox in
      // some contexts (e.g., iframe). Fall through to the help page.
    }
  }

  // Firefox / Safari / others — show a brief alert with instructions
  // since there's no portable URL that opens their settings page.
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

export function sendMedicineAlert(medicineName: string, daysLeft: number, currentPills: number) {
  if (!isNotificationSupported() || Notification.permission !== 'granted') {
    return;
  }

  const title = `⚠️ تنبيه اقتراب نفاد: ${medicineName}`;
  const daysText =
    daysLeft === 1
      ? 'يوم واحد'
      : daysLeft === 2
      ? 'يومين'
      : daysLeft <= 10
      ? `${daysLeft} أيام`
      : `${daysLeft} يوماً`;

  const bodyText =
    currentPills <= 0
      ? `المخزون نفد تماماً (0 حبة). يرجى طلب الدواء وتعبئته فوراً!`
      : `المتبقي ${currentPills} حبة فقط، تكفي لـ ${daysText}. يرجى الشراء قريباً!`;

  const options: NotificationOptions = {
    body: bodyText,
    icon: '/assets/icons/icon.svg',
    tag: `med-${medicineName}`,
  };

  try {
    new Notification(title, options);
  } catch {
    // Service worker fallback or silent fail
  }
}

/**
 * Sends a browser notification for a scheduled daily dose reminder.
 * If `reminderTime` is provided, the time is included in the notification body
 * to remind the user of the exact scheduled time.
 */
export function sendMedicationDoseReminder(
  medicineName: string,
  dailyDose: number,
  unit: string = 'قرص',
  currentPills: number,
  reminderTime?: string
) {
  if (!isNotificationSupported() || Notification.permission !== 'granted') {
    return;
  }

  const timeHint = reminderTime ? ` الساعة ${reminderTime}` : '';
  const title = `⏰ حان موعد دواء: ${medicineName}`;
  const bodyText = `موعد الجرعة${timeHint}. جرعتك المقررة: ${dailyDose} ${unit}. (المخزون الحالي: ${currentPills} ${unit}).`;

  const options: NotificationOptions = {
    body: bodyText,
    icon: '/assets/icons/icon.svg',
    tag: `dose-reminder-${medicineName}-${Date.now()}`,
  };

  try {
    new Notification(title, options);
  } catch {
    // Silent fail if permission or context blocked
  }
}
