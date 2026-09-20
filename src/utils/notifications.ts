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
  formatReminderTime12h,
} from './time';
import { postNativeNotification } from './notificationRuntime';

import {
  scheduleCriticalAlarmNative,
  cancelCriticalAlarmNative,
  verifyCriticalAlarmPendingNative,
  listScheduledCriticalMedicationIdsNative,
} from './criticalAlarmNative';
import {
  scheduleDoseReminderNative,
  cancelDoseReminderNative,
  scheduleDoseSnoozeNative,
  cancelDoseSnoozeNative,
  isDoseReminderScheduledNative,
  listDoseReminderScheduledKeysNative,
  cancelStaleDoseReminderAlarmsNative,
} from './doseReminderNative';

/**
 * Native bridge for temporary dose-reminder delivery/re-arm evidence
 * (TimedNotificationPublisher → DoseReminderRecurrenceStore).
 * Validity requires current desired reminderTime so stale config cannot
 * block repair. Web / missing plugin: query helpers no-op as invalid.
 */
interface DoseReminderNativePlugin {
  getNextOccurrence(options: {
    medicationId: string;
    doseId?: string;
    /** Current desired HH:MM — required for valid===true. */
    reminderTime?: string;
  }): Promise<{ valid: boolean; nextOccurrenceMs: number }>;
  clearReArm(options: {
    medicationId: string;
    doseId?: string;
  }): Promise<{ ok: boolean }>;
}

const DoseReminderNative = registerPlugin<DoseReminderNativePlugin>('DoseReminder');

/**
 * The BACKGROUND/KILLED dose-reminder notification channel.
 * Versioned because Android channel sound settings are immutable —
 * bumping the suffix is the only way to change the sound.
 *
 * v3: uses the default system notification sound (no custom sound).
 * v2: used a custom 'dose_reminder.wav' (removed — users found it
 *      unpleasant).
 *
 * The channel is created in native.ts with:
 *   - no custom sound → Android default system notification sound
 *   - importance: HIGH (heads-up + sound)
 *   - visibility: PUBLIC (lock screen)
 *
 * This channel is used when the app is in the BACKGROUND or KILLED.
 * When the app is in the FOREGROUND, {@link DOSE_REMINDER_FOREGROUND_CHANNEL_ID}
 * is used instead (silent — no Android sound) so only the in-app
 * DoseAlarmModal + chime are produced.
 */
export const DOSE_REMINDER_CHANNEL_ID = 'dose-reminder-v3';

/**
 * The FOREGROUND dose-reminder notification channel — SILENT.
 *
 * Used when the app is in the foreground so the scheduled notification
 * triggers the `localNotificationReceived` event (which opens the
 * DoseAlarmModal + plays the in-app chime) WITHOUT producing an audible
 * Android notification sound.
 *
 * Created in native.ts with:
 *   - no `sound` property → no sound
 *   - importance: LOW (no sound, no heads-up, appears in shade only)
 *   - visibility: PUBLIC (lock screen)
 *
 * Versioned (v1) so the sound config can be changed if ever needed
 * (Android channel sound is immutable after creation).
 */
export const DOSE_REMINDER_FOREGROUND_CHANNEL_ID = 'dose-reminder-foreground-v1';

// ─────────────────────────────────────────────────────────────
// App foreground/background state tracker.
//
// Updated by native.ts on appStateChange. Controls which channel dose
// reminders are scheduled on:
//   foreground → DOSE_REMINDER_FOREGROUND_CHANNEL_ID (silent)
//   background → DOSE_REMINDER_CHANNEL_ID (system default sound)
//
// The scheduler (useDoseReminderScheduler) re-arms all pending dose
// reminders via idempotent reconciliation (lifecycleTick), so the
// channel matches the current app state for the common case.
//
// IMPORTANT — schedule-time channel is not a hard guarantee under
// process death: if the app is killed after setAppInForeground(false)
// but before cancel+reschedule completes, a silent foreground-channel
// notification could still be pending. The authority for killed-process
// correctness is the repository-owned TimedNotificationPublisher +
// AppForegroundState in native-android/ (installed by prepare-android.mjs).
// Delivery uses process-local MainActivity onResume/onPause state; a fresh
// process defaults to false → dose-reminder-v3. JS reconciliation remains
// the fast path for live transitions.
// ─────────────────────────────────────────────────────────────
let appInForeground = true;

/**
 * Set the current app foreground/background state. Called by native.ts
 * on appStateChange, BEFORE the scheduler re-arms reminders, so
 * {@link getDoseReminderChannelId} returns the correct channel.
 */
export function setAppInForeground(value: boolean): void {
  appInForeground = value;
}

/**
 * Returns true if the app is currently in the foreground.
 */
export function isAppInForeground(): boolean {
  return appInForeground;
}

/**
 * The channel ID to use for dose reminders based on the current app state.
 * - Foreground: silent channel (no Android sound; in-app chime handles audio)
 * - Background/Killed: system-default-sound channel (dose-reminder-v3)
 */
export function getDoseReminderChannelId(): string {
  return appInForeground
    ? DOSE_REMINDER_FOREGROUND_CHANNEL_ID
    : DOSE_REMINDER_CHANNEL_ID;
}

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
export { getExactAlarmPermission, openExactAlarmSettings } from './exactAlarm';

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
  const daysWord =
    daysLeft === 1
      ? 'يوم واحد'
      : daysLeft === 2
      ? 'يومين'
      : daysLeft <= 10
      ? `${daysLeft} أيام`
      : `${daysLeft} يوماً`;

  const title =
    currentPills <= 0
      ? `🚨 ${medicineName}: نفد المخزون!`
      : `🚨 ${medicineName}: حرج — باقي ${daysWord}!`;

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
    // Android presentation is owned by the repository Notification Runtime.
    // The numeric id remains only for the legacy iOS Local Notifications path;
    // Android identity is namespace + logical notification identity.
    if (getNativePlatform() === 'android') {
      const native = await postNativeNotification({
        namespace: 'app-notification',
        identity: String(opts.id),
        title: opts.title,
        body: opts.body,
        channelId: opts.channelId,
        channelName: opts.channelId,
        channelImportance: opts.channelId === DOSE_REMINDER_FOREGROUND_CHANNEL_ID ? 2 : 4,
        channelVisibility: 1,
        smallIcon: opts.smallIcon,
      });
      return native;
    }

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
            schedule: {
              at: new Date(Date.now() + NOTIFICATION_IMMEDIATE_OFFSET_MS),
            },
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
      return true;
    } catch (err) {
      console.warn('[notifications] Capacitor schedule failed:', err);
      return scheduleWebNotification(opts.title, opts.body);
    }
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
    channelId: getDoseReminderChannelId(),
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
// Architecture (Capacitor local-notifications 6.1.3 Android):
// - JS schedules a ONE-SHOT exact alarm at the next due `at` time
//   (stable id = medicationId + doseId). Does NOT use repeats:true
//   (that path calls AlarmManager.setRepeating with interval=at-now).
// - TimedNotificationPublisher is the sole recurrence owner: on delivery
//   it arms exactly one next-day alarm at extra.reminderTime.
// - useDoseReminderScheduler performs idempotent reconciliation against
//   LocalNotifications.getPending() — lifecycle must not cancel+reschedule
//   when the stable id is already pending.
//
// Id band doseAlarm (6M) is separate from immediate dose (3M).

// Sentinel lives in a leaf module so pure-logic modules (dateCalculations)
// can reference it without importing the notification stack.
// Re-exported here for convenient access from existing importers.

/**
 * Recurring dose-alarm id for an explicit doseSchedule row (Issue #268).
 * Identity = medicationId + doseId. Requires non-empty doseId.
 * Returns null when doseId is missing — callers must not schedule/cancel.
 *
 * Band: doseAlarm (6_000_000 + hash(...) % 1_000_000).
 */
export function doseReminderAlarmIdForDose(
  medId: string,
  doseId: string
): number | null {
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) return null;
  return notificationId('doseAlarm', `${medId}::${id}`);
}

/**
 * True when Capacitor `LocalNotifications.getPending()` reports a *future*
 * occurrence for this stable dose-alarm id.
 *
 * Layer contract (post-delivery):
 * - AlarmManager: wall-clock arm (not directly queryable here)
 * - NotificationStorage / getPending(): plugin-visible future `schedule.at`
 * - DoseReminderRecurrenceStore: temporary delivery evidence; valid only when
 *   storage still holds a matching future occurrence for the same notification id
 *
 * Reconciliation checks getPending first, then native re-arm evidence so a
 * brief getPending lag during delivery does not force a duplicate schedule.
 * Recurrence owner remains TimedNotificationPublisher (next calendar day).
 * JS must not use Capacitor repeats/every.
 */
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
 * True when native TimedNotificationPublisher has persisted temporary
 * delivery/re-arm evidence for this medicationId + doseId that still
 * matches the current desired reminderTime and a future next occurrence.
 * Independent of getPending() / React memory. Stale config, expired, or
 * absent → false so JS can repair. Does not prove AlarmManager still holds
 * the alarm.
 *
 * @param reminderTime current desired HH:MM for this dose slot (required)
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
 * Clear native re-arm evidence for a dose slot (cancel / signature change).
 * Idempotent. Web no-op.
 */
export async function clearNativeDoseReminderReArm(
  _medId: string,
  _doseId: string
): Promise<void> {
  // No separate delivery-evidence store remains. ExactAlarmRuntime's durable
  // schedule row is the only scheduling source of truth.
}

function isDoseAlarmBandId(_id: number): boolean {
  return false;
}

/**
 * Pending notification ids in the doseAlarm band (persisted native truth).
 */
export async function listPendingDoseReminderAlarmIds(): Promise<number[]> {
  // Deprecated compatibility helper. Alarm identity is now logical
  // medId + doseId inside ExactAlarmRuntime; no feature numeric-id band exists.
  return [];
}

/**
 * Cancel pending doseAlarm-band notifications not in keepIds (stale after
 * process death / dose removal). Does not touch other bands.
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
export function snoozeDoseReminderId(medId: string, doseId: string): number | null {
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) return null;
  return notificationId('doseSnooze', `${medId}::${id}`);
}


/**
 * Cancel a pending recurring dose-reminder alarm for an explicit dose row.
 * Requires non-empty doseId (Issue #268).
 */
export async function cancelDoseReminder(medId: string, doseId: string): Promise<void> {
  if (!isNativePlatform()) return;
  const notifId = doseReminderAlarmIdForDose(medId, doseId);
  if (notifId == null) return;
  try {
    await LocalNotifications.cancel({
      notifications: [{ id: notifId }],
    });
    await clearNativeDoseReminderReArm(medId, doseId);
  } catch (err) {
    console.warn('[notifications] cancelDoseReminder failed:', err);
  }
}

/**
 * Cancel pending one-shot snooze for an explicit dose row (Issue #268).
 */
export async function cancelSnoozedDoseReminder(
  medId: string,
  doseId: string
): Promise<void> {
  if (!isNativePlatform()) return;
  const id = snoozeDoseReminderId(medId, doseId);
  if (id == null) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id }] });
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
  doseAmount: number,
  unit: string,
  reminderTime: string | undefined,
  minutes: number,
  doseId: string,
  autoDeductEnabled?: boolean,
): Promise<void> {
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) return;
  const notifId = snoozeDoseReminderId(medId, id);
  if (notifId == null) return;

  const fireAt = new Date(Date.now() + minutes * 60_000);
  const timeHint = reminderTime
    ? ` (موعد الجرعة الأصلي ${formatReminderTime12h(reminderTime)})`
    : '';
  const title = `⏰ تذكير مجدد: ${medName}`;
  const body = `غفوة ${minutes} دقيقة انتهت${timeHint}. جرعتك المقررة: ${doseAmount} ${unit}.`;

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
            id: notifId,
            title,
            body,
            schedule: {
              at: fireAt,
              allowWhileIdle: true,
            },
            smallIcon: 'ic_launcher',
            channelId: getDoseReminderChannelId(),
            actionTypeId: autoDeductEnabled ? undefined : 'dose-reminder',
            ongoing: false,
            autoCancel: true,
            extra: {
              medicationId: medId,
              doseId: id,
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
 *   - already past → do not retract a delivered notification; native
 *     TimedNotificationPublisher may already have armed tomorrow.
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
 * Recurrence: NOT via Capacitor repeats/every (those use setRepeating
 * with a wrong interval for daily wall-clock times). Native
 * TimedNotificationPublisher arms the next day from extra.reminderTime.
 *
 * `allowWhileIdle: true` lets the alarm fire in Doze mode.
 * Channel: dose-reminder-v3 / foreground silent variant at delivery.
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

  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) return;
  if (!(Number(doseAmount) > 0)) return;
  const notifId = doseReminderAlarmIdForDose(medId, id);
  if (notifId == null) return;

  const title = `⏰ حان موعد دواء: ${medName}`;
  // Display 12h for the user; reminderTime stays 24h for schedule + extra.
  const body = `موعد الجرعة الساعة ${formatReminderTime12h(reminderTime)}. جرعتك المقررة: ${doseAmount} ${unit}.`;

  if (isNativePlatform()) {
    try {
      if (await getExactAlarmPermission() !== 'granted') {
        throw new Error('Exact-alarm permission is required for dose reminders');
      }
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') {
        throw new Error('Notification permission is required for dose reminders');
      }
      // Dose path: initial ONE-SHOT LocalNotifications.schedule (`at`, no
      // repeats). Capacitor at+repeats:true uses setRepeating with a wrong
      // interval for daily wall-clock times — not used. Sole recurrence owner:
      // TimedNotificationPublisher.rescheduleDoseReminderNextDay (next calendar
      // day) + DoseReminderRecurrenceStore evidence. Same stable id means
      // concurrent JS schedule replaces rather than duplicates.
      await LocalNotifications.schedule({
        notifications: [
          {
            id: notifId,
            title,
            body,
            schedule: {
              at: fireToday,
              allowWhileIdle: true,
            },
            smallIcon: 'ic_launcher',
            channelId: getDoseReminderChannelId(),
            actionTypeId: options?.autoDeductEnabled ? undefined : 'dose-reminder',
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

