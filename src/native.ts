/**
 * Capacitor native bridge initialization.
 *
 * Safe to import in any environment: if the Capacitor runtime is not
 * installed (e.g., running as a plain web app in a browser, or in
 * AI Studio's preview before the user runs `npm install`), the
 * Capacitor.getPlatform() call gracefully returns 'web' and the
 * native plugins simply no-op.
 *
 * This file is imported by App.tsx on mount to:
 *   - Set the Android status bar color to match the teal theme.
 *   - Set the status bar style to LIGHT so the icons are visible
 *     on the dark teal background.
 *   - Listen for the Android hardware back button and close the
 *     top modal if one is open, or exit the app if none (#21).
 *   - Create the Android notification channel(s) used by
 *     @capacitor/local-notifications so notifications actually fire
 *     when the app is in the foreground (otherwise Android silently
 *     drops them if no channel is configured).
 */

import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { App } from '@capacitor/app';
import { LocalNotifications, type Channel, type Importance, type Visibility } from '@capacitor/local-notifications';
import { DOSE_REMINDER_CHANNEL_ID } from './utils/notifications';

let initialized = false;

// #21: a callback registered by App.tsx that returns true if it
// closed a modal (so the back button doesn't exit the app), or false
// if no modal was open (so the back button exits). Stored at module
// scope so the backButton listener (added in initNativeBridge) can
// call it.
let backPressHandler: (() => boolean) | null = null;

/**
 * #21: register a handler that closes the top modal on back-button
 * press. Returns true if a modal was closed (app stays open); false
 * if no modal was open (app exits). App.tsx calls this during mount
 * with a handler that checks all 4 modal states.
 */
export function registerBackButtonHandler(handler: (() => boolean) | null) {
  backPressHandler = handler;
}

// #38: store Capacitor listener handles so they can be removed if
// needed (e.g. on HMR of native.ts, duplicate listeners would
// otherwise accumulate and each would play the custom sound).
let backPressHandle: { remove: () => Promise<void> } | null = null;
let notificationHandle: { remove: () => Promise<void> } | null = null;
let notificationActionHandle: { remove: () => Promise<void> } | null = null;
let notificationActionHandler: ((actionId: string, medicationId: string) => void) | null = null;
// Dose-reminder "received" handler — called when a local notification
// fires while the app is in the foreground. App.tsx registers a handler
// that opens the DoseAlarmModal for the med whose reminder fired.
let doseReceivedHandler: ((medicationId: string) => void) | null = null;

export function registerNotificationActionHandler(
  handler: ((actionId: string, medicationId: string) => void) | null
) {
  notificationActionHandler = handler;
}

/**
 * Register the handler called when a dose-reminder notification fires
 * while the app is in the foreground. The handler receives the
 * medicationId (from the notification's `extra.medicationId` field) and
 * is responsible for opening the DoseAlarmModal + playing the per-med
 * chime (via useDoseReminders.openAlarm).
 *
 * Pass null to unregister (e.g. on App unmount / HMR).
 */
export function registerDoseReceivedHandler(
  handler: ((medicationId: string) => void) | null
) {
  doseReceivedHandler = handler;
}

// App-resume handler — called when the app returns to the foreground
// (active state). App.tsx registers a handler that re-checks the
// exact-alarm permission, since the user may have just granted/denied
// it in the Android settings screen (opened via openExactAlarmSettings).
let appStateHandle: { remove: () => Promise<void> } | null = null;
let appResumeHandler: (() => void) | null = null;

export function registerAppResumeHandler(handler: (() => void) | null) {
  appResumeHandler = handler;
}

export async function initNativeBridge(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const platform = Capacitor.getPlatform();
  if (platform === 'web') {
    // Running in a browser or AI Studio preview — no native bridge.
    return;
  }

  try {
    await StatusBar.setBackgroundColor({ color: '#0f766e' });
    await StatusBar.setStyle({ style: Style.Light });
  } catch (err) {
    console.warn('[native] StatusBar setup failed:', err);
  }

  // #21 + #38: await the addListener and store the handle. The back
  // button now checks `backPressHandler` first — if it returns true
  // (a modal was open and got closed), the app stays; otherwise
  // `App.exitApp()` is called.
  try {
    backPressHandle = await App.addListener('backButton', () => {
      if (backPressHandler && backPressHandler()) {
        // A modal was open and the handler closed it — don't exit.
        return;
      }
      // No modal open — exit the app (the SPA uses bottom-nav for
      // navigation, not a stack-based browser history).
      App.exitApp();
    });
  } catch (err) {
    console.warn('[native] backButton listener failed:', err);
  }

  // ─────────────────────────────────────────────────────────────
  // App state (resume) listener — re-checks exact-alarm permission
  // when the app returns to the foreground. The user may have just
  // granted/denied SCHEDULE_EXACT_ALARM in the Android settings screen
  // (opened via openExactAlarmSettings). Capacitor's appStateChange
  // fires with isActive=true when the app becomes active again.
  // ─────────────────────────────────────────────────────────────
  try {
    appStateHandle = await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive && appResumeHandler) {
        try {
          appResumeHandler();
        } catch (err) {
          console.warn('[native] appResumeHandler failed:', err);
        }
      }
    });
  } catch (err) {
    console.warn('[native] appStateChange listener failed:', err);
  }

  // ─────────────────────────────────────────────────────────────
  // Create notification channels (Android 8.0+ requirement)
  // ─────────────────────────────────────────────────────────────
  // Without an Android NotificationChannel, scheduled notifications
  // silently fail on Android 8.0+. Capacitor LocalNotifications
  // creates a default channel automatically, but the notification
  // channel id used in `schedule({ channelId: 'dose-reminder-v2' })`
  // must be created first or Android will fall back to the default
  // channel (which is acceptable but means we lose the ability to
  // later customize per-channel importance / sound / vibration).
  //
  // We also need to create a separate channel for the "low-stock"
  // alerts so the user can mute them independently from the dose
  // reminders.
  //
  // On iOS this is a no-op (iOS doesn't have channels — it uses the
  // notification's category identifier for grouping instead).
  //
  // #37: the Capacitor 6.x TypeScript definitions DO include
  // `createChannel` and `listChannels` (with proper `Channel`,
  // `Importance`, and `Visibility` types), so no cast is needed.
  try {
    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: 'dose-reminder',
          actions: [
            {
              id: 'take_dose',
              title: 'تم أخذ الجرعة',
              foreground: true,
            },
          ],
        },
      ],
    });

    const existing = await LocalNotifications.listChannels();
    const existingIds = new Set(
      (existing?.channels || []).map((c) => c.id)
    );

    // Importance: 4 = HIGH (makes a sound + shows as heads-up
    // notification briefly). Visibility: 1 = PUBLIC (shows on
    // the lock screen).
    const channels: Channel[] = [
      {
        id: DOSE_REMINDER_CHANNEL_ID,
        name: 'تذكير الجرعات',
        description: 'تذكيرات يومية بمواعيد الأدوية',
        sound: 'dose_reminder.wav',
        importance: 4 as Importance,
        visibility: 1 as Visibility,
      },
      {
        id: 'low-stock',
        name: 'تنبيهات النفاذ',
        description: 'تنبيه عند اقتراب نفاذ دواء من المخزون',
        importance: 4 as Importance,
        visibility: 1 as Visibility,
      },
    ];

    // Android channel sound is immutable. Replace the old silent channel
    // once instead of creating channels for individual medication sounds.
    if (existingIds.has('dose-reminder')) {
      await LocalNotifications.deleteChannel({ id: 'dose-reminder' });
      console.info('[native] Migrated dose-reminder channel to dose-reminder-v2');
    }

    for (const ch of channels) {
      if (!existingIds.has(ch.id)) {
        await LocalNotifications.createChannel(ch);
        console.info(
          `[native] Notification channel created: ${ch.id} (${ch.name})`
        );
      }
    }
  } catch (err) {
    console.warn('[native] Notification channel creation failed:', err);
  }

  try {
    notificationActionHandle = await LocalNotifications.addListener(
      'localNotificationActionPerformed',
      (event: { actionId: string; notification?: { extra?: { medicationId?: string } } }) => {
        const medicationId = event.notification?.extra?.medicationId;
        if (medicationId && notificationActionHandler) {
          notificationActionHandler(event.actionId, medicationId);
        }
      }
    );
  } catch (err) {
    console.warn('[native] localNotificationActionPerformed listener failed:', err);
  }

  // ─────────────────────────────────────────────────────────────
  // Foreground notification listener — keeps the native notification and
  // opens the in-app DoseAlarmModal for dose reminders. The native channel
  // is the single sound source in every app state.
  // ─────────────────────────────────────────────────────────────
  // The v6 plugin cannot resolve an IndexedDB/data-URL sound after the app
  // process is killed. The bundled channel tone is therefore the reliable
  // fallback for foreground, background, and killed delivery.
  // #38: await the addListener and store the handle so it can be
  // removed if needed (prevents duplicate listeners across HMR).
  try {
    notificationHandle = await LocalNotifications.addListener(
      'localNotificationReceived',
      (notification: {
        extra?: {
          medicationId?: string;
        };
      }) => {
        // Keep the native notification in addition to the in-app modal.
        const medicationId = notification?.extra?.medicationId;
        if (medicationId && doseReceivedHandler) {
          try {
            doseReceivedHandler(medicationId);
          } catch (err) {
            console.warn('[native] doseReceivedHandler failed:', err);
          }
        }
      }
    );
  } catch (err) {
    console.warn('[native] localNotificationReceived listener failed:', err);
  }
}

/**
 * #38: remove all Capacitor listeners added by initNativeBridge.
 * Called by App.tsx on unmount (or HMR) so duplicate listeners don't
 * accumulate across re-initializations. Safe to call even if the
 * handles are null (web platform, or init failed).
 */
export async function cleanupNativeListeners(): Promise<void> {
  try {
    if (backPressHandle) await backPressHandle.remove();
  } catch (err) {
    console.warn('[native] backPressHandle.remove() failed:', err);
  }
  try {
    if (notificationHandle) await notificationHandle.remove();
  } catch (err) {
    console.warn('[native] notificationHandle.remove() failed:', err);
  }
  try {
    if (notificationActionHandle) await notificationActionHandle.remove();
  } catch (err) {
    console.warn('[native] notificationActionHandle.remove() failed:', err);
  }
  try {
    if (appStateHandle) await appStateHandle.remove();
  } catch (err) {
    console.warn('[native] appStateHandle.remove() failed:', err);
  }
  backPressHandle = null;
  notificationHandle = null;
  notificationActionHandle = null;
  notificationActionHandler = null;
  doseReceivedHandler = null;
  appStateHandle = null;
  appResumeHandler = null;
}

/**
 * Open the OS-level app settings page where the user can toggle
 * notification permissions for the app.
 *
 * - **Android**: opens the Android "App info" screen for this app
 *   (Settings → Apps → Drug Tracker → Notifications), where the user
 *   can toggle notifications on.
 *
 * - **iOS**: opens the iOS Settings app at this app's notification
 *   permissions page (Settings → Drug Tracker → Notifications).
 *
 * - **Web**: returns false; the caller should fall back to
 *   openBrowserNotificationSettings() instead — there's no portable
 *   web URL that opens browser notification settings across all
 *   browsers.
 *
 * Implementation note: We use `App.openAppSettings()` via a cast to
 * `any` because the @capacitor/app 6.x TypeScript definitions
 * don't expose this method, but the underlying Android Java plugin
 * implements it. The runtime call works on Android 5.1+ and iOS
 * 10.0+.
 *
 * Returns:
 *   - true on Android / iOS when settings opened successfully
 *   - false on web OR if the Capacitor App plugin failed to open
 */
export async function openAppSettings(): Promise<boolean> {
  if (typeof Capacitor === 'undefined' || Capacitor.getPlatform() === 'web') {
    // On web, the caller should use openBrowserNotificationSettings
    // from utils/notifications.ts instead. This function is a no-op
    // here so the caller can fall back to the browser implementation.
    return false;
  }

  try {
    // openAppSettings() is part of the App plugin's Android/iOS
    // implementation but not declared in @capacitor/app 6.x TS defs.
    // Cast to any to access the runtime method.
    await (App as unknown as { openAppSettings: () => Promise<void> }).openAppSettings();
    return true;
  } catch (err) {
    console.warn('[native] openAppSettings failed:', err);
    return false;
  }
}
