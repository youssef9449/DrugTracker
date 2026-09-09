/**
 * Notification utilities for النغنغ (Drug Tracker).
 *
 * Two backends are used depending on platform:
 *
 * - **Capacitor (Android/iOS)**: uses @capacitor/local-notifications,
 *   which schedules notifications natively via Android's
 *   NotificationManager. This means notifications fire even when
 *   the app is in the background or killed, and they appear in
 *   the Android notification drawer with the app's icon. On
 *   Android 13+ (API 33+), this plugin also handles the
 *   POST_NOTIFICATIONS runtime permission request automatically
 *   — without this permission, no notification will be shown.
 *
 * - **Web (Chrome / Edge / Firefox / Safari)**: uses the standard
 *   browser `Notification` API. This is the case when running in
 *   AI Studio's preview or a normal browser tab.
 *
 * The detection happens via `Capacitor.getPlatform()` from
 * @capacitor/core. When the platform is 'web' (or when Capacitor is
 * not available), we fall back to the browser Notification API.
 *
 * Permission flow
 * ---------------
 * 1. On first app open after install, App.tsx auto-requests
 *    permission via requestNotificationPermission() when the
 *    permission state is 'default'.
 * 2. On Android 13+, this triggers the OS-level POST_NOTIFICATIONS
 *    permission dialog (handled by Capacitor LocalNotifications).
 *    On older Android versions, no permission dialog is shown
 *    (notifications are allowed by default).
 * 3. On web, this triggers the browser permission prompt.
 * 4. If permission was denied, the bell button in AppHeader calls
 *    openNotificationSettings() to send the user to the OS/browser
 *    settings page where they can re-enable notifications.
 */

import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

/**
 * Returns true when running inside the Capacitor native runtime
 * (Android or iOS). When false, we're in a browser/AI Studio preview
 * and should use the standard Notification API.
 */
function isNativePlatform(): boolean {
  try {
    if (typeof Capacitor === 'undefined') return false;
    const platform = Capacitor.getPlatform();
    return platform === 'android' || platform === 'ios';
  } catch {
    return false;
  }
}

/**
 * Check whether the browser (or WebView) supports the standard
 * Notification API. Used as a feature-detection gate for the
 * fallback path.
 */
function isWebNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Returns the current notification permission state in a unified
 * format that works across Capacitor native and web platforms.
 *
 * - 'granted'  : notifications are allowed
 * - 'denied'   : user refused permission
 * - 'default'  : user hasn't been asked yet
 * - 'unsupported': the API is unavailable (very rare)
 */
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

/**
 * Send a "low stock" notification when a medication is about to
 * run out. The notification fires immediately on the device.
 *
 * On Capacitor native: uses LocalNotifications.schedule() with a
 * 1-second offset so it appears as a real Android system
 * notification (icon + drawer entry + sound), even if the app
 * is in the background.
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
export async function sendMedicineAlert(
  medId: string,
  medicineName: string,
  daysLeft: number,
  currentPills: number
): Promise<void> {
  const title = `⚠️ تنبيه اقتراب نفاذ: ${medicineName}`;
  const daysText =
    daysLeft === 1
      ? 'يوم واحد'
      : daysLeft === 2
      ? 'يومين'
      : daysLeft <= 10
      ? `${daysLeft} أيام`
      : `${daysLeft} يوماً`;

  const body =
    currentPills <= 0
      ? `المخزون نفد تماماً (0 حبة). يرجى طلب الدواء وتعبئته فوراً!`
      : `المتبقي ${currentPills} حبة فقط، تكفي لـ ${daysText}. يرجى الشراء قريباً!`;

  await scheduleNotification({
    id: hashCode(`med-${medId}`),
    title,
    body,
    channelId: 'low-stock',
    smallIcon: 'ic_launcher',
  });
}

/**
 * Send a "critical stock" notification — fires when a medication
 * crosses the critical threshold (derived from warningThresholdDays).
 * The notification is more urgent than sendMedicineAlert because the
 * medication will run out within the critical window.
 *
 * This is the headline feature of the app — the user explicitly
 * requested it: "عايز اشعار يظهر لو في دواء فاضل فيه حبايتين مع
 * الاوبشن اني افعل الموضوع دة او اقفله".
 *
 * The notification can be turned off via the
 * `criticalStockAlertsEnabled` toggle in AppHeader. The caller is
 * responsible for checking the toggle before calling this function.
 *
 * @param medId Stable medication id — used to derive a unique
 *   notification id (avoids collisions with same-named medications).
 * @param medicineName The medication name (in the title)
 * @param daysLeft Days of supply remaining (drives the urgency wording)
 * @param currentPills Current pill count (in the body)
 * @param unit Unit (e.g., 'قرص', 'كبسولة')
 */
export async function sendCriticalStockAlert(
  medId: string,
  medicineName: string,
  daysLeft: number,
  currentPills: number,
  unit: string = 'قرص'
): Promise<void> {
  // Title reflects the actual situation: out of stock, or critical
  // with N days left (the critical threshold is derived from the
  // medication's warningThresholdDays — see getCriticalThresholdDays).
  const title =
    currentPills <= 0
      ? `🚨 ${medicineName}: نفد المخزون!`
      : daysLeft <= 1
      ? `🚨 ${medicineName}: حرج — باقي يوم واحد!`
      : `🚨 ${medicineName}: حرج — باقي ${daysLeft} أيام!`;

  const daysWord =
    daysLeft === 1 ? 'يوم واحد' : daysLeft === 2 ? 'يومين' : `${daysLeft} أيام`;

  const body =
    currentPills <= 0
      ? `المخزون نفد تماماً (0 ${unit}). يرجى طلب الدواء فوراً!`
      : `متبقي ${currentPills} ${unit} فقط من "${medicineName}"، تكفي لـ ${daysWord}. يرجى التعبئة فوراً!`;

  await scheduleNotification({
    // Use a different notification ID hash from sendMedicineAlert so
    // the two notifications don't collide / overwrite each other.
    id: hashCode(`critical-${medId}`),
    title,
    body,
    channelId: 'low-stock',
    smallIcon: 'ic_launcher',
  });
}

/**
 * Send a "dose reminder" notification — fires when the user has a
 * medication with `reminderEnabled + reminderTime` set and the
 * current time matches the reminder time.
 *
 * @param medId Stable medication id (for a unique notification id)
 * @param medicineName Medication name (title)
 * @param dailyDose Daily dose amount (body)
 * @param unit Unit (e.g., 'قرص')
 * @param currentPills Current pill count (body)
 * @param reminderTime HH:MM string (24-hour) for the scheduled time
 * @param customSoundFile Optional global custom sound — when provided,
 *   its data URL is stored in the notification's `extra` field so the
 *   foreground listener can play it (and the background channel uses
 *   the default sound).
 */
export async function sendMedicationDoseReminder(
  medId: string,
  medicineName: string,
  dailyDose: number,
  unit: string = 'قرص',
  currentPills: number,
  reminderTime?: string,
  customSoundFile?: { fileName: string; mimeType: string; dataUrl: string } | null
): Promise<void> {
  const timeHint = reminderTime ? ` الساعة ${reminderTime}` : '';
  const title = `⏰ حان موعد دواء: ${medicineName}`;
  const body = `موعد الجرعة${timeHint}. جرعتك المقررة: ${dailyDose} ${unit}. (المخزون الحالي: ${currentPills} ${unit}).`;

  await scheduleNotification({
    id: hashCode(`dose-${medId}-${Date.now()}`),
    title,
    body,
    channelId: 'dose-reminder',
    smallIcon: 'ic_launcher',
    customSoundFile,
  });
}

/**
 * Internal helper: schedule a notification on whichever platform
 * the app is running on. Falls back to the browser Notification API
 * when Capacitor isn't available.
 *
 * @param opts.customSoundFile — optional user-uploaded custom sound.
 *   When provided, the file's data URL is stored in the
 *   notification's `extra` field. A `localNotificationReceived`
 *   listener in native.ts reads this field and plays the custom
 *   sound via an HTMLAudioElement when the notification fires in
 *   the foreground. On Android, the notification channel's default
 *   sound still plays in the background (when the app is closed) —
 *   there's no portable way to play a per-notification custom sound
 *   in background without writing the file to the device's
 *   `res/raw` directory, which requires native code.
 */
async function scheduleNotification(opts: {
  id: number;
  title: string;
  body: string;
  channelId: string;
  smallIcon: string;
  customSoundFile?: { fileName: string; mimeType: string; dataUrl: string } | null;
}): Promise<void> {
  if (isNativePlatform()) {
    try {
      // Make sure we have permission before scheduling.
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') return;

      await LocalNotifications.schedule({
        notifications: [
          {
            id: opts.id,
            title: opts.title,
            body: opts.body,
            // Schedule 1 second in the future so it appears as a
            // real notification (not "delivered immediately" which
            // some Android versions treat as a head-up only).
            schedule: { at: new Date(Date.now() + 1000) },
            // Sound: uses the default Android notification sound
            // for the channel. The custom sound is played via the
            // localNotificationReceived listener in the foreground.
            sound: undefined,
            smallIcon: opts.smallIcon,
            channelId: opts.channelId,
            // Android notification grouping — group all dose reminders
            // together so they don't clutter the drawer.
            ongoing: false,
            autoCancel: true,
            // Store the custom sound file in `extra` so the
            // localNotificationReceived listener can access it when
            // the notification fires. The `extra` field is an opaque
            // bag that Capacitor serializes via Gson on Android —
            // objects with string fields work fine.
            extra: opts.customSoundFile
              ? {
                  customSoundFile: {
                    fileName: opts.customSoundFile.fileName,
                    mimeType: opts.customSoundFile.mimeType,
                    dataUrl: opts.customSoundFile.dataUrl,
                  },
                }
              : undefined,
          },
        ],
      });
    } catch (err) {
      console.warn('[notifications] Capacitor schedule failed:', err);
      // Fall back to web notification API as a last resort.
      scheduleWebNotification(opts.title, opts.body);
      // Also play the custom sound in the foreground as a fallback.
      if (opts.customSoundFile) {
        import('../utils/sound')
          .then((m) => m.playNotificationSound('custom', opts.customSoundFile!))
          .catch(() => void 0);
      }
    }
    return;
  }

  scheduleWebNotification(opts.title, opts.body);
  // On web, also play the custom sound via the Web Audio API.
  if (opts.customSoundFile) {
    import('../utils/sound')
      .then((m) => m.playNotificationSound('custom', opts.customSoundFile!))
      .catch(() => void 0);
  }
}

/**
 * Send a test notification immediately so the user can verify that
 * notifications and sounds work properly on their device.
 */
export async function sendTestAlertNotification(
  customSoundFile?: { fileName: string; mimeType: string; dataUrl: string } | null
): Promise<void> {
  await scheduleNotification({
    id: hashCode('med-test-notification'),
    title: '🔔 إشعار تجريبي: متابع الأدوية',
    body: 'الإشعارات والتنبيهات تعمل بشكل سليم على جهازك!',
    channelId: 'dose-reminders',
    smallIcon: 'ic_launcher',
    customSoundFile,
  });
}

/**
 * Web fallback: use the browser Notification API.
 */
function scheduleWebNotification(title: string, body: string): void {
  if (!isWebNotificationSupported() || Notification.permission !== 'granted') {
    return;
  }
  try {
    new Notification(title, {
      body,
      icon: '/assets/icons/icon.svg',
    });
  } catch {
    // Silent fail if the browser blocks the notification (e.g.,
    // service worker context).
  }
}

/**
 * Create a stable numeric hash from a string — used as the
 * notification ID so we can replace/update existing notifications
 * with the same key (e.g., to avoid duplicates when the user
 * snoozes and the alarm fires again).
 */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
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
// Rescheduling: the caller (App.tsx reschedule effect) cancels the
// existing alarm for a med and schedules a new one whenever any of
// the fields that affect the critical date change:
//   - currentPills (snapshot)
//   - dailyDose
//   - lastSyncDate
//   - warningThresholdDays (critical threshold is derived from it)
//   - autoDeductEnabled
//   - medication id (med deleted/created)
//
// Edge cases:
//   - dailyDose <= 0 → no consumption rate → no critical date. Don't
//     schedule. The UI shows "استهلاك غير محدد" anyway.
//   - effectiveCurrentPills <= 0 → med is already out of stock. Treat
//     as critical-now: send the notification immediately (at: now+1s)
//     once, but DON'T schedule a future-dated alarm. The immediate
//     notification id is the same as the alarm id (so it coalesces if
//     one already fired today).
//   - critical date already in the past (e.g. effective pills <
//     critical threshold * dose at lastSyncDate) → treat as
//     immediate too.
//   - autoDeductEnabled === false → the effective balance is frozen
//     at currentPills. Schedule at the calendar date it WILL cross
//     the threshold based on that static balance, OR immediately if
//     it's already critical.
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the unique notification id for a medication's critical alarm.
 * Stable across calls so cancel + reschedule work.
 */
export function criticalAlarmId(medId: string): number {
  return hashCode('critical-alarm-' + medId);
}

/**
 * Cancel any pending one-shot critical alarm for this medication.
 *
 * On native: calls LocalNotifications.cancel() with the stable id.
 * On web: no persistent alarm to cancel (web notifications are
 * fire-and-forget; the "alarm" is conceptually just a future
 * scheduleNotification call that happens to have a future `at`).
 */
export async function cancelCriticalAlarm(medId: string): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({
      notifications: [{ id: criticalAlarmId(medId) }],
    });
  } catch (err) {
    console.warn('[notifications] cancelCriticalAlarm failed:', err);
  }
}

/**
 * Schedule a one-shot critical-stock alarm at the given absolute time.
 *
 * This is the single entry point for critical-date scheduling. The
 * caller computes `criticalDateMs` (via getCriticalAlarmDate in
 * dateCalculations) and passes it here.
 *
 * `criticalDateMs <= Date.now()` is treated as "immediate" — we
 * schedule the notification 1 second in the future so it appears as
 * a real system notification (Capacitor treats `at: now` as
 * "delivered immediately" which some Android versions only show as a
 * head-up that auto-dismisses). This is intentional — if the med is
 * ALREADY critical, we want a one-time alert now, not a future one.
 *
 * `unit` is included in the notification body for display.
 */
export async function scheduleCriticalAlarm(
  medId: string,
  medName: string,
  criticalDateMs: number,
  unit: string = 'قرص'
): Promise<void> {
  // Compute the schedule time. If the computed critical date is in
  // the past (or very close), use "now + 1s" so the notification
  // appears as a real system notification.
  const fireAt =
    criticalDateMs <= Date.now() + 60_000
      ? new Date(Date.now() + 1000)
      : new Date(criticalDateMs);

  const title = `🚨 ${medName}: اقترب النفاد الحرج`;
  const body = `مخزون "${medName}" دخل مرحلة النفاد الحرج (${unit}). يرجى التعبئة فوراً!`;

  // On native: schedule via LocalNotifications (one-shot, AlarmManager).
  // Use the channelId 'low-stock' so it shares the same channel as the
  // immediate sendCriticalStockAlert (the existing channel is already
  // configured for urgent alerts).
  if (isNativePlatform()) {
    try {
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') return;
      await LocalNotifications.schedule({
        notifications: [
          {
            id: criticalAlarmId(medId),
            title,
            body,
            schedule: {
              at: fireAt,
              // Allow while idle — critical alerts should fire even
              // when the device is in Doze. This maps to
              // AlarmManager.setAndAllowWhileIdle on Android.
              allowWhileIdle: true,
            },
            channelId: 'low-stock',
            smallIcon: 'ic_launcher',
            ongoing: false,
            autoCancel: true,
          },
        ],
      });
      return;
    } catch (err) {
      console.warn('[notifications] Capacitor scheduleCriticalAlarm failed:', err);
      // Fall through to web fallback below.
    }
  }

  // Web fallback: no persistent scheduling available — fire the
  // notification immediately (since we can't reliably wake the page
  // up at a future time). The user will at least see an immediate
  // alert if they happen to have the tab open. This is a known
  // limitation; the headline use case is the Android native path.
  scheduleWebNotification(title, body);
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
export function openNotificationSettings(): void {
  if (!isWebNotificationSupported() && !isNativePlatform()) {
    console.warn(
      '[notifications] This platform does not support notifications.'
    );
    return;
  }

  if (isNativePlatform()) {
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
  const isChromium =
    typeof navigator !== 'undefined' &&
    /Chrome|Chromium|Edg|OPR/i.test(navigator.userAgent);

  if (isChromium) {
    try {
      window.open('chrome://settings/content/notifications', '_blank');
      return;
    } catch {
      // chrome:// URLs may be blocked by the sandbox in some
      // contexts (iframe). Fall through to the alert.
    }
  }

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

/**
 * Backwards-compatibility: some callers (e.g., App.tsx's initial
 * state hydration) check Notification.permission synchronously.
 * This wrapper returns the cached web Notification state on web
 * (the same as before this PR), and on native falls back to
 * 'default' (the native permission state is async-only, so we
 * can't return it synchronously — the caller should use the async
 * getNotificationPermission() instead).
 *
 * @deprecated Prefer getNotificationPermission() (async).
 */
export function getNotificationPermissionSync():
  | 'granted'
  | 'denied'
  | 'default'
  | 'unsupported' {
  if (isNativePlatform()) {
    // Native permission state is async-only. The caller should use
    // getNotificationPermission() instead. As a fallback, return
    // 'default' so the caller will trigger requestPermission() at
    // least once.
    return 'default';
  }
  if (!isWebNotificationSupported()) return 'unsupported';
  return Notification.permission;
}
