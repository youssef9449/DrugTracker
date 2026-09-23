/**
 * Capacitor native bridge initialization.
 *
 * Safe to import in any environment: if the Capacitor runtime is not
 * installed, native initialization is skipped on the web platform.
 *
 * Lifecycle state for back-button, app-state, and notification listeners
 * lives in focused modules so each native concern owns its registration,
 * callback state, and cleanup independently.
 */

import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { App } from '@capacitor/app';
import {
  initBackButtonListener,
  cleanupBackButtonListener,
  registerBackButtonHandler,
} from './utils/nativeBackButton';
import {
  initAppStateListener,
  cleanupAppStateListener,
  registerAppResumeHandler,
} from './utils/nativeAppState';
import {
  initNotificationListeners,
  cleanupNotificationListeners,
  registerNotificationActionHandler,
  registerDoseReceivedHandler,
} from './utils/nativeNotificationListeners';

export {
  registerBackButtonHandler,
  registerAppResumeHandler,
  registerNotificationActionHandler,
  registerDoseReceivedHandler,
};

let initialized = false;

export async function initNativeBridge(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const platform = Capacitor.getPlatform();
  if (platform === 'web') return;

  try {
    await StatusBar.setBackgroundColor({ color: '#0f766e' });
    await StatusBar.setStyle({ style: Style.Light });
  } catch (err) {
    console.warn('[native] StatusBar setup failed:', err);
  }

  await initBackButtonListener();
  await initAppStateListener();
  await initNotificationListeners();
}

export async function cleanupNativeListeners(): Promise<void> {
  await cleanupBackButtonListener();
  await cleanupNotificationListeners();
  await cleanupAppStateListener();
  initialized = false;
}

//**
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
