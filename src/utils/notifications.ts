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
 * Returns 'android' when running on Android, 'ios' when on iOS, or
 * null for web/browser. Used to gate Android-only APIs like exact-alarm.
 */
function getNativePlatform(): 'android' | 'ios' | null {
  try {
    if (typeof Capacitor === 'undefined') return null;
    const platform = Capacitor.getPlatform();
    if (platform === 'android') return 'android';
    if (platform === 'ios') return 'ios';
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns true when running inside the Capacitor native runtime
 * (Android or iOS). When false, we're in a browser/AI Studio preview
 * and should use the standard Notification API.
 */
function isNativePlatform(): boolean {
  return getNativePlatform() !== null;
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
export async function getExactAlarmPermission(): Promise<
  'granted' | 'denied' | 'unsupported'
> {
  const platform = getNativePlatform();
  // Web and iOS: exact-alarm is always 'granted' — the concept doesn't apply.
  // Android's SCHEDULE_EXACT_ALARM has no iOS equivalent; iOS schedules
  // notifications via UNUserNotificationCenter which handles timing natively.
  if (platform !== 'android') return 'granted';
  // Android: check the exact-alarm permission via the plugin.
  try {
    const status = await LocalNotifications.checkExactNotificationSetting();
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
 * This is an Android-only API. On iOS and web it returns false without
 * attempting any native call.
 *
 * On Android < 12 the plugin returns 'granted' immediately (no settings
 * screen needed). On Android 12+ it opens the system settings page for
 * the app; the user grants/denies, then returns to the app. The caller
 * must re-check permission via getExactAlarmPermission() after the app
 * resumes (see the appState listener in App.tsx).
 *
 * Returns true if the settings screen was opened, false if not
 * available (web / iOS / error).
 */
export async function openExactAlarmSettings(): Promise<boolean> {
  const platform = getNativePlatform();
  // Exact-alarm settings are Android-only.
  if (platform !== 'android') return false;
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
): Promise<boolean> {
  // Title reflects the actual situation: out of stock, or critical
  // with N days left (the critical threshold IS the user-configured
  // warningThresholdDays — see getCriticalThresholdDays).
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

  // Returns whether the notification was actually handed to the
  // platform. Callers (the foreground stock-alert fallback) must only
  // record "sent" state after a successful send.
  return scheduleNotification({
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
 * @param reminderTime HH:MM string (24-hour) for the scheduled time
 */
export async function sendMedicationDoseReminder(
  medId: string,
  medicineName: string,
  dailyDose: number,
  unit: string = 'قرص',
  reminderTime?: string,
): Promise<void> {
  const timeHint = reminderTime ? ` الساعة ${reminderTime}` : '';
  const title = `⏰ حان موعد دواء: ${medicineName}`;
  const body = `موعد الجرعة${timeHint}. جرعتك المقررة: ${dailyDose} ${unit}.`;

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
}): Promise<boolean> {
  if (isNativePlatform()) {
    try {
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') {
        console.warn('[notifications] scheduleNotification skipped: permission not granted');
        return false;
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
      return scheduleWebNotification(opts.title, opts.body);
    }
    return true;
  }

  return scheduleWebNotification(opts.title, opts.body);
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
 *
 * Used both by the scheduler's reschedule chains and by its
 * reconciliation: a claim that says "armed" is only bookkeeping — when
 * verification cannot confirm the native alarm, this is called first so
 * the repair never doubles up an alarm under the same stable id.
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
 * True when a pending-notification `schedule.at` value refers to the
 * alarm time `alarmTimeMs`.
 *
 * Runtime shapes differ by platform (the TypeScript types say `Date`,
 * but the plugin serializes): Android returns the epoch-milliseconds
 * number it was given; iOS returns an ISO-8601 STRING whose default
 * formatter drops sub-second precision. Numbers must match exactly;
 * strings are parsed and allowed ≤2s of serialization drift. This is
 * round-trip tolerance only — never delivery inference.
 */
function pendingAtMatchesAlarmTime(at: unknown, alarmTimeMs: number): boolean {
  if (typeof at === 'number') return at === alarmTimeMs;
  if (typeof at === 'string') {
    const parsed = new Date(at).getTime();
    return !Number.isNaN(parsed) && Math.abs(parsed - alarmTimeMs) <= 2000;
  }
  return false;
}

/**
 * Verify that this medication's critical alarm is ACTUALLY pending on
 * the platform right now, at exactly `alarmTimeMs`.
 *
 * Why this exists: the persistent claim records that a schedule SUCCEEDED
 * at some point — it is business dedup state, NOT proof that the native
 * alarm still exists. Android may drop previously-scheduled alarms
 * (SCHEDULE_EXACT_ALARM revoked, force-stop, OEM task killers, the
 * scheduled notification otherwise removed), and the claim would stay
 * armed while nothing ever fires — silently suppressing the episode's
 * notification.
 *
 * What is verified, using the installed @capacitor/local-notifications
 * v6 API only:
 *   1. `checkPermissions()` — display permission still granted. Without
 *      it a pending alarm fires but is never shown.
 *   2. On Android: `checkExactNotificationSetting()` is not 'denied'.
 *      When it flips to denied the OS cancels the app's exact alarms;
 *      the plugin's pending list may still list them, so that state
 *      must never count as "armed".
 *   3. `getPending()` contains this medication's stable critical-alarm
 *      id with schedule.at === alarmTimeMs (see
 *      pendingAtMatchesAlarmTime for platform shapes).
 *
 * PLATFORM LIMITATION (documented honestly, not hidden): on Android
 * `getPending()` reads the plugin's persisted schedule record
 * (SharedPreferences), not live AlarmManager state — no public API can
 * query AlarmManager. The record faithfully follows our own
 * cancel/schedule calls and is removed when an alarm fires, but it
 * cannot see OS-level alarm cancellation that happened while the app
 * was not running (force-stop, some OEM task killers, a
 * SCHEDULE_EXACT_ALARM revocation plus re-grant between our checks).
 * Only the observable permission/exact-setting states above catch
 * those. This is the strongest signal the platform offers; a claim is
 * therefore never treated as proof of native existence — verification
 * failures simply fall through to a cancel + re-schedule repair whose
 * success re-establishes the evidence.
 *
 * Returns true  → treat the armed claim as verified: keep it, no
 *                 re-arm, no duplicate.
 * Returns false → NOT verifiably armed; the caller should repair by
 *                 re-arming (cancel + schedule). Bridge errors count as
 *                 false: an unverifiable alarm must not be trusted, and
 *                 re-arming is idempotent (same stable id, no
 *                 user-facing notification).
 *
 * On web there is no persistent native alarm to verify at all (the
 * plugin's pending list is empty for web-scheduled notifications by
 * design), so this returns false — the repair attempt will then fail on
 * web too and leave the foreground fallback available, which IS the web
 * delivery path.
 */
export async function verifyCriticalAlarmPending(
  medId: string,
  alarmTimeMs: number
): Promise<boolean> {
  if (!isNativePlatform()) return false;
  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') return false;
    if (getNativePlatform() === 'android') {
      try {
        const exact = await LocalNotifications.checkExactNotificationSetting();
        if (exact.exact_alarm === 'denied') return false;
      } catch (err) {
        console.warn(
          '[notifications] verifyCriticalAlarmPending: exact-alarm check failed:',
          err
        );
        return false;
      }
    }
    const pending = await LocalNotifications.getPending();
    const id = criticalAlarmId(medId);
    return pending.notifications.some(
      (n) =>
        n.id === id &&
        pendingAtMatchesAlarmTime((n.schedule as { at?: unknown } | undefined)?.at, alarmTimeMs)
    );
  } catch (err) {
    console.warn('[notifications] verifyCriticalAlarmPending failed:', err);
    return false;
  }
}

/**
 * Schedule a one-shot critical-stock alarm at the given absolute time.
 *
 * This is the single entry point for critical-date scheduling. The
 * caller (useCriticalAlarmScheduler) computes `criticalDateMs` via
 * getCriticalAlarmDate and only ever invokes this with a FUTURE
 * timestamp (getCriticalAlarmDate returns null for already-critical and
 * frozen meds, so no immediate alarms are scheduled). The alarm time is
 * used exactly as given — no past-date rewriting — so the persisted
 * claim's alarmTime always matches the actually-armed alarm.
 *
 * Returns true ONLY when the native scheduled critical notification was
 * actually accepted by LocalNotifications: the native `schedule()` call
 * resolved AND its ScheduleResult actually lists this medication's
 * notification id. Callers must persist claimed=true only after a `true`
 * result. A `false` result — permission failure, bridge failure, native
 * schedule failure, a resolve that does not list our id, or the web
 * fallback path (which has no persistent scheduling) — leaves the
 * notification opportunity open so the foreground fallback can still
 * send one notification. A successful browser/web notification NEVER
 * counts as native future-alarm scheduling success.
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
): Promise<boolean> {
  const fireAt = new Date(criticalDateMs);

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
        return false;
      }
      const result = await LocalNotifications.schedule({
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
            extra: {
              medicationId: medId,
            },
          },
        ],
      });
      // True ONLY when the plugin actually registered the alarm: the
      // resolved ScheduleResult lists the ids that were really
      // scheduled. A resolve that omits our stable id (or an empty
      // list) is not a native future alarm and must be reported as a
      // failure — the scheduler then leaves the claim open instead of
      // persisting an armed claim with no alarm behind it.
      return result.notifications.some((n) => n.id === criticalAlarmId(medId));
    } catch (err) {
      console.warn('[notifications] Capacitor scheduleCriticalAlarm failed:', err);
      // Native failure (permission, bridge, or schedule rejection) →
      // false. The web fallback is deliberately NOT consulted here: a
      // browser notification is not a native future critical alarm, and
      // letting a web-fallback success masquerade as one would persist
      // an armed claim with no alarm behind it and suppress the
      // foreground fallback for the episode.
      return false;
    }
  }

  // Web fallback: no persistent scheduling available — fire the
  // notification immediately (since we can't reliably wake the page
  // up at a future time). The user will at least see an immediate
  // alert if they happen to have the tab open. This is a known
  // limitation; the headline use case is the Android native path.
  scheduleWebNotification(title, body);
  return false;
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
//     with the channel's bundled native sound.
//   - App in foreground: the localNotificationReceived listener in
//     native.ts opens the DoseAlarmModal. No JS sound — the native
//     channel sound is the sole sound.
//
// Boot persistence: scheduled notifications are persisted by the
// @capacitor/local-notifications plugin and re-armed on BOOT_COMPLETED.
// ─────────────────────────────────────────────────────────────────────

/**
 * Sentinel dose id used for legacy medications that only have
 * `reminderTime` (no `doseSchedule`). Maps to the historical
 * med-only notification id so existing single-dose alarms keep working.
 */
export const LEGACY_DOSE_ID = 'legacy';

/**
 * Compute the unique notification id for a medication's recurring dose
 * alarm. Stable across calls so cancel + reschedule work.
 *
 * Single-argument form preserves the Phase-0/1 id for legacy meds.
 */
export function doseReminderAlarmId(medId: string): number {
  return notificationId('doseAlarm', medId);
}

/**
 * Recurring dose-alarm id for a specific dose row.
 *
 * Identity = medicationId + doseId so each daily dose slot is independently
 * schedulable/cancellable. The legacy sentinel (`LEGACY_DOSE_ID`) maps to
 * the historical med-only id so pre-Phase-2 single-dose alarms remain valid.
 *
 * Band: doseAlarm (6_000_000 + hash(...) % 1_000_000).
 */
export function doseReminderAlarmIdForDose(medId: string, doseId: string): number {
  if (!doseId || doseId === LEGACY_DOSE_ID) {
    return doseReminderAlarmId(medId);
  }
  // Composite key stays inside the same doseAlarm band; distinct from the
  // med-only hash for all practical med/dose id pairs.
  return notificationId('doseAlarm', `${medId}::${doseId}`);
}

/** Stable, separate id for a one-shot snoozed dose reminder. */
export function snoozeDoseReminderId(medId: string, doseId?: string): number {
  if (!doseId || doseId === LEGACY_DOSE_ID) {
    return notificationId('doseSnooze', medId);
  }
  return notificationId('doseSnooze', `${medId}::${doseId}`);
}

/**
 * Cancel any pending recurring dose-reminder alarm for this medication
 * (and optionally a specific dose row).
 *
 * - `cancelDoseReminder(medId)` — legacy / med-only id (Phase 0/1).
 * - `cancelDoseReminder(medId, doseId)` — that dose's id only.
 *
 * On web: no-op (web has no persistent recurring alarm to cancel).
 */
export async function cancelDoseReminder(medId: string, doseId?: string): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const id =
      doseId !== undefined
        ? doseReminderAlarmIdForDose(medId, doseId)
        : doseReminderAlarmId(medId);
    await LocalNotifications.cancel({
      notifications: [{ id }],
    });
  } catch (err) {
    console.warn('[notifications] cancelDoseReminder failed:', err);
  }
}

/**
 * Cancel pending one-shot snooze notification(s) for a medication.
 *
 * - cancelSnoozedDoseReminder(medId) — legacy med-only + historical dose id.
 * - cancelSnoozedDoseReminder(medId, doseId) — that dose's snooze id only
 *   (plus the legacy med-only id when doseId is LEGACY_DOSE_ID / omitted).
 */
export async function cancelSnoozedDoseReminder(
  medId: string,
  doseId?: string
): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const ids: { id: number }[] = [
      { id: snoozeDoseReminderId(medId, doseId) },
    ];
    // Always also clear the historical med-only / immediate-dose ids so a
    // pre-Phase-3B snooze cannot linger after a per-dose cancel.
    if (!doseId || doseId === LEGACY_DOSE_ID) {
      ids.push({ id: snoozeDoseReminderId(medId) });
      ids.push({ id: notificationId('dose', medId) });
    }
    await LocalNotifications.cancel({ notifications: ids });
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
  dailyDose: number,
  unit: string,
  reminderTime: string | undefined,
  minutes: number,
  doseId?: string
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
            id: snoozeDoseReminderId(medId, doseId),
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
              ...(doseId && doseId !== LEGACY_DOSE_ID ? { doseId } : {}),
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
 * Optional behavior flags for {@link scheduleDoseReminder}.
 */
export interface ScheduleDoseReminderOptions {
  /**
   * Start the recurring schedule from TOMORROW even when today's HH:MM
   * is still in the future.
   *
   * Used when today's dose has already been consumed (manual card action
   * or the notification's take-dose action — both set
   * `lastConsumedDate = today`): the pending recurring alarm is
   * cancelled and re-armed from tomorrow, so the already-taken dose can
   * never produce today's reminder. Tomorrow — and every later day —
   * the reminder fires normally at reminderTime.
   *
   * Phase 2 note: consumption is still medication-level (`lastConsumedDate`),
   * not per-dose. skipToday therefore suppresses TODAY for this scheduled
   * dose slot when the med was marked consumed. Per-dose consumption is
   * Phase 3.
   */
  skipToday?: boolean;
  /**
   * Specific dose-row id from `Medication.doseSchedule`. When omitted or
   * set to {@link LEGACY_DOSE_ID}, the historical med-only notification
   * id is used (single-dose / legacy path).
   */
  doseId?: string;
}

/**
 * Whether today's occurrence of the given HH:MM reminder time is still
 * in the future. Uses the SAME boundary as {@link scheduleDoseReminder}
 * (HH:MM:00.000 strictly after `now`), so "still ahead" means exactly
 * "the pending recurring alarm would still fire today".
 *
 * Used by useDoseReminderScheduler to decide whether a consumed dose
 * needs today's recurring alarm suppressed:
 *   - still ahead  → cancel the pending alarm + re-arm from tomorrow.
 *   - already past → the alarm fired (or was suppressed); a fired
 *     notification is never retracted, and the plugin re-armed the
 *     recurring alarm for tomorrow by itself.
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
 * Schedule a recurring daily dose-reminder notification at the given
 * HH:MM (24-hour) time.
 *
 * Computes the next fire time (today at HH:MM if it's still in the
 * future, otherwise tomorrow at HH:MM) and schedules a RECURRING daily
 * notification via LocalNotifications. With `repeats: true` +
 * `every: 'day'`, Android's AlarmManager re-arms it automatically
 * every 24 hours at the same time — the app doesn't need to be open.
 *
 * `options.skipToday` forces the first occurrence to TOMORROW even when
 * today's HH:MM is still ahead — used when today's dose was already
 * consumed, so the re-armed recurring alarm can never fire for the
 * already-taken dose today.
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
  options?: ScheduleDoseReminderOptions,
): Promise<void> {
  // Validate the HH:MM string and compute the next fire Date.
  const parts = reminderTime.split(':').map((n) => parseInt(n, 10));
  const [hour, minute] = parts;
  if (parts.length < 2 || Number.isNaN(hour) || Number.isNaN(minute)) return;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return;

  const now = new Date();
  const fireToday = new Date();
  fireToday.setHours(hour, minute, 0, 0);
  // Move to tomorrow when today's fire time already passed, or when the
  // caller asked to skip today (today's dose was already consumed).
  // Exactly ONE increment in either case — never two.
  if (fireToday.getTime() <= now.getTime() || options?.skipToday === true) {
    fireToday.setDate(fireToday.getDate() + 1);
  }

  const title = `⏰ حان موعد دواء: ${medName}`;
  const body = `موعد الجرعة الساعة ${reminderTime}. جرعتك المقررة: ${dailyDose} ${unit}.`;
  const doseId = options?.doseId;
  const notifId = doseReminderAlarmIdForDose(medId, doseId ?? LEGACY_DOSE_ID);

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
            id: notifId,
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
              // Phase 2 metadata for future Phase 3 per-dose handling.
              // take_dose still consumes at medication level (unchanged).
              ...(doseId ? { doseId } : {}),
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
  // With skipToday there is nothing to remind about today (the dose was
  // already consumed), so the immediate fallback is skipped entirely —
  // a consumed dose must not produce today's web reminder either.
  if (options?.skipToday === true) return;
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

