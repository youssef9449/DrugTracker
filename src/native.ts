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
 *   - Notification Runtime owns notification channels and Android notification
 *     delivery; this bridge only maps notification events to app handlers.
 *   - Listen for `appStateChange` to update the foreground/background
 *     state tracker (setAppInForeground) so dose reminders are scheduled
 *     on the correct channel, and to re-check exact-alarm permission
 *     when the app resumes.
 */

import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { App } from '@capacitor/app';
import {
  addNotificationActionPerformedListener,
  addNotificationReceivedListener,
} from './utils/notificationRuntime';
import { setAppInForeground } from './utils/notifications/doseReminderNotifications';

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
// otherwise accumulate).
let backPressHandle: { remove: () => Promise<void> } | null = null;
let notificationHandle: { remove: () => Promise<void> } | null = null;
let notificationActionHandle: { remove: () => Promise<void> } | null = null;
let notificationActionHandler: ((actionId: string, medicationId: string, doseId?: string) => void) | null = null;
// Dose-reminder "received" handler — called when a local notification
// fires while the app is in the foreground. App.tsx registers a handler
// that opens the DoseAlarmModal for the med whose reminder fired.
let doseReceivedHandler: ((medicationId: string, doseId?: string) => void) | null = null;

export function registerNotificationActionHandler(
  handler: ((actionId: string, medicationId: string, doseId?: string) => void) | null
) {
  notificationActionHandler = handler;
}

/**
 * Register the handler called when a dose-reminder notification fires
 * while the app is in the foreground. The handler receives the
 * medicationId (from the notification's `extra.medicationId` field) and
 * is responsible for opening the DoseAlarmModal + playing the in-app
 * chime. No Android notification sound is produced — the foreground
 * channel (dose-reminder-foreground-v1) is silent.
 *
 * Pass null to unregister (e.g. on App unmount / HMR).
 */
export function registerDoseReceivedHandler(
  handler: ((medicationId: string, doseId?: string) => void) | null
) {
  doseReceivedHandler = handler;
}

// App-state handler — called when the app transitions between
// foreground/background. App.tsx uses it to re-check exact-alarm
// permission on resume (the user may have granted/denied it in
// Android settings).
let appStateHandle: { remove: () => Promise<void> } | null = null;
let appResumeHandler: ((isActive: boolean) => void) | null = null;

export function registerAppResumeHandler(handler: ((isActive: boolean) => void) | null) {
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
  // App state listener — fires on foreground/background transitions.
  //
  // 1. Updates the foreground/background state tracker
  //    (setAppInForeground) so getDoseReminderChannelId() returns the
  //    correct channel for subsequent scheduling. This MUST happen
  //    before appResumeHandler so the scheduler sees the new state
  //    when it re-arms reminders.
  //
  // 2. Calls appResumeHandler (App.tsx) which bumps lifecycleTick →
  //    useDoseReminderScheduler re-schedules all pending dose reminders
  //    on the now-correct channel (silent foreground / sound background).
  //    Also re-checks exact-alarm permission on resume.
  // ─────────────────────────────────────────────────────────────
  try {
    appStateHandle = await App.addListener('appStateChange', ({ isActive }) => {
      setAppInForeground(isActive);
      if (appResumeHandler) {
        try {
          appResumeHandler(isActive);
        } catch (err) {
          console.warn('[native] appResumeHandler failed:', err);
        }
      }
    });
  } catch (err) {
    console.warn('[native] appStateChange listener failed:', err);
  }

  // Notification channels, posting/cancellation, and notification identity
  // are owned by NotificationRuntime. This bridge only maps the generic
  // notification events to the existing Dose Reminder handlers.

  try {
    notificationActionHandle = await addNotificationActionPerformedListener(
      (event) => {
        const namespace =
          typeof event.namespace === 'string' ? event.namespace : '';
        const identity =
          typeof event.identity === 'string' ? event.identity : '';
        const actionId =
          typeof event.actionId === 'string' ? event.actionId : '';

        if (namespace !== 'dose-reminder' || !actionId || !identity) return;

        const separator = identity.indexOf('::');
        if (separator <= 0) return;
        const medicationId = identity.slice(0, separator);
        const doseId = identity.slice(separator + 2);
        if (medicationId && doseId && notificationActionHandler) {
          notificationActionHandler(actionId, medicationId, doseId);
        }
      }
    );
  } catch (err) {
    console.warn('[native] NotificationRuntime action listener failed:', err);
  }

  try {
    notificationHandle = await addNotificationReceivedListener(
      (event) => {
        const namespace =
          typeof event.namespace === 'string' ? event.namespace : '';
        const identity =
          typeof event.identity === 'string' ? event.identity : '';

        if (namespace !== 'dose-reminder' || !identity) return;

        const separator = identity.indexOf('::');
        if (separator <= 0) return;
        const medicationId = identity.slice(0, separator);
        const doseId = identity.slice(separator + 2);
        if (medicationId && doseId && doseReceivedHandler) {
          try {
            doseReceivedHandler(medicationId, doseId);
          } catch (err) {
            console.warn('[native] doseReceivedHandler failed:', err);
          }
        }
      }
    );
  } catch (err) {
    console.warn('[native] NotificationRuntime received listener failed:', err);
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
