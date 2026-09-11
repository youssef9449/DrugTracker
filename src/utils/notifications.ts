/**
 * Notification utilities for Drug Tracker..
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
import {
  NOTIFICATION_IMMEDIATE_OFFSET_MS,
  CRITICAL_ALARM_IMMEDIATE_TOLERANCE_MS,
  SW_READY_TIMEOUT_MS,
} from './time';

/**
 * The single Android notification channel for dose reminders.
 * Versioned because Android channel sound settings are immutable —
 * bumping the suffix is the only way to change the bundled sound.
 *
 * The channel is created in native.ts with:
 *   - sound: 'dose_reminder.wav' (bundled native sound)
 *   - importance: HIGH (heads-up + sound)
 *   - visibility: PUBLIC (lock screen)
 *
 * There is NO foreground/background channel switching. The same channel
 * is used whether the app is foreground, background, or killed. The
 * native notification sound is the ONLY sound for dose reminders —
 * no JS sound playback is involved.
 */
export const DOSE_REMINDER_CHANNEL_ID = 'dose-reminder-v2';

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

// ─────────────────────────────────────────────────────────────────────
// Exact-alarm permission (Android 12+ / API 31+)
//
// @capacitor/local-notifications v6 schedules notifications via
// AlarmManager. On Android 12+, exact alarms require the
// SCHEDULE_EXACT_ALARM permission, which the user must grant via the
// Android settings screen (ACTION_REQUEST_SCHEDULE_EXACT_ALARM).
//
// When exact-alarm permission is GRANTED, the plugin uses
// AlarmManager.setExactAndAllowWhileIdle → the notification fires at
// the exact scheduled time.
//
// When DENIED, the plugin falls back to setAndAllowWhileIdle (inexact)
// → the notification may be delayed by minutes or hours. For medication
// dose reminders this is unacceptable, so we treat exact-alarm as a
// mandatory capability and surface its state to the UI.
//
// The plugin's API:
//   checkExactNotificationSetting() → { exact_alarm: 'granted' | 'denied' | 'prompt' }
//   changeExactNotificationSetting() → opens the Android settings screen
//     (returns 'granted' on Android < 12 where no permission is needed)
//
// Note: on Android < 12, checkExactNotificationSetting returns 'granted'
// because exact alarms don't require a separate permission.
// ─────────────────────────────────────────────────────────────────────

/**
 * Check whether exact-alarm permission is granted on Android 12+.
 *
 * Returns 'granted' when:
 *   - the app is NOT on a native platform (web — treated as granted
 *     since web has no exact-alarm concept),
 *   - OR the Android version is < 12 (no permission needed),
 *   - OR the user has granted SCHEDULE_EXACT_ALARM.
 *
 * Returns 'denied' when the user has NOT granted the permission on
 * Android 12+. Returns 'unsupported' if the check itself failed
 * (e.g. an older plugin version that doesn't expose the method).
 */
export async function getExactAlarmPermission(): Promise<
  'granted' | 'denied' | 'unsupported'
> {
  if (!isNativePlatform()) return 'granted';
  try {
    const status = await LocalNotifications.checkExactNotificationSetting();
    // The plugin maps Android's canScheduleExactAlarms() to exact_alarm
    // state: 'granted' when true, 'denied' when false. On Android < 12
    // the plugin returns 'granted'.
    if (status.exact_alarm === 'granted') return 'granted';
    return 'denied';
  } catch (err) {
    console.warn('[notifications] checkExactNotificationSetting failed:', err);
    return 'unsupported';
  }
}

/**
 * Open the Android settings screen where the user can grant the
 * SCHEDULE_EXACT_ALARM permission.
 *
 * On Android < 12 this is a no-op (returns 'granted' immediately).
 * On Android 12+ it opens the system settings page for the app; the
 * user grants/denies, then returns to the app. The caller must
 * re-check permission via getExactAlarmPermission() after the app
 * resumes (see the appState listener in App.tsx).
 *
 * Returns true if the settings screen was opened, false if not
 * available (web / unsupported).
 */
export async function openExactAlarmSettings(): Promise<boolean> {
  if (!isNativePlatform()) return false;
  try {
    await LocalNotifications.changeExactNotificationSetting();
    return true;
  } catch (err) {
    console.warn('[notifications] changeExactNotificationSetting failed:', err);
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
    id: notificationId('lowStock', medId),
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
    // Disjoint id range from sendMedicineAlert's lowStock band so the
    // two notifications don't collide / overwrite each other.
    id: notificationId('critical', medId),
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
 * Uses the single `dose-reminder-v2` channel with the bundled native
 * sound. No JS sound playback is involved.
 *
 * @param medId Stable medication id (for a unique notification id)
 * @param medicineName Medication name (title)
 * @param dailyDose Daily dose amount (body)
 * @param unit Unit (e.g., 'قرص')
 * @param currentPills Current pill count (body)
 * @param reminderTime HH:MM string (24-hour) for the scheduled time
 */
export async function sendMedicationDoseReminder(
  medId: string,
  medicineName: string,
  dailyDose: number,
  unit: string = 'قرص',
  currentPills: number,
  reminderTime?: string,
): Promise<void> {
  const timeHint = reminderTime ? ` الساعة ${reminderTime}` : '';
  const title = `⏰ حان موعد دواء: ${medicineName}`;
  const body = `موعد الجرعة${timeHint}. جرعتك المقررة: ${dailyDose} ${unit}. (المخزون الحالي: ${currentPills} ${unit}).`;

  await scheduleNotification({
    id: notificationId('dose', medId),
    title,
    body,
    channelId: DOSE_REMINDER_CHANNEL_ID,
    smallIcon: 'ic_launcher',
    actionTypeId: 'dose-reminder',
    extra: { medicationId: medId },
  });
}

/**
 * Internal helper: schedule a notification on whichever platform
 * the app is running on. Falls back to the browser Notification API
 * when Capacitor isn't available.
 *
 * The notification sound is handled entirely by the Android notification
 * channel (bundled native sound). No JS sound playback is involved.
 */
async function scheduleNotification(opts: {
  id: number;
  title: string;
  body: string;
  channelId: string;
  smallIcon: string;
  actionTypeId?: string;
  extra?: Record<string, unknown>;
}): Promise<void> {
  if (isNativePlatform()) {
    try {
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') {
        console.warn('[notifications] scheduleNotification skipped: permission not granted');
        return;
      }

      await LocalNotifications.schedule({
        notifications: [
          {
            id: opts.id,
            title: opts.title,
            body: opts.body,
            schedule: { at: new Date(Date.now() + NOTIFICATION_IMMEDIATE_OFFSET_MS) },
            smallIcon: opts.smallIcon,
            channelId: opts.channelId,
            actionTypeId: opts.actionTypeId,
            ongoing: false,
            autoCancel: true,
            extra: {
              ...opts.extra,
            },
          },
        ],
      });
    } catch (err) {
      console.warn('[notifications] Capacitor schedule failed:', err);
      scheduleWebNotification(opts.title, opts.body);
    }
    return;
  }

  scheduleWebNotification(opts.title, opts.body);
}

/**
 * Send a test notification immediately so the user can verify that
 * notifications work properly on their device. Uses the same channel
 * and native sound as real dose reminders.
 */
export async function sendTestAlertNotification(): Promise<void> {
  await scheduleNotification({
    id: notificationId('test'),
    title: '🔔 إشعار تجريبي: متابع الأدوية',
    body: 'الإشعارات والتنبيهات تعمل بشكل سليم على جهازك!',
    channelId: DOSE_REMINDER_CHANNEL_ID,
    smallIcon: 'ic_launcher',
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
async function scheduleWebNotification(title: string, body: string): Promise<void> {
  if (!isWebNotificationSupported() || Notification.permission !== 'granted') {
    return;
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
        return;
      }
      // reg === null → timed out (dev mode, no SW). Fall through to legacy.
    } catch {
      // SW not available — fall through to legacy new Notification().
    }
  }

  // Legacy fallback.
  try {
    new Notification(title, options);
  } catch {
    // Silent fail if the browser blocks the notification (e.g.,
    // service worker context).
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
function hashToRange(str: string, rangeSize: number): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % rangeSize;
}

/**
 * Compute a stable notification id for a given category + medication.
 *
 * - test category returns a fixed constant (there is only ever one
 *   test notification at a time).
 * - All other categories return BASE + hash(medId) % RANGE_SIZE, so the
 *   same med always maps to the same id within its category's band, and
 *   different categories never collide (disjoint bands).
 */
function notificationId(
  category: NotificationCategory,
  medId?: string
): number {
  const base = NOTIFICATION_ID_BASE[category];
  if (category === 'test') return base;
  return base + hashToRange(medId ?? '', ID_RANGE_SIZE);
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
//   - lastSyncDate
//   - warningThresholdDays (critical threshold is derived from it)
//   - autoDeductEnabled
//   - medication id (med deleted/created)
//
// Race protection: the hook uses a per-med generation counter so an
// older async effect cannot recreate a stale alarm after a newer
// medication state or after the medication is deleted. Each effect
// run bumps the generation for the med; the .then() callback after
// cancel() checks the generation and bails if a newer run superseded
// it.
//
// Edge cases (handled by getCriticalAlarmDate, which returns null to
// signal "do not schedule"):
//   - dailyDose <= 0 → no consumption rate → no critical date.
//   - effectiveCurrentPills <= 0 OR daysLeft <= critical threshold →
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
export function criticalAlarmId(medId: string): number {
  return notificationId('criticalAlarm', medId);
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
 * dateCalculations) and passes it here. In normal operation the
 * caller only invokes this with a FUTURE timestamp (getCriticalAlarmDate
 * returns null for already-critical meds, so no immediate alarms are
 * scheduled). The past-date fallback below is defensive — it covers
 * edge cases (e.g. the device was off across the projected critical
 * date and the boot receiver re-arms the alarm with a now-stale date).
 *
 * `criticalDateMs <= Date.now()` (within a 1-minute tolerance) is
 * treated as "immediate" — we schedule the notification 1 second in
 * the future so it appears as a real system notification (Capacitor
 * treats `at: now` as "delivered immediately" which some Android
 * versions only show as a head-up that auto-dismisses).
 *
 * `unit` is included in the notification body for display.
 *
 * Boot persistence: scheduled notifications are persisted by the
 * @capacitor/local-notifications plugin and re-armed on BOOT_COMPLETED.
 * See the section-header comment above for details.
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
    criticalDateMs <= Date.now() + CRITICAL_ALARM_IMMEDIATE_TOLERANCE_MS
      ? new Date(Date.now() + NOTIFICATION_IMMEDIATE_OFFSET_MS)
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
      if (perm.display !== 'granted') {
        // #95: surface the silent no-op so the caller / devtools can see
        // the alarm was dropped due to missing permission.
        console.warn('[notifications] scheduleCriticalAlarm skipped: permission not granted');
        return;
      }
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

// ─────────────────────────────────────────────────────────────────────
// Recurring daily dose-reminder alarm (AlarmManager-backed).
//
// This is the NATIVE complement to the in-app polling in useDoseReminders.
// The polling only fires while the app is in the foreground; this native
// schedule fires the dose reminder at the medication's reminderTime EVERY
// DAY via Android's AlarmManager (or iOS's UNUserNotificationCenter), even
// when the app is killed or the device is in Doze. The user sees the
// reminder in their notification drawer without ever opening the app.
//
// The recurring notification uses a SEPARATE id band (doseAlarm = 6M)
// from the immediate dose notification (dose = 3M) so the two never
// collide. The useDoseReminderScheduler hook cancels + reschedules
// whenever a med's reminder config changes (reminderEnabled, reminderTime,
// med deleted, notifications disabled), with the same race-protection
// pattern as useCriticalAlarmScheduler (generation counter + per-med
// serialization chain).
//
// When the notification fires:
//   - App in background/killed: shown in the system notification tray
//     with the channel's default sound. (Custom sound in background is
//     problem #2, deferred — see the scheduleNotification JSDoc.)
//   - App in foreground: delivered to the localNotificationReceived
//     listener in native.ts, which plays the custom sound (if any) via
//     an Audio element. The in-app polling then opens the DoseAlarmModal.
//
// Boot persistence: scheduled notifications are persisted by the
// @capacitor/local-notifications plugin and re-armed on BOOT_COMPLETED.
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the unique notification id for a medication's recurring dose
 * alarm. Stable across calls so cancel + reschedule work.
 */
export function doseReminderAlarmId(medId: string): number {
  return notificationId('doseAlarm', medId);
}

/** Stable, separate id for a one-shot snoozed dose reminder. */
export function snoozeDoseReminderId(medId: string): number {
  return notificationId('doseSnooze', medId);
}

/**
 * Cancel any pending recurring dose-reminder alarm for this medication.
 *
 * On native: calls LocalNotifications.cancel() with the stable id.
 * On web: no-op (web has no persistent recurring alarm to cancel).
 */
export async function cancelDoseReminder(medId: string): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({
      notifications: [{ id: doseReminderAlarmId(medId) }],
    });
  } catch (err) {
    console.warn('[notifications] cancelDoseReminder failed:', err);
  }
}

/** Cancel the current and legacy one-shot snooze IDs for a medication. */
export async function cancelSnoozedDoseReminder(medId: string): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({
      notifications: [
        { id: snoozeDoseReminderId(medId) },
        { id: notificationId('dose', medId) },
      ],
    });
  } catch (err) {
    console.warn('[notifications] cancelSnoozedDoseReminder failed:', err);
  }
}

/**
 * Schedule a ONE-SHOT dose-reminder notification `minutes` in the future.
 *
 * Called by useDoseReminders.snoozeAlarm when the user hits "غفوة" on the
 * DoseAlarmModal. Uses the immediate 'dose' id band (3M) so the snoozed
 * notification replaces (not duplicates) any pending immediate dose
 * notification. When it fires (foreground or background):
 *   - Background: shown in the system tray with the channel's default
 *     sound.
 *   - Foreground: the localNotificationReceived listener calls
 *     openAlarm → re-opens the DoseAlarmModal.
 *
 * This replaces the old polling-based snooze, which only re-opened the
 * modal while the app was in the foreground. Now the snoozed reminder
 * fires via AlarmManager even if the user backgrounded the app.
 *
 * NOTE: the snoozed notification does NOT repeat — it fires once. The
 * recurring daily reminder (scheduleDoseReminder, doseAlarm band) is
 * unaffected and will still fire tomorrow at reminderTime.
 */
export async function scheduleSnoozedDoseReminder(
  medId: string,
  medName: string,
  dailyDose: number,
  unit: string,
  reminderTime: string | undefined,
  minutes: number,
): Promise<void> {
  const fireAt = new Date(Date.now() + minutes * 60_000);
  const timeHint = reminderTime ? ` (موعد الجرعة الأصلي ${reminderTime})` : '';
  const title = `⏰ تذكير مجدد: ${medName}`;
  const body = `غفوة ${minutes} دقيقة انتهت${timeHint}. جرعتك المقررة: ${dailyDose} ${unit}.`;

  if (isNativePlatform()) {
    try {
      if (await getExactAlarmPermission() !== 'granted') {
        throw new Error('Exact-alarm permission is required for snoozed dose reminders');
      }
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') {
        throw new Error('Notification permission is required for snoozed dose reminders');
      }
      await LocalNotifications.schedule({
        notifications: [
          {
            id: snoozeDoseReminderId(medId),
            title,
            body,
            schedule: {
              at: fireAt,
              allowWhileIdle: true,
            },
            smallIcon: 'ic_launcher',
            channelId: DOSE_REMINDER_CHANNEL_ID,
            actionTypeId: 'dose-reminder',
            ongoing: false,
            autoCancel: true,
            extra: {
              medicationId: medId,
            },
          },
        ],
      });
      return;
    } catch (err) {
      console.warn('[notifications] Capacitor scheduleSnoozedDoseReminder failed:', err);
      throw err;
    }
  }

  // Web fallback: fire immediately (can't wake a future time reliably).
  scheduleWebNotification(title, body);
}

/**
 * Schedule a recurring daily dose-reminder notification at the given
 * HH:MM (24-hour) time.
 *
 * Computes the next fire time (today at HH:MM if it's still in the
 * future, otherwise tomorrow at HH:MM) and schedules a RECURRING daily
 * notification via LocalNotifications. With `repeats: true` +
 * `every: 'day'`, Android's AlarmManager re-arms it automatically
 * every 24 hours at the same time — the app doesn't need to be open.
 *
 * `allowWhileIdle: true` lets the alarm fire even in Doze mode.
 *
 * The notification uses the `dose-reminder-v2` channel with the bundled
 * native sound (`dose_reminder.wav`). No JS sound playback is involved.
 */
export async function scheduleDoseReminder(
  medId: string,
  medName: string,
  reminderTime: string,
  dailyDose: number,
  unit: string,
  currentPills: number,
): Promise<void> {
  // Validate the HH:MM string and compute the next fire Date.
  const parts = reminderTime.split(':').map((n) => parseInt(n, 10));
  const [hour, minute] = parts;
  if (parts.length < 2 || Number.isNaN(hour) || Number.isNaN(minute)) return;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return;

  const now = new Date();
  const fireToday = new Date();
  fireToday.setHours(hour, minute, 0, 0);
  // If today's fire time already passed, schedule for tomorrow.
  if (fireToday.getTime() <= now.getTime()) {
    fireToday.setDate(fireToday.getDate() + 1);
  }

  const title = `⏰ حان موعد دواء: ${medName}`;
  const body = `موعد الجرعة الساعة ${reminderTime}. جرعتك المقررة: ${dailyDose} ${unit}. (المخزون الحالي: ${currentPills} ${unit}).`;

  if (isNativePlatform()) {
    try {
      if (await getExactAlarmPermission() !== 'granted') {
        throw new Error('Exact-alarm permission is required for dose reminders');
      }
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') {
        throw new Error('Notification permission is required for dose reminders');
      }
      await LocalNotifications.schedule({
        notifications: [
          {
            id: doseReminderAlarmId(medId),
            title,
            body,
            schedule: {
              at: fireToday,
              repeats: true,
              every: 'day',
              allowWhileIdle: true,
            },
            smallIcon: 'ic_launcher',
            channelId: DOSE_REMINDER_CHANNEL_ID,
            actionTypeId: 'dose-reminder',
            ongoing: false,
            autoCancel: true,
            extra: {
              medicationId: medId,
            },
          },
        ],
      });
      return;
    } catch (err) {
      console.warn('[notifications] Capacitor scheduleDoseReminder failed:', err);
      throw err;
    }
  }

  // Web fallback: no persistent recurring scheduling — fire immediately.
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

