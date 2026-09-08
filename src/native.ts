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
 *   - Listen for the Android hardware back button and exit the app
 *     (the SPA's bottom-nav is the primary navigation, so back
 *     button should not navigate the WebView history).
 */

import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { App } from '@capacitor/app';

let initialized = false;

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

  try {
    App.addListener('backButton', () => {
      // Exit the app on back-button press — the SPA uses bottom-nav
      // for navigation, not a stack-based browser history.
      App.exitApp();
    });
  } catch (err) {
    console.warn('[native] backButton listener failed:', err);
  }
}

/**
 * Open the OS-level app settings page where the user can toggle
 * notification permissions for the app.
 *
 * - **Android**: opens the Android "App info" screen for this app
 *   (Settings → Apps → الننغنغ → Notifications), where the user
 *   can toggle notifications on.
 *
 * - **iOS**: opens the iOS Settings app at this app's notification
 *   permissions page (Settings → الننغنغ → Notifications).
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
